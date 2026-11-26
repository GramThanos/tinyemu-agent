// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * agents.js — each chat's agent and its turns: making the agent from the chat's
 * model and environment, sending, messages sent during a turn, the agent's
 * questions (ask_user), sub-agents in read-only chats, and resuming the work a
 * reload cut off.
 */

'use strict';

import { Agent, createDelegate } from '../../js/Agent.js';
import { newChat, titleFrom } from '../../js/chats.js';
import { recordSubAgent } from '../../js/figures.js';
import { DELEGATE_TOOL, ToolError } from '../../js/tools.js';
import { emit } from './store.js';
import { chatById, mainChatOf, S, stampText, anyRunning } from './state.js';
import { contextOptions, keepAwake, settings } from './settings.js';
import { connections, pickLabel, pickOf, sameModel } from './models.js';
import { chatTools, currentSystem, envOf, projectOf, rt, skills, subSystem } from './world.js';
import { modeById, subPolicy } from './modes.js';
import { DEFAULT_MODE } from '../../js/modes.js';
import {
    addChatNote, addChatProblem, addMessage, dropWelcome, hideWaiting, inSession, logTopic, recordChat,
    saveChatSoon, sessionOf, setStat, subChatOf, touch, uiHooks,
} from './sessions.js';
import { addUsage, countTool, ensureChatShape, logExchange } from './stats.js';
import { choose, openSettings } from './dialogs.js';

/* The chat a tool call's ctx (or a sub-agent's) belongs to. */
const chatOfCtx = (ctx) => chatById(ctx?.meta?.chatId);
const mainOfCtx = (ctx) => mainChatOf(chatOfCtx(ctx));

/* Something about a chat's controls changed: running, its agent, its questions. */
export function changed() {
    keepAwake.set(anyRunning());
    emit('ui');
}

/* Sub-agents get their caller's tools less ask_user (Delegate only if the
 * sub-agent mode turns it on), the same settings, and a read-only chat of their
 * own (subView). Their usage, tool calls and compactions also count in the chat
 * the user started (mainChatOf), however deep they delegated. */
export const delegate = createDelegate({
    tools: null,   // always the caller's (ctx.tools)
    system: (ctx) => subSystem(chatOfCtx(ctx) || S.chat),
    context: contextOptions,
    maxSteps: () => settings.subMaxSteps,
    maxConcurrent: () => settings.subMaxConcurrent,
    emptyRetries: () => settings.emptyRetries,
    networkRetries: () => settings.networkRetries,
    toolOutputMax: () => settings.toolOutputMax,
    log: (entry, ctx) => logExchange(mainOfCtx(ctx), entry),
    on: {
        usage: (u, kind, ctx) => addUsage(mainOfCtx(ctx), 'sub', u, kind),
        compacted(c, ctx) {
            const p = mainOfCtx(ctx);
            if (!p) return;
            p.compactions.sub++;
            if (p === S.chat) emit('ui');
        },
        toolEnd: (call, result, stats, ctx) => countTool(mainOfCtx(ctx), call.name, stats.ms, result.isError),
    },
    view: (info) => subView(info),
    // Sub-agents work in the sub-agent mode, with its choice of tools.
    toolsFor: (tools) => tools.withPolicy(subPolicy()),
});

/* Each agent's to-do list (TodoWrite, TodoRead), kept on its chat's record: a
 * sub-agent's on its own chat. Shown above the message box (components/Todos). */
export const todos = {
    get: (ctx) => chatOfCtx(ctx)?.todos || [],
    set(ctx, list) {
        const c = chatOfCtx(ctx);
        if (!c) throw new Error('this agent has no chat to keep a list in');
        c.todos = list;
        saveChatSoon(c);
        if (c === S.chat || mainChatOf(c) === S.chat) emit('ui');
    },
};

/* ---- each chat's agent ---------------------------------------------------------- */

/* A chat's agent talks to its pick (pickOf) and runs its tools in its environment
 * (envOf), in a shell of its own. It is made when the chat opens or sends, and
 * again when the pick changes; a change of environment only swaps its tools. */
export function ensureAgent(s) {
    const c = s.chat;
    if (c.kind === 'sub' || s.running) return Promise.resolve(s.agent);
    const env = envOf(c);
    const pick = pickOf(c);
    if (s.agent && sameModel(s.pick, pick)) {
        if (s.env !== env) {
            s.agent.tools = chatTools(c);
            s.env?.leave(c.id);
            s.env = env;
        }
        env.join(c.id);
        return Promise.resolve(s.agent);
    }
    if (!pick) return Promise.resolve(s.agent);
    if (s.building && sameModel(s.building.pick, pick)) return s.building.promise;
    const building = { pick };
    s.building = building;
    emit('ui');
    building.promise = (async () => {
        try {
            const tools = chatTools(c);
            const provider = await connections.conversation(pick, { system: currentSystem(c), tools: tools.defs });
            if (s.building !== building || s.running) return s.agent;
            try { if (s.agent) c.history = s.agent.provider.exportHistory?.() ?? c.history; } catch { /* keep the last */ }
            buildAgent(s, provider, pickLabel(pick), { quiet: !c.events.length, keepPending: !S.resumeAsked && !!c.turn?.running });
            s.pick = pick;
            s.env?.leave(c.id);
            s.env = env;
            env.join(c.id);
            return s.agent;
        } catch (e) {
            if (s.building === building) inSession(s, () => addMessage('problem', `Could not load ${pickLabel(pick)}: ${e.message}`));
            return s.agent;
        } finally {
            if (s.building === building) s.building = null;
            S.loadingText = '';
            changed();
        }
    })();
    return building.promise;
}

/* A chat's agent, on `provider`. The chat's own conversation goes back into the
 * provider when that is the same kind (Claude, OpenAI-style, in-browser) that
 * wrote it: each keeps its history in its own format. Calls a reload left
 * without results are answered "interrupted", unless the chat waits to be asked
 * whether to resume (keepPending). */
export function buildAgent(s, provider, label, { quiet = false, keepPending = false } = {}) {
    const c = s.chat;
    const env = envOf(c);
    s.agent = new Agent({
        provider, tools: chatTools(c), on: uiHooks(s), context: contextOptions, system: () => currentSystem(c),
        maxSteps: () => settings.maxSteps, emptyRetries: () => settings.emptyRetries,
        networkRetries: () => settings.networkRetries, log: (e) => logExchange(c, e),
        meta: { chatId: c.id }, toolOutputMax: () => settings.toolOutputMax,
    });
    s.label = label;
    let how = 'This chat starts here.';
    let restored = false;
    if (c.history) {
        try {
            provider.importHistory(c.history);
            restored = true;
            if (provider.transcript?.().length ?? c.events.length) how = 'It carries on this chat.';
        } catch {
            how = `This chat's earlier messages were with ${c.model || 'another kind of model'}, which keeps them in `
                + 'another format, so this model starts without them.';
        }
    } else if (c.events.some((e) => e.k === 'user')) {
        how = 'This chat\'s earlier messages were not saved with it, so the model starts without them.';
    }
    if (restored && !keepPending) s.agent.closePending();
    c.model = label;
    logExchange(c, { agent: 'main', type: 'start', model: label, kind: provider.kind ?? null, system: currentSystem(c), tools: s.agent.tools.defs.map((d) => d.name) });
    if (!quiet) inSession(s, () => addMessage('note', `Connected to ${label}. ${how}`));
    changed();
    return restored;
}

/* A chat's model changed: its agent is made again on the next message, carrying on
 * the conversation when the new provider speaks the same format. */
export function setChatModel(c, pick) {
    if (sameModel(c.pick, pick) && S.sessions.get(c.id)?.agent) return;
    c.pick = pick;
    saveChatSoon(c, 0);
    const s = sessionOf(c);
    if (!s.running) ensureAgent(s);
    emit('ui');
}

/* A chat's mode changed: its prompt and its tools follow from the next request
 * (both are read at each send), in the same conversation. */
export function setChatMode(c, id) {
    if (c.kind === 'sub' || (c.mode || DEFAULT_MODE) === id || !modeById(id)) return;
    c.mode = id;
    saveChatSoon(c, 0);
    inSession(sessionOf(c), () => addChatNote('note', `This chat is now in ${modeById(id).name} mode, from your next message.`));
    emit('ui');
}

/* A chat moves to another environment: it joins the project's one of that kind,
 * which starts if no chat had it yet. The chat's next tool calls run there. */
export function setChatEnv(c, key) {
    if ((c.kind === 'sub' ? null : c.env) === key) return;
    c.env = key;
    saveChatSoon(c, 0);
    const s = sessionOf(c);
    const env = envOf(c);
    ensureAgent(s);
    env.join(c.id);
    env.warm();
    inSession(s, () => addChatNote('note', `This chat now works in ${env.label}${env.kind === 'vm' && env.status !== 'ready' ? ', which is starting' : ''}. `
        + 'The workspace is the same; shells start again in /workspace.'));
    emit('ui');
}

/* ---- sending, and messages sent during a turn ------------------------------ */

async function expandText(s, text) {
    const { text: expanded, used } = settings.mentions ? await skills.expandMentions(text) : { text, used: [] };
    if (used.length) inSession(s, () => addMessage('note', `Included the instructions of ${used.map((id) => `@${id}`).join(', ')}.`));
    return expanded;
}

/* Messages typed while the agent works, by queue id: each shows at the bottom of
 * the chat until the agent takes it, at its next step. */
function addQueued(s, id, text) {
    const sent = Date.now();
    s.queued.set(id, {
        id, text, sent,
        // Taken by the agent: it becomes an ordinary message, where the chat is now.
        deliver() {
            s.queued.delete(id);
            const now = Date.now();
            inSession(s, () => {
                setStat(addMessage('user', text), stampText(sent), `Sent ${new Date(sent).toLocaleString()}, while the agent worked; `
                    + `it took the message at ${new Date(now).toLocaleTimeString()}`);
                recordChat({ k: 'user', text, at: sent, took: now });
            });
        },
        remove() { s.queued.delete(id); touch(null, s); },
        cancel() {
            if (!s.agent?.unqueue(id)) return;
            s.queued.delete(id);
            if (!s.draft.trim()) s.draft = text;
            touch(null, s);
            emit('composer');
            changed();
        },
    });
    s.scrollToEnd = true;
    touch(null, s);
}

async function appendPrompt(s, text) {
    const expanded = await expandText(s, text);
    if (!s.running?.turn) { await startTurn(s, text, expanded); return; }   // the turn ended meanwhile
    addQueued(s, s.agent.queue(expanded), text);
}

/* Buttons for a turn that stopped short. Retrying sends the same request again;
 * it needs the history to end with a user message or tool results, which isn't
 * so after a reply that hit its limit or a refusal (those were kept). */
function stopActions(s, stop) {
    const a = s.agent;
    const ready = () => s.agent === a && !s.running;
    const actions = [];
    if (stop !== 'max_tokens' && stop !== 'refusal') {
        actions.push([stop === 'max_steps' ? 'Keep going' : 'Try again', () => { if (ready()) runTurn(s, (sig) => s.agent.retry(sig)); }]);
    }
    actions.push(['Send “continue”', () => { if (ready()) startTurn(s, 'continue', 'continue'); }]);
    return actions;
}

/* Run one turn of chat `s`. The chat records that a turn is running, so a reload
 * in the middle can offer to resume it (offerResume). */
export async function runTurn(s, work) {
    const c = s.chat;
    const ctl = s.running = new AbortController();
    ctl.turn = true;
    const started = Date.now();
    c.turn = { running: true, started };
    // While it runs, its environment isn't paused (nor swapped for another machine).
    const env = envOf(c);
    env.workStart(c.id);
    saveChatSoon(c, 0);
    changed();
    let aborted = false;
    try {
        const r = await work(ctl.signal);
        inSession(s, () => {
            if (r.stop === 'aborted') { aborted = true; addChatNote('note', 'Stopped.'); }
            else if (r.stop === 'empty') addChatProblem(`${r.detail} Ask again, or tell it to go on.`, stopActions(s, r.stop));
            else if (r.stop !== 'end') addChatProblem(r.detail || `Stopped: ${r.stop}`, stopActions(s, r.stop));
        });
    } catch (e) {
        inSession(s, () => addChatProblem(e.message, stopActions(s, 'error')));
    } finally {
        inSession(s, hideWaiting);
        aborted ||= ctl.signal.aborted;
        s.running = null;
        env.workEnd(c.id);
        c.turn = null;
        c.stats.turns++;
        c.stats.workMs += Date.now() - started;
        // Messages the agent didn't get to: after Stop they go back in the box,
        // otherwise they start the next turn.
        const left = s.agent?.takePending() ?? [];
        if (left.length) {
            const texts = left.map((p) => s.queued.get(p.id)?.text ?? p.text);
            if (aborted) {
                for (const p of left) s.queued.get(p.id)?.remove();
                s.draft = [texts.join('\n\n'), s.draft.trim()].filter(Boolean).join('\n\n');
                emit('composer');
                inSession(s, () => addMessage('note', 'The messages you sent while it worked are back in the box; send them when you are ready.'));
            } else {
                for (const p of left) s.queued.get(p.id)?.deliver();
                setTimeout(() => runTurn(s, (sig) => s.agent.send(left.map((p) => p.text).join('\n\n'), sig)));
            }
        }
        changed();
        saveChatSoon(c, 0);
    }
}

export async function startTurn(s, shown, expanded = null) {
    const sent = Date.now();
    inSession(s, () => {
        setStat(addMessage('user', shown), stampText(sent), `Sent ${new Date(sent).toLocaleString()}`);
        recordChat({ k: 'user', text: shown, at: sent });
    });
    s.scrollToEnd = true;   // what you sent, and the reply after it
    dropWelcome(s);
    nameChat(s.chat, shown);
    await runTurn(s, async (signal) => {
        // Skills can be imported or edited meanwhile, so look again before each turn.
        await skills.refresh().catch(() => {});
        await rt(projectOf(s.chat)).links.sync().catch(() => {});
        return s.agent.send(expanded ?? await expandText(s, shown), signal);
    });
}

/* The first message names the chat. */
function nameChat(c, text) {
    if (c.titled) return;
    c.title = titleFrom(text);
    c.titled = true;
    emit('ui');
}

/* The open chat's message box (its session's draft), sent: a new turn, or during
 * one a message queued for the agent's next step; with nothing typed during a
 * turn, Stop. */
const takeDraft = (s) => { s.draft = ''; emit('composer'); };
export async function sendPrompt() {
    const s = sessionOf(S.chat);
    const c = s.chat;
    const text = s.draft.trim();
    if (c.kind === 'sub') { s.running?.abort(); return; }
    if (s.running) {
        if (s.running.turn && text) { takeDraft(s); appendPrompt(s, text); return; }
        s.running.abort();
        return;
    }
    if (!text) return;
    if (!s.agent || !sameModel(s.pick, pickOf(c)) || s.env !== envOf(c)) await ensureAgent(s);
    if (!s.agent) {
        if (!pickOf(c)) openSettings('models');
        return;
    }
    if (s.running) return;   // a resumed turn started meanwhile
    takeDraft(s);
    await startTurn(s, text);
}

export async function compactNow() {
    const s = sessionOf(S.chat);
    if (!s.agent || s.running || s.chat.kind === 'sub') return;
    const ctl = s.running = new AbortController();
    changed();
    try {
        const done = await s.agent.compact({ signal: ctl.signal, reason: 'manual' });
        if (!done) inSession(s, () => addMessage('note', 'There is nothing to compact yet.'));
        else if (done.aborted) inSession(s, () => addMessage('note', 'Stopped.'));
    } catch (e) {
        inSession(s, () => addMessage('problem', `Could not compact the conversation: ${e.message}`));
    } finally {
        s.running = null;
        changed();
        saveChatSoon(s.chat, 0);
    }
}

/* ---- ask_user: the agent's questions, in place of the message box ------------ */

/* The call waits until the user answers or dismisses the questions, or the call
 * or turn is stopped. Questions of a chat that isn't open wait for it to be: its
 * row shows a "?". Several calls at once are asked one after another. */
let askSeq = 0;
export function askUser(questions, ctx) {
    const c = chatOfCtx(ctx) || S.chat;
    const s = sessionOf(c);
    return new Promise((resolve, reject) => {
        const item = { key: ++askSeq, questions, callId: ctx.callId };
        const done = () => {
            ctx.signal?.removeEventListener('abort', onAbort);
            s.asks = s.asks.filter((x) => x !== item);
            changed();
        };
        const onAbort = () => { done(); reject(new ToolError('Stopped by the user.')); };
        if (ctx.signal?.aborted) { reject(new ToolError('Stopped by the user.')); return; }
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        item.finish = (reply) => {
            done();
            // The answer shows as the user's message, and stays with the chat.
            const text = reply.declined ? 'Dismissed the agent\'s question without answering.'
                : questions.map((q) => {
                    const a = reply.answers[q.id];
                    const parts = [...a.picked, ...(a.text.trim() ? [a.text.trim()] : [])];
                    return questions.length > 1 ? `${q.header || q.question}: ${parts.join('; ')}` : parts.join('; ');
                }).join('\n');
            const at = Date.now();
            inSession(s, () => {
                setStat(addMessage('user', text), stampText(at), `Answered the agent's question ${new Date(at).toLocaleString()}`);
                recordChat({ k: 'user', text, at, answer: true });
            });
            resolve(reply);
        };
        s.asks.push(item);
        changed();
    });
}

/* ---- sub-agents: each in a read-only chat ------------------------------------ */

/* createDelegate's view: a chat for the sub-agent, after its parent's, that shows
 * its conversation as it happens (and keeps it, for a reload to resume). */
function subView(info) {
    const parent = chatById(info.parent?.chatId);
    let c = info.resume?.chatId ? chatById(info.resume.chatId) : null;
    if (!c) {
        c = ensureChatShape(newChat());
        Object.assign(c, {
            kind: 'sub', parent: parent?.id ?? null, callId: info.callId, title: info.description || info.name, titled: true,
            task: info.prompt, subName: info.name, shell: info.shell, model: parent?.model ?? null,
        });
        // After its parent and the parent's other sub-agents.
        const at = parent ? S.chats.lastIndexOf(S.chats.filter((x) => x === parent || x.parent === parent.id).at(-1)) + 1 : S.chats.length;
        S.chats.splice(at, 0, c);
    }
    c.status = 'running';
    const s = sessionOf(c);
    const ps = parent ? S.sessions.get(parent.id) : null;
    s.label = ps?.label || '';
    if (!info.resume) {
        s.drawn = true;   // a new chat: nothing saved to draw
        inSession(s, () => {
            const at = Date.now();
            setStat(addMessage('user', info.prompt), stampText(at), `The main agent's task for ${info.name}, ${new Date(at).toLocaleString()}`);
            recordChat({ k: 'user', text: info.prompt, at });
        });
    }
    // Its Stop stops the main agent's Delegate call, which stops it.
    s.running = { turn: false, sub: true, abort: () => ps?.agent?.cancelTool(info.callId) };
    const hooks = uiHooks(s);
    if (ps) emit(logTopic(ps.chat));   // its Delegate card links to it now
    changed();
    saveChatSoon(c, 0);
    const started = Date.now();
    return {
        hooks,
        meta: { chatId: c.id },
        log: (e) => logExchange(c, e),
        attach(agent) { s.agent = agent; if (c === S.chat) emit('ui'); },
        done(status, text) {
            s.running = null;
            c.status = status;
            const parentChat = chatById(c.parent);
            if (parentChat) recordSubAgent(parentChat.figs, status);
            c.stats.turns++;
            c.stats.workMs += Date.now() - started;
            inSession(s, () => {
                hideWaiting();
                if (status === 'done') addChatNote('note', 'Finished: its last message went to the main agent as its report.');
                else if (status === 'stopped') addChatNote('note', 'Stopped before it finished; the main agent was told.');
                else addChatNote('problem', `Failed: ${text}`);
            });
            changed();
            // Finished: deleted if Settings → Agent says so (failed or stopped ones stay).
            // chatOps imports this module, so it is loaded when used; not saved meanwhile,
            // or the save could put back a chat just deleted.
            if (status === 'done' && settings.subAutoDelete) {
                import('./chatOps.js')
                    .then(({ removeFinishedSub }) => { if (!removeFinishedSub(c)) saveChatSoon(c, 0); })
                    .catch(() => saveChatSoon(c, 0));
            } else saveChatSoon(c, 0);
        },
    };
}

/* ---- resuming work a reload cut off -------------------------------------------- */

/* A chat whose turn was running when the page went (c.turn), and the sub-agents
 * it had running, can carry on: once the page has loaded, it asks. On yes, each
 * chat gets its agent (its own model), each sub-agent resumes from its saved
 * conversation, its report goes to the main agent as the Delegate call's
 * result, the other calls it had running come back "interrupted", and the main
 * agent goes on. On no, the same calls are answered "interrupted" and the chat
 * waits for the user. */
const MAIN_RESUME_NOTE = '[The page was reloaded in the middle of your turn. Tool calls that were running did not '
    + 'finish (their results say so), except sub-agents, which carried on and reported. Continue where you left off.]';

export async function offerResume() {
    if (S.resumeAsked) return;
    const cut = S.chats.filter((c) => c.kind !== 'sub' && c.turn?.running && !S.sessions.get(c.id)?.running && pickOf(c));
    const stranded = (c) => S.chats.filter((x) => x.kind === 'sub' && x.parent === c.id && x.status === 'running');
    if (!cut.length) { S.resumeAsked = true; markSubsInterrupted(S.chats); closeCut(); return; }
    const names = cut.map((c) => {
        const n = stranded(c).length;
        return `“${c.title}”${n ? ` with ${n} sub-agent${n === 1 ? '' : 's'} running` : ''}`;
    });
    const choice = await choose('Carry on where the reload stopped?',
        `The page was reloaded while the agent was working in ${names.join(', ')}. Resume it? `
        + 'Sub-agents carry on from their saved conversations, and when they report, the main agent goes on. '
        + 'Commands that were running were cut off and are not run again; the agent is told.', [
            { value: 'resume', label: 'Resume', hint: 'Each chat with its own model and environment.' },
            { value: 'no', label: 'Leave it stopped', hint: 'Running calls are marked interrupted; send a message to go on.' },
        ]);
    S.resumeAsked = true;
    const resuming = new Set();   // sub-agent chats that carry on
    for (const c of cut) {
        const subs = choice === 'resume' ? await resumeChat(c) : null;
        if (subs) for (const id of subs) resuming.add(id);
        else abandonTurn(c);
    }
    markSubsInterrupted(S.chats.filter((x) => !resuming.has(x.id)));
    closeCut();
}

/* Chats whose turn was cut off but that can't be resumed (no model): their history
 * is closed when their agent is made, as for any other chat. */
function closeCut() {
    for (const c of S.chats) {
        if (c.kind === 'sub' || !c.turn?.running || S.sessions.get(c.id)?.running) continue;
        abandonTurn(c);
    }
}

/* Sub-agents left 'running' with nothing to carry them on. */
function markSubsInterrupted(list) {
    for (const x of list) {
        if (x.kind !== 'sub' || x.status !== 'running' || S.sessions.get(x.id)?.running) continue;
        x.status = 'interrupted';
        const parentChat = chatById(x.parent);
        if (parentChat) recordSubAgent(parentChat.figs, 'interrupted');
        const s = sessionOf(x);
        if (!s.drawn) uiHooks(s);   // draws what it had
        inSession(s, () => addChatNote('problem', 'Interrupted: the page reloaded while this sub-agent worked.'));
        saveChatSoon(x, 0);
    }
    emit('ui');
}

function abandonTurn(c) {
    const s = sessionOf(c);
    s.agent?.closePending();
    c.turn = null;
    saveChatSoon(c, 0);
}

/* Start the resumed turn. @returns {Promise<string[]|null>} the ids of the
 * sub-agent chats that will carry on, or null if the chat can't be resumed
 * (another kind of model wrote it, say). */
async function resumeChat(c) {
    c.figs.breaks.resumes++;
    const s = sessionOf(c);
    await ensureAgent(s);
    if (!s.agent || s.running) return null;
    const pending = s.agent.provider.pendingCalls?.() ?? [];
    if (!pending.length && !c.history) return null;
    const subs = pending
        .filter((call) => s.agent.tools.resolve(call.name) === DELEGATE_TOOL)
        .map((call) => subChatOf(c.id, call.id))
        .filter((x) => x?.history && s.agent.provider.fork);
    inSession(s, () => addChatNote('note', '↻ Resuming the turn the reload cut off.'));
    runTurn(s, (signal) => s.agent.resumePending(signal, (call, ctx) => resumeCall(c, call, ctx), MAIN_RESUME_NOTE));
    return subs.map((x) => x.id);
}

/* A call the reload cut off: a sub-agent carries on; anything else is "interrupted". */
function resumeCall(c, call, ctx) {
    if (call.name !== DELEGATE_TOOL) return null;
    const sub = subChatOf(c.id, call.id);
    const root = S.sessions.get(c.id)?.agent?.provider;
    if (!sub?.history || !root?.fork) return null;
    let provider;
    try {
        provider = root.fork({ system: subSystem(c), tools: [] });
        provider.kind = root.kind;
        provider.importHistory(sub.history);
    } catch {
        markSubsInterrupted([sub]);
        return null;
    }
    return delegate.resume(call.input, ctx, { provider, name: sub.subName, shell: sub.shell, view: { chatId: sub.id } });
}
