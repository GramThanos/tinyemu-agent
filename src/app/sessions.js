// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * sessions.js — each chat's session while the page runs, and what its log shows.
 *
 * A session is what a chat has while the page runs: the items of its log (what
 * components/ChatLog draws), its agent, its turn in progress, messages queued
 * during it, questions waiting for an answer. Several chats can work at once; only
 * the open one is shown. The functions that add to a log (addMessage, addToolCard,
 * ...) add to `here()`: the open chat, or the session whose agent called a hook
 * (inSession). Every hook and every line after an await that adds something must
 * be inside inSession, or it lands in whatever chat is open.
 *
 * Chats are events, drawn as text (js/chats.js): the hooks record each thing they
 * add (recordChat) and drawChatEvent draws a saved one as the same item. Page
 * notes (VM boot, links, connecting) are items only, not kept.
 *
 * Items: { id, v, kind, ... } with kind
 *   msg         cls (user, assistant, note, problem), text, stat?, actions?
 *   thinking    text, stat?
 *   tool        call, output, isError, statText, statTitle, title, running, started, stopping, ev
 *   compaction  c, who
 *   welcome
 * `v` moves on with every change, so each item redraws alone.
 */

'use strict';

import { ChatStore, MAX_EXCHANGES, MemoryChatStore } from '../../js/chats.js';
import { DELEGATE_TOOL } from '../../js/tools.js';
import { emit } from './store.js';
import { formatSize, S, seconds, stampText } from './state.js';
import { settings } from './settings.js';
import { addUsage, countTool } from './stats.js';
import { projectOf } from './world.js';
import { files } from './files.js';
import { layout, panelShown } from './layout.js';

let seq = 0;
export const logTopic = (c) => `log:${c.id}`;

export function sessionOf(c) {
    let s = S.sessions.get(c.id);
    if (!s) {
        s = {
            chat: c, items: [], drawn: false,
            agent: null, label: '', pick: null, env: null, building: null,
            running: null,                     // AbortController of a turn (or compaction), or a sub-agent's stand-in
            waiting: null, queued: new Map(), cards: new Map(), asks: [], draft: '',
        };
        S.sessions.set(c.id, s);
    }
    return s;
}
export const ses = () => sessionOf(S.chat);
let drawTo = null;
export const here = () => drawTo || ses();
export function inSession(s, fn) {
    const prev = drawTo;
    drawTo = s;
    try { return fn(); } finally { drawTo = prev; }
}
export function dropSession(c) {
    const s = S.sessions.get(c.id);
    if (!s) return;
    clearInterval(s.waiting?.clock);
    S.sessions.delete(c.id);
    emit('ui');
}

/* ---- items ------------------------------------------------------------------ */

/** A session's log changed: redraw it (and the item, if one is given). */
export function touch(item, s = here()) {
    if (item) item.v++;
    emit(logTopic(s.chat));
}
function addItem(item) {
    const s = here();
    const it = { id: ++seq, v: 0, ...item };
    s.items.push(it);
    // ChatLog follows a new item only while the reader is at the end: one who
    // scrolled up to read stays put. Opening a chat and sending go to the end.
    touch(null, s);
    return it;
}

export const addMessage = (cls, text = '') => addItem({ kind: 'msg', cls, text });
export function setStat(item, text, title) { item.stat = { text, title }; touch(item); }
/* A problem with buttons under it: [label, onclick] pairs. A click runs one and removes them. */
export function addProblem(text, actions = []) {
    const it = addMessage('problem', text);
    if (actions.length) it.actions = actions;
    return it;
}
export function addWelcome(s) {
    if (!s.items.some((i) => i.kind === 'welcome')) inSession(s, () => addItem({ kind: 'welcome' }));
}
export function dropWelcome(s) {
    const n = s.items.length;
    s.items = s.items.filter((i) => i.kind !== 'welcome');
    if (s.items.length !== n) touch(null, s);
}

/* "Waiting for the model…", with a spinner and the seconds so far, from when a
 * request goes out until its first visible output (or its end). One per chat;
 * ChatLog draws it after the items. With `until` (a Date.now() time), it counts
 * down to it instead. */
export function showWaiting(text, { until = null } = {}) {
    const s = here();
    s.waiting = { text, until, started: Date.now() };
    touch(null, s);
}
export function setWaitingText(text) {
    const s = here();
    if (!s.waiting) return;
    s.waiting = { ...s.waiting, text };
    touch(null, s);
}
export function hideWaiting() {
    const s = here();
    if (!s.waiting) return;
    s.waiting = null;
    touch(null, s);
}

/* Tool cards start collapsed. Opening or closing one by hand makes that the way
 * new cards start, remembered in this browser. */
const CARDS_OPEN = 'tinyemu-agent-tool-cards-open';
export const cardsOpen = {
    KEY: CARDS_OPEN,
    get() { try { return localStorage.getItem(CARDS_OPEN) === '1'; } catch { return false; } },
    set(open) { try { localStorage.setItem(CARDS_OPEN, open ? '1' : '0'); } catch { /* not remembered */ } },
};

export const addToolCard = (call) => addItem({
    kind: 'tool', call, output: '', isError: false, statText: '', statTitle: '', title: '',
    running: true, started: Date.now(), stopping: false, ev: null,
});
/* A tool card's end state: its output, failure mark and stats line. */
export function finishToolCard(it, { output, isError, statText, statTitle }) {
    Object.assign(it, { output, isError: !!isError, statText: statText || '', statTitle: statTitle || '', running: false, stopping: false });
    touch(it);
}
/* A finished card's stats line: time, lines and size of what came back. */
export function toolStatText(result, ms) {
    const lines = result.content ? result.content.split('\n').length : 0;
    const bytes = new TextEncoder().encode(result.content || '').length;
    return `${seconds(ms)} · ${lines} line${lines === 1 ? '' : 's'} · ${formatSize(bytes)}`;
}
export const subChatOf = (parentId, callId) => S.chats.find((x) => x.kind === 'sub' && x.parent === parentId && x.callId === callId) || null;

export const addThinkingBox = (text = '') => addItem({ kind: 'thinking', text });
export const addCompactionCard = (c, who = 'the conversation') => addItem({ kind: 'compaction', c, who });

/* ---- the chat record: its events, saved ------------------------------------- */

export const chatStore = typeof indexedDB === 'undefined' ? new MemoryChatStore() : new ChatStore();

/* Add an event to the chat being drawn (see js/chats.js); returns it, to fill in later. */
export function recordChat(ev) {
    const c = here().chat;
    c.events.push(ev);
    chatChanged(c);
    return ev;
}
export function chatChanged(c = here().chat) {
    c.updated = Date.now();
    saveChatSoon(c);
}
/* A note or problem that belongs to the conversation, so it is kept with it. */
export function addChatNote(kind, text) {
    recordChat({ k: kind, text });
    return addMessage(kind, text);
}
export function addChatProblem(text, actions) {
    recordChat({ k: 'problem', text });
    return addProblem(text, actions);
}

/* Saves go at most every 2 s while text streams in, and at once at a turn's end. */
export const unsaved = new Set();
let saveTimer = null;
export function saveChatSoon(c = here().chat, ms = 2000) {
    if (!c) return;
    unsaved.add(c);
    if (saveTimer && ms) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushChats, ms);
}
export function cancelSaves() {
    clearTimeout(saveTimer);
    saveTimer = null;
    unsaved.clear();
}
export function flushChats() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const list = [...unsaved];
    unsaved.clear();
    return Promise.all(list.map((c) => saveChat(c)));
}
/* The provider's history goes with the chat, so a reload carries on from it. */
export async function saveChat(c = S.chat) {
    if (!c || !S.chats.includes(c)) return;
    const a = S.sessions.get(c.id)?.agent;
    if (a) { try { c.history = a.provider.exportHistory?.() ?? c.history; } catch { /* keep the last */ } }
    try {
        await chatStore.put({ ...c, exchanges: c.exchanges.slice(-MAX_EXCHANGES) });
    } catch (e) {
        console.warn('chats: could not save', e);
    }
}

/* Draw a saved chat's events, as the live hooks drew them. */
function drawChatEvent(ev) {
    const s = here();
    if (ev.k === 'user') {
        setStat(addMessage('user', ev.text), stampText(ev.at), ev.answer ? `Answered the agent's question ${new Date(ev.at).toLocaleString()}`
            : `Sent ${new Date(ev.at).toLocaleString()}`
            + (ev.took ? `, while the agent worked; it took the message at ${new Date(ev.took).toLocaleTimeString()}` : ''));
    } else if (ev.k === 'assistant') {
        const it = addMessage('assistant', ev.text);
        if (ev.stat) setStat(it, ev.stat.text, ev.stat.title);
    } else if (ev.k === 'thinking') {
        const it = addThinkingBox(ev.text);
        if (ev.stat) setStat(it, ev.stat.text, ev.stat.title);
    } else if (ev.k === 'tool') {
        const it = addToolCard(ev.call);
        it.ev = ev;
        it.title = ev.title || '';
        finishToolCard(it, ev.done ? ev : {
            output: ev.output || '', isError: true, statText: 'interrupted',
            statTitle: 'The page closed or reloaded while this ran; its result was never seen by the model',
        });
        if (ev.call?.id) s.cards.set(ev.call.id, it);   // a resumed turn brings it back
    } else if (ev.k === 'compaction') {
        addCompactionCard(ev.c, ev.who);
    } else if (ev.k === 'note' || ev.k === 'problem') {
        addMessage(ev.k, ev.text);
    }
}
export function drawSession(s) {
    s.drawn = true;
    inSession(s, () => { for (const ev of s.chat.events) drawChatEvent(ev); });
    s.scrollToEnd = true;
}

/* ---- the agent's callbacks for one chat's session --------------------------- */

const tokensPerSecond = (tokens, ms) => (ms > 0 ? tokens / (ms / 1000) : 0);

/* Everything they draw and record goes to that chat, open or not. */
export function uiHooks(s) {
    if (!s.drawn) drawSession(s);   // what the chat had comes first
    let textIt = null;
    let thinkIt = null;
    let textEv = null;         // the chat events (see js/chats.js) being written
    let thinkEv = null;
    let compacting = null;     // the "compacting…" note while a summary is written
    // One model reply (a step): when it was asked for, its first streamed token,
    // and where its stats go once the provider reports its usage.
    let step = null;
    const firstToken = () => { if (step && !step.first) step.first = Date.now(); };
    const hooks = {
        stepStart() {
            textIt = thinkIt = textEv = thinkEv = null;
            step = { start: Date.now(), first: 0, textIt: null, thinkIt: null, textEv: null, thinkEv: null, pending: null };
            showWaiting(`Waiting for ${s.label || 'the model'}…`);
        },
        text(t) {
            firstToken();
            hideWaiting();
            if (!textIt) {
                textIt = addMessage('assistant');
                textEv = recordChat({ k: 'assistant', text: '' });
                if (step) { step.textIt = textIt; step.textEv = textEv; }
            }
            textIt.text += t;
            textEv.text += t;
            touch(textIt);
            chatChanged();
        },
        thinking(t) {
            firstToken();
            // Hidden thinking (Settings) shows nothing, so keep the indicator, saying so.
            if (settings.thinking) hideWaiting();
            else setWaitingText(`${s.label || 'The model'} is thinking…`);
            if (!thinkIt) {
                thinkIt = addThinkingBox();
                thinkEv = recordChat({ k: 'thinking', text: '' });
                if (step) { step.thinkIt = thinkIt; step.thinkEv = thinkEv; }
            }
            thinkIt.text += t;
            thinkEv.text += t;
            touch(thinkIt);
            chatChanged();
        },
        toolStart(call) {
            hideWaiting();
            textIt = null;
            // A card the saved chat drew as interrupted comes back: its turn was resumed.
            let it = s.cards.get(call.id);
            if (it && !it.running && it.ev && !it.ev.done) {
                Object.assign(it, { isError: false, statText: '', statTitle: '', running: true, started: Date.now() });
                Object.assign(it.ev, { done: false, statText: '', statTitle: '' });
            } else {
                it = addToolCard(call);
                it.ev = recordChat({ k: 'tool', call, output: '', isError: false, statText: '', statTitle: '', title: '', done: false });
                s.cards.set(call.id, it);
            }
            // A reply with only tool calls: its stats go on the first card's tooltip.
            if (step?.pending) { it.title = it.ev.title = step.pending; step.pending = null; }
            touch(it);
        },
        toolOutput(call, t) {
            const it = s.cards.get(call.id);
            if (!it) return;
            it.output += t;
            touch(it);
        },
        toolEnd(call, result, stats = {}) {
            const it = s.cards.get(call.id);
            if (!it) return;
            // A sub-agent's progress stays above its report; other output is replaced.
            const output = call.name === DELEGATE_TOOL && it.output
                ? `${it.output}\n\n── ${result.isError ? 'failed' : 'report'} ──\n${result.content}`
                : result.content;
            const end = { output, isError: result.isError, statText: '', statTitle: '' };
            if (Number.isFinite(stats.ms)) {
                end.statText = toolStatText(result, stats.ms);
                end.statTitle = `Ran for ${stats.ms.toLocaleString()} ms${result.isError ? ', and failed' : ''}`;
                countTool(s.chat, call.name, stats.ms, result.isError);
            }
            finishToolCard(it, end);
            Object.assign(it.ev, end, { done: true });
            chatChanged();
            // The call may have changed /workspace: list it again if it is the project on screen.
            if (layout.tab === 'files' && panelShown() && projectOf(s.chat) === projectOf(S.chat)) files.refresh();
        },
        retrying(why, info) {
            if (!info?.network) { addChatNote('note', `↻ ${why}`); return; }
            // No connection: one note per outage, then a countdown to the next try.
            if (info.attempt === 1) addChatNote('note', `↻ ${info.message}; retrying until it is back.`);
            showWaiting(`No connection to the model; try ${info.attempt + 1} in {s} s…`, { until: Date.now() + info.delayMs });
        },
        injected(item) { s.queued.get(item.id)?.deliver(); },
        usage(u, kind) {
            addUsage(s.chat, 'main', u, kind);
            if (kind !== 'compaction') hideWaiting();
            if (kind === 'compaction' || !step) return;
            // Speed: output tokens (thinking included) over the time they streamed,
            // from the first token; the wait before it is shown apart. A reply that
            // came in one piece (no streaming) is timed over the whole request.
            const end = Date.now();
            const streamed = step.first && end - step.first >= 250;
            const genMs = end - (streamed ? step.first : step.start);
            const out = u.output || 0;
            const tps = tokensPerSecond(out, genMs);
            const text = `${stampText(end)} · ${out.toLocaleString()} tokens${tps ? ` · ${tps.toFixed(tps < 10 ? 1 : 0)} tok/s` : ''}`;
            const title = `Finished ${new Date(end).toLocaleString()}\n`
                + (step.first ? `First token after ${seconds(step.first - step.start)}, ` : '')
                + `${out.toLocaleString()} output tokens${Number.isInteger(u.thinking) ? ` (${u.thinking.toLocaleString()} thinking)` : ''} `
                + `in ${seconds(genMs)}: ${tps.toFixed(1)} tokens/s\n`
                + `Input ${(u.input || 0).toLocaleString()}, cache read ${(u.cacheRead || 0).toLocaleString()}, `
                + `cache write ${(u.cacheWrite || 0).toLocaleString()} tokens`;
            if (step.textIt) {
                setStat(step.textIt, text, title);
                step.textEv.stat = { text, title };
            } else if (step.thinkIt) {
                setStat(step.thinkIt, text, title);
                step.thinkEv.stat = { text, title };
            } else {
                step.pending = `${text}\n${title}`;
            }
            chatChanged();
        },
        context() { if (s.chat === S.chat) emit('ui'); },
        compactStart() {
            textIt = null;
            compacting = addMessage('note', '⟲ Compacting the conversation to free context…');
        },
        compacted(c) {
            removeItem(s, compacting);
            compacting = null;
            s.chat.compactions.main++;
            addCompactionCard(c);
            recordChat({ k: 'compaction', c, who: 'the conversation' });
            if (s.chat === S.chat) emit('ui');
        },
        compactFailed(e) {
            removeItem(s, compacting);
            compacting = null;
            addChatNote('problem', `Could not compact the conversation (${e.message}); carrying on without.`);
        },
    };
    for (const [k, fn] of Object.entries(hooks)) hooks[k] = (...args) => inSession(s, () => fn(...args));
    return hooks;
}

export function removeItem(s, it) {
    if (!it) return;
    s.items = s.items.filter((x) => x !== it);
    touch(null, s);
}
