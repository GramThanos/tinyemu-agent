/*
 * Agent.js — the provider-independent agent loop.
 *
 * A provider owns its conversation history and wire format, and exposes:
 *   addUser(text)
 *   step({ onText, onThinking, onUsage, signal }) -> { toolCalls:[{id,name,input,error?}], stop }
 *       onUsage({ input, cacheWrite, cacheRead, output, thinking }) once per API
 *       response: `input` is uncached input, `output` includes any thinking, and
 *       `thinking` is null when the API doesn't count it apart.
 *       stop: 'end' | 'tool_use' | 'refusal' | 'max_tokens' | 'empty' | 'aborted';
 *       `detail` optionally explains it. 'empty' is a reply with no text and no
 *       tool calls, which the provider must leave out of its history, so that the
 *       same request can be sent again. A call with `error` is not run: the error
 *       is its result.
 *   addToolResults([{ id, content, isError }])
 *   setTools(defs)   replace the tool list (it changes with skills and settings)
 *   setSystem(text)  replace the system prompt (the user can edit it in Settings)
 *   fork({ system, tools })  a new, empty conversation with the same model, for
 *                    the Delegate tool's sub-agents and for compaction summaries
 *   transcript()     the history as [{ role: user|assistant|call|result, text, isError? }]
 *   resetHistory(text)  replace the history with one user message (a compaction)
 *   pendingCalls()   the calls of a last reply that have no results yet (a turn
 *                    the page reloaded under): [{ id, name, input }]
 *   contextWindow    the model's window in tokens, or null if unknown
 *   maxOutput        tokens a reply may take, kept free in the window (optional)
 */

'use strict';

import {
    COMPACT_PROMPT, compactedMessage, DEFAULT_CONTEXT_WINDOW, estimateTokens, isContextOverflow, renderTranscript,
} from './compaction.js';
import { pauses } from './pause.js';
import { ASK_TOOL, DELEGATE_TOOL, limitToolOutput } from './tools.js';

/* The built-in system prompt. {{VAR_ARCH}} and {{VAR_OS_NAME}} are filled in by
 * renderPrompt() with the running machine's processor and system, in the
 * built-in prompt and in a user's edited one alike. */
export const SYSTEM_PROMPT = `You are an agent named TinyEMU. You have access to a sandbox VM ({{VAR_ARCH}}, {{VAR_OS_NAME}}), a bit slow and without internet access (no need to install anything). You work under the \`/workspace\` folder. Feel free to delegate work to sub-agents and orchestrate them.`;

/**
 * Fill a prompt's {{VAR_NAME}} placeholders from vars ({ ARCH: 'x86', ... }).
 * A placeholder with no value is left as it is, so a typo stays visible.
 * @param {string} text
 * @param {Object<string,string>} vars
 */
export function renderPrompt(text, vars = {}) {
    return text.replace(/\{\{VAR_([A-Z0-9_]+)\}\}/g, (all, name) =>
        (typeof vars[name] === 'string' && vars[name] ? vars[name] : all));
}

/** A sub-agent's prompt: the agent's own (the default, or the user's edit) plus its role. */
export function subagentPrompt(system = SYSTEM_PROMPT) {
    return `${system}

You are a sub-agent: another agent gave you this task through its Delegate tool, and the user is not reading along. Do the task, then end with a report for that agent: what you did, what you found, the paths of anything you created or changed, and anything that failed or is left undone. Your final message is the only thing it receives, so put everything it needs there.`;
}

export const SUBAGENT_PROMPT = subagentPrompt();

export const MAX_STEPS = 100;
export const SUBAGENT_MAX_STEPS = 50;
export const EMPTY_RETRIES = 2;     // an empty reply is asked for again this many times
const EMPTY_RETRY_MS = 1000;
/* No tool result may take more than this share of the context window. */
const TOOL_OUTPUT_SHARE = 0.25;

/** The result of a call that never finished: the page reloaded under it. */
export const INTERRUPTED = 'Interrupted: the page was reloaded while this call ran, so it did not finish and its result '
    + 'is lost. It may have partly run; check its effects before relying on them.';

/* A number, or a function giving one when it is read (a setting). */
const valueOf = (v) => (typeof v === 'function' ? v() : v);

const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/* Waits before asking again after a network failure: 5 s twice, 10 s twice, then
 * 20 s for as long as it takes. A turn waits until the connection is back or the
 * user stops it; the count starts over once a request gets through. */
export const NETWORK_RETRY_MS = [5000, 5000, 10000, 10000, 20000];

/** The wait before network retry number `attempt` (0-based). */
export function networkRetryDelay(attempt, schedule = NETWORK_RETRY_MS) {
    return schedule[Math.min(attempt, schedule.length - 1)];
}

/* What browsers, Node and the SDKs say when a request never reached the server or
 * its connection broke: Chrome "Failed to fetch", Firefox "NetworkError ...",
 * Safari "Load failed", the Anthropic SDK "Connection error." and "Request timed
 * out.", Node's undici "fetch failed"/"terminated" and its socket codes. */
const NETWORK_MESSAGE = new RegExp([
    'failed to fetch', 'networkerror', 'network error', 'load failed', 'network connection was lost',
    'err_internet_disconnected', 'err_network', 'err_connection', 'err_name_not_resolved', 'connection error',
    'request timed out', 'fetch failed', '^terminated$', 'socket hang up', 'error in input stream',
    'econnreset', 'econnrefused', 'enotfound', 'etimedout', 'eai_again', 'enetunreach',
].join('|'), 'i');

/** Whether an error means the model couldn't be reached (no internet, a dropped connection). */
export function isNetworkError(e) {
    if (!e || isContextOverflow(e)) return false;
    // An HTTP status means the server answered: that is not this.
    if (Number.isInteger(e.status)) return false;
    if (globalThis.navigator?.onLine === false) return true;
    if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true;
    return [e, e.cause].some((x) => x && (NETWORK_MESSAGE.test(String(x.message ?? '')) || NETWORK_MESSAGE.test(String(x.code ?? ''))));
}

/* Sleep, but wake early when the browser says it is back online. */
const waitForNetwork = (ms, signal) => new Promise((resolve) => {
    let t;
    const done = () => {
        clearTimeout(t);
        globalThis.removeEventListener?.('online', done);
        signal?.removeEventListener('abort', done);
        resolve();
    };
    t = setTimeout(done, ms);
    globalThis.addEventListener?.('online', done);
    signal?.addEventListener('abort', done, { once: true });
});

/* At most `limit()` holders at once (0 or less: no limit); the rest wait in turn. */
function slots(limit) {
    let active = 0;
    let queue = [];
    const max = () => { const n = valueOf(limit); return Number.isInteger(n) && n > 0 ? n : Infinity; };
    const pump = () => { while (queue.length && active < max()) queue.shift().go(); };
    return {
        tryAcquire() {
            if (queue.length || active >= max()) return false;
            active++;
            return true;
        },
        acquire(signal) {
            return new Promise((resolve, reject) => {
                if (active < max()) { active++; resolve(); return; }
                const entry = {};
                const onAbort = () => { queue = queue.filter((e) => e !== entry); reject(new Error('Stopped by the user.')); };
                entry.go = () => { active++; signal?.removeEventListener('abort', onAbort); resolve(); };
                if (signal?.aborted) { reject(new Error('Stopped by the user.')); return; }
                signal?.addEventListener('abort', onAbort, { once: true });
                queue.push(entry);
            });
        },
        release() { active--; pump(); },
    };
}

/* Why a sub-agent is asked once more for its report, by how its turn stopped. */
const WRAP_UP = {
    max_tokens: 'Your last response was cut off: it hit the output limit.',
    max_steps: 'You have used all the steps you were given.',
    empty: 'Your last response was empty.',
    end: 'You stopped without writing a final message.',
};
const WRAP_UP_TRIES = 2;
const WRAP_UP_STEPS = 2;
const ERROR_RETRY_MS = 2000;
const wrapUpPrompt = (why) => `[${why} Stop working now and write your final report for the agent that gave you `
    + 'this task, without calling any more tools: what you did, what you found, the paths of what you created or '
    + 'changed, and what failed or is left undone. Keep it concise: it is all that agent receives.]';

/** Said to a sub-agent resumed after the page reloaded. */
export const RESUME_NOTE = '[The page was reloaded while you worked, and your work was interrupted. Any tool call '
    + 'that was running did not finish (its result says so); check its effects before relying on them. Carry on with '
    + 'your task from where you were.]';

/* Call every hook of `a`, then the same one of `b`. */
function chainHooks(a, b) {
    if (!b) return a;
    const out = { ...b };
    for (const [k, fn] of Object.entries(a)) {
        out[k] = b[k] ? (...args) => { fn(...args); b[k](...args); } : fn;
    }
    return out;
}

/**
 * The Delegate tool's runner, for createTools({ delegate }): forks the calling
 * agent's provider into a new conversation, runs the task with the caller's tools
 * less Delegate and ask_user (`tools` when the caller passes none) and resolves to
 * the sub-agent's final message: only that reaches the caller, never its steps.
 *
 * Each sub-agent gets its own shell (tools.forShell), so its `cd` and variables
 * don't move the caller's. Its progress goes to the call's onOutput; its usage to
 * `on.usage(u, kind, ctx)`, its compactions to `on.compacted(c, ctx)` and its tool
 * calls to `on.toolEnd(call, result, stats, ctx)` (ctx: the Delegate call's).
 * `context` is passed to its Agent, which compacts its context like any other,
 * keeping its task word for word; `log(entry, ctx)` gets its exchanges. `system`
 * is a prompt, or a function giving one when each sub-agent starts. `maxSteps`,
 * `maxConcurrent` (how many run at once; more wait for a turn) and
 * `toolOutputMax` are numbers or functions read when needed.
 *
 * A turn that ends without a report (cut off at the output limit, out of steps,
 * an empty reply) is asked for one, without tools, up to WRAP_UP_TRIES times; an
 * error is retried once. Only then does the call fail.
 *
 * `view(info)`, if given, is told about each sub-agent as it starts: info is
 * { name, description, prompt, parent (the caller's meta), callId, shell, resume }.
 * It may return { hooks (more Agent callbacks), meta, log(entry), attach(agent),
 * done(status, text) } with status 'done', 'failed' or 'stopped': the page shows
 * each sub-agent in a chat of its own with these.
 *
 * The returned function has `resume(input, ctx, state)`: carry on a sub-agent the
 * page was reloaded under, from state { provider (its history imported), name,
 * shell, view }. Calls left unanswered in that history get an "interrupted"
 * result, and it is told so (RESUME_NOTE).
 */
export function createDelegate({
    tools, system = SUBAGENT_PROMPT, maxSteps = SUBAGENT_MAX_STEPS, maxConcurrent = 0, on = {}, context = {}, log = null,
    emptyRetries = EMPTY_RETRIES, toolOutputMax = null, view = null, networkRetryMs = NETWORK_RETRY_MS,
}) {
    const running = slots(maxConcurrent);
    let count = 0;
    const run = async ({ prompt, description }, ctx = {}, resume = null) => {
        const { provider, signal, onOutput, agent: parent, callId, meta, tools: callerTools } = ctx;
        if (!resume && !provider?.fork) throw new Error('This model connection cannot start a sub-agent.');
        let lineStart = true;
        const out = (t) => { if (t) { lineStart = t.endsWith('\n'); onOutput?.(t); } };
        const line = (t) => out(`${lineStart ? '' : '\n'}${t}\n`);

        if (!running.tryAcquire()) {
            line('… waiting: as many sub-agents as Settings allow are running');
            await running.acquire(signal);
        }
        let v = {};
        let status = 'failed';
        let final = '';
        try {
            const n = ++count;
            const name = resume?.name ?? `sub-agent ${n}`;
            const subSystem = typeof system === 'function' ? system() : system;
            // The caller's tools, so the shell starts where the caller's is.
            const base = callerTools?.without ? callerTools.without(DELEGATE_TOOL, ASK_TOOL) : tools;
            const shell = resume?.shell ?? `sub-agent-${n}`;
            const subTools = base.forShell ? base.forShell(shell) : base;
            const subProvider = resume?.provider ?? provider.fork({ system: subSystem, tools: subTools.defs });
            v = view?.({
                name, description, prompt, parent: meta ?? null, callId: callId ?? null, shell, resume: resume?.view ?? null,
            }) || {};
            let report = '';   // the text of the latest step: after its last tool call, the report
            let earlier = '';  // the last step's text that wasn't empty, if asking for a report fails
            const own = {
                stepStart() { if (report.trim()) earlier = report; report = ''; if (!lineStart) out('\n'); },
                text(t) { report += t; out(t); },
                toolStart(call) { line(`▸ ${call.name} ${toolArg(call)}`); },
                toolEnd(call, result, stats) {
                    if (result.isError) line(`  ✗ ${call.name}: ${result.content.split('\n')[0].slice(0, 200)}`);
                    on.toolEnd?.(call, result, stats, ctx);
                },
                usage: (u, kind) => on.usage?.(u, kind, ctx),
                retrying(why) { line(`  ↻ ${why}`); },
                compacted(c) {
                    line(`⟲ compacted the context: ${c.before.toLocaleString()} → ~${c.after.toLocaleString()} tokens`);
                    on.compacted?.(c, ctx);
                },
                compactFailed(e) { line(`  ✗ compaction failed: ${e.message}`); },
            };
            const sub = new Agent({
                name,
                provider: subProvider,
                tools: subTools,
                maxSteps,
                emptyRetries,
                context,
                task: prompt,
                meta: v.meta ?? null,
                toolOutputMax,
                networkRetryMs,
                log: (entry) => { log?.(entry, ctx); try { v.log?.(entry); } catch { /* never stops it */ } },
                on: chainHooks(own, v.hooks),
            });
            v.attach?.(sub);
            if (!resume) {
                sub._log('start', { parent: parent ?? null, callId: callId ?? null, description, system: subSystem, tools: subTools.defs.map((d) => d.name), shell });
            } else {
                sub._log('start', { resumed: true, parent: parent ?? null, callId: callId ?? null, description });
            }

            // An error is asked again once, from where the history stands.
            const attempt = async (work) => {
                try {
                    return await work();
                } catch (e) {
                    if (signal?.aborted) return { stop: 'aborted' };
                    line(`  ✗ ${String(e.message).split('\n')[0].slice(0, 200)}; asking again`);
                    await sleep(ERROR_RETRY_MS, signal);
                    if (signal?.aborted) return { stop: 'aborted' };
                    try { return await sub.retry(signal); } catch (e2) { return { stop: 'error', detail: e2.message }; }
                }
            };
            const start = () => {
                if (!resume) return sub.send(prompt, signal);
                // It may have finished just before the reload: its last word is the report.
                const last = subProvider.transcript?.().at(-1);
                if (!subProvider.pendingCalls?.().length && last?.role === 'assistant' && last.text?.trim()) {
                    report = last.text;
                    return { stop: 'end' };
                }
                // Its own cut-off calls are not run again: they come back "interrupted".
                return sub.resumePending(signal, () => null, RESUME_NOTE);
            };
            let r = await attempt(start);
            for (let tries = 0; tries < WRAP_UP_TRIES && !signal?.aborted; tries++) {
                const why = WRAP_UP[r.stop];
                if (!why || (r.stop === 'end' && report.trim())) break;
                line(`  ↻ asking for its final report: ${why}`);
                const steps = sub.maxSteps;
                sub.maxSteps = WRAP_UP_STEPS;
                try { r = await attempt(() => sub.send(wrapUpPrompt(why), signal)); } finally { sub.maxSteps = steps; }
            }
            if (r.stop === 'aborted' || signal?.aborted) { status = 'stopped'; throw new Error('Stopped by the user.'); }
            const text = report.trim() || (r.stop !== 'end' ? earlier.trim() : '');
            if (r.stop !== 'end') {
                const why = r.detail || r.stop;
                if (!text) throw new Error(`The sub-agent stopped without a report: ${why}`);
                final = `${text}\n\n[The sub-agent stopped early: ${why}]`;
            } else {
                final = text || '(The sub-agent finished without writing a report.)';
            }
            status = 'done';
            return final;
        } catch (e) {
            final = e.message;
            throw e;
        } finally {
            running.release();
            try { v.done?.(status, final); } catch { /* the page's view never fails the call */ }
        }
    };
    const delegate = (input, ctx) => run(input, ctx);
    delegate.resume = (input, ctx, state) => run(input, ctx, state);
    return delegate;
}

/* The argument that identifies a call best, for one-line progress. */
export const TOOL_ARG = {
    Read: 'path', Edit: 'path', Write: 'path', Glob: 'pattern', Grep: 'pattern', Bash: 'command', skill: 'name', Delegate: 'description',
};

/** That argument's text; for ask_user, its first question. */
export function toolArgText(call) {
    const input = call?.input || {};
    if (call?.name === ASK_TOOL) {
        const q = Array.isArray(input.questions) ? input.questions[0]?.question : input.question;
        const more = Array.isArray(input.questions) && input.questions.length > 1 ? ` (+${input.questions.length - 1} more)` : '';
        return `${String(q ?? '')}${more}`;
    }
    return String(input[TOOL_ARG[call?.name]] ?? '');
}

function toolArg(call) {
    const v = toolArgText(call);
    const line = v.split('\n')[0];
    return line.length > 120 || v.includes('\n') ? `${line.slice(0, 120)}…` : line;
}

/* A message the user sent while the agent worked, as the model gets it. */
const interjection = (text) => `[The user sent this while you were working:]\n${text}`;

export class Agent {
    /**
     * @param {object} opts
     * @param {object} opts.provider  see above
     * @param {object} opts.tools     from createTools()
     * @param {object} [opts.on]      UI callbacks: text, thinking, stepStart,
     *                                toolStart(call), toolOutput(call, text),
     *                                toolEnd(call, result, { ms }), usage(u, kind)
     *                                with kind 'compaction' for a summary's own
     *                                request, context(info), compactStart(reason),
     *                                compacted(c), compactFailed(error),
     *                                retrying(why), injected(item)
     * @param {number|() => number} [opts.maxSteps]  steps per turn, read at each step
     * @param {object} [opts.context] functions read at each check: auto() whether
     *                                to compact by itself, threshold() the share of
     *                                the window that triggers it, limit(provider)
     *                                the window in tokens
     * @param {() => string} [opts.system]  the system prompt, read at each message;
     *                                a change goes to the provider (setSystem). Leave
     *                                it out to keep the provider's own.
     * @param {string} [opts.name]    who this is, in the log ('main', 'sub-agent 2')
     * @param {(entry:object) => void} [opts.log]  every exchange, as plain JSON:
     *                                { agent, type, ... } with type user, response,
     *                                tool, compaction or error
     * @param {number|() => number} [opts.emptyRetries]  how often an empty reply is asked for again
     * @param {*} [opts.meta]        passed to every tool call as ctx.meta
     * @param {string} [opts.task]    a sub-agent's task, repeated after each compaction
     * @param {number|() => number} [opts.toolOutputMax]  characters of one tool result the
     *                                model gets (also capped at a quarter of the window)
     * @param {number[]} [opts.networkRetryMs]  waits between asks while the model can't be
     *                                reached; the last one repeats (NETWORK_RETRY_MS)
     */
    constructor({
        provider, tools, on = {}, maxSteps = MAX_STEPS, context = {}, system = null, name = 'main', log = null,
        emptyRetries = EMPTY_RETRIES, meta = null, task = null, toolOutputMax = null, networkRetryMs = NETWORK_RETRY_MS,
    }) {
        this.networkRetryMs = networkRetryMs;   // waits after network failures (tests shorten them)
        this.provider = provider;
        this.tools = tools;
        this.on = on;
        this.maxSteps = maxSteps;
        this.name = name;
        this.log = log;
        this.emptyRetries = emptyRetries;
        this.meta = meta;           // handed to tools in ctx.meta (the page: which chat)
        this.task = task;           // a sub-agent's task, kept through compactions
        this.toolOutputMax = toolOutputMax;
        this.calls = new Map();     // running tool calls: id -> AbortController
        this._defsKey = null;   // the tool list the provider last got
        this.system = system;
        this._system = provider.system ?? null;   // the prompt the provider has
        this.context = {
            auto: () => true,
            threshold: () => 0.8,
            limit: (p) => p.contextWindow || DEFAULT_CONTEXT_WINDOW,
            ...context,
        };
        // Tokens in the context at the last response: what was sent plus the reply,
        // which goes back with the next request. After a compaction, an estimate
        // until the next response says.
        this.used = 0;
        this.estimated = false;
        this.compactions = 0;
        this.lastCompaction = null;
        // Messages the user sent during a turn, given to the model at its next step.
        this.pending = [];
        this._pendingSeq = 0;
    }

    _log(type, data) {
        try { this.log?.({ agent: this.name, type, ...data }); } catch { /* the log never stops the agent */ }
    }

    /** Queue a message for the turn in progress. @returns {number} its id, for unqueue */
    queue(text) {
        const item = { id: ++this._pendingSeq, text };
        this.pending.push(item);
        return item.id;
    }

    /** Take a queued message back, if the model hasn't had it yet. */
    unqueue(id) {
        const before = this.pending.length;
        this.pending = this.pending.filter((p) => p.id !== id);
        return this.pending.length !== before;
    }

    /** Every queued message, removed from the queue (a turn ended without them). */
    takePending() {
        const items = this.pending;
        this.pending = [];
        return items;
    }

    /* Give the model what the user sent meanwhile: one user message. */
    _inject(midTurn) {
        if (!this.pending.length) return false;
        const items = this.takePending();
        const text = items.map((p) => p.text).join('\n\n');
        this.provider.addUser(midTurn ? interjection(text) : text);
        this._log('user', { text, injected: true });
        for (const item of items) this.on.injected?.(item);
        return true;
    }

    /** What the context meter shows. */
    contextInfo() {
        const limit = this.context.limit(this.provider);
        return {
            used: this.used,
            estimated: this.estimated,
            limit,
            trigger: this._trigger(limit),
            compactions: this.compactions,
            last: this.lastCompaction,
        };
    }

    /* Compact at threshold() of the window less the reply's room, which has to fit too. */
    _trigger(limit = this.context.limit(this.provider)) {
        const room = Math.min(this.provider.maxOutput || 0, limit / 2);
        return Math.floor((limit - room) * this.context.threshold());
    }

    _noteUsage(u, kind) {
        this.on.usage?.(u, kind);
        if (kind === 'compaction') return;
        this.used = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
        this.estimated = false;
        if (this.lastCompaction && this.lastCompaction.measured === null) this.lastCompaction.measured = this.used;
        this.on.context?.(this.contextInfo());
    }

    /**
     * Replace the history with a summary of it, written by a fork of the same model.
     * @param {object} [o]
     * @param {AbortSignal} [o.signal]
     * @param {string} [o.reason]   'auto' | 'overflow' | 'manual', for the counters
     * @param {boolean} [o.midTurn] the agent was in the middle of a task
     * @returns {Promise<object|null>} what was done, or null if there was nothing to do
     */
    async compact({ signal, reason = 'manual', midTurn = false } = {}) {
        const { provider, on } = this;
        if (!provider.transcript || !provider.resetHistory || !provider.fork) {
            throw new Error('This model connection cannot compact its context.');
        }
        const entries = provider.transcript();
        if (!entries.length) return null;
        const limit = this.context.limit(provider);
        // The transcript has to fit the summarizer's own request, with room to answer.
        const text = renderTranscript(entries, Math.floor((limit - (provider.maxOutput || 0)) * 0.6 * 4));
        on.compactStart?.(reason);
        const writer = provider.fork({ system: COMPACT_PROMPT, tools: [] });
        writer.addUser(`${text}\n\n[End of the transcript. Write the summary now.]`);
        let summary = '';
        const step = await writer.step({
            onText: (t) => { summary += t; },
            onThinking: () => {},
            onUsage: (u) => this._noteUsage(u, 'compaction'),
            signal,
        });
        if (step.stop === 'aborted' || signal?.aborted) return { aborted: true };
        if (!summary.trim()) throw new Error(step.detail || `the summary came back empty (${step.stop})`);

        const message = compactedMessage(summary, midTurn, this.task);
        const before = this.used;
        provider.resetHistory(message);
        this.compactions++;
        // Every request also carries the system prompt and the tool definitions.
        this.used = estimateTokens(message) + estimateTokens(String(provider.system ?? ''))
            + estimateTokens(JSON.stringify(this.tools.defs ?? []));
        this.estimated = true;
        // measured: the real context size, filled in at the next response.
        this.lastCompaction = { reason, before, after: this.used, measured: null, at: Date.now(), summary: summary.trim() };
        this._log('compaction', { reason, before, after: this.used, summary: summary.trim() });
        on.compacted?.({ ...this.lastCompaction, count: this.compactions });
        on.context?.(this.contextInfo());
        return this.lastCompaction;
    }

    /* An automatic compaction; a failure is reported and the turn goes on without it. */
    async _autoCompact(signal, midTurn) {
        if (!this.context.auto() || this.used < this._trigger()) return;
        try {
            await this.compact({ signal, reason: 'auto', midTurn });
        } catch (e) {
            this.on.compactFailed?.(e);
        }
    }

    /* Hand the provider what changed since the last turn: tools and system prompt. */
    _prepare() {
        const { provider, tools } = this;
        // Skills and settings can change between turns, and with them the tools.
        const defsKey = JSON.stringify(tools.defs);
        if (defsKey !== this._defsKey) {
            provider.setTools?.(tools.defs);
            this._defsKey = defsKey;
        }
        // So can the system prompt.
        const system = this.system?.();
        if (system && system !== this._system) {
            provider.setSystem?.(system);
            this._system = system;
        }
    }

    /** Run one user turn to completion. @returns {Promise<{stop:string, detail?:string}>} */
    async send(text, signal) {
        this._prepare();
        await this._autoCompact(signal, false);
        if (signal?.aborted) return { stop: 'aborted' };
        this.provider.addUser(text);
        this._log('user', { text });
        return this._run(signal);
    }

    /**
     * Ask the model again from where the history stands, adding nothing: after an
     * empty reply, an error, or a stop. The history then ends with a user message or
     * tool results, so the request is a valid one.
     */
    async retry(signal) {
        this._prepare();
        if (signal?.aborted) return { stop: 'aborted' };
        this._log('user', { retry: true });
        return this._run(signal);
    }

    /* One model step, with empty replies asked for again. */
    async _step(signal, index) {
        const { provider, on } = this;
        for (let attempt = 0; ; attempt++) {
            const started = Date.now();
            let text = '';
            let thinking = '';
            let usage = null;
            const step = await provider.step({
                onText: (t) => { text += t; on.text?.(t); },
                onThinking: (t) => { thinking += t; on.thinking?.(t); },
                onUsage: (u) => { usage = u; this._noteUsage(u); },
                signal,
            });
            this._log('response', {
                step: index, stop: step.stop, detail: step.detail ?? null, text, thinking: thinking || undefined,
                toolCalls: step.toolCalls?.map((c) => ({ id: c.id, name: c.name, input: c.input, ...(c.error ? { error: c.error } : {}) })),
                usage, ms: Date.now() - started,
            });
            if (step.stop !== 'empty' || attempt >= valueOf(this.emptyRetries) || signal?.aborted) {
                return step.stop === 'empty'
                    ? { ...step, detail: step.detail || `The model returned an empty response${attempt ? ` ${attempt + 1} times` : ''}.` }
                    : step;
            }
            on.retrying?.('The model returned an empty response; asking again.');
            await sleep(EMPTY_RETRY_MS * (attempt + 1), signal);
            if (signal?.aborted) return { stop: 'aborted' };
            on.stepStart?.();
        }
    }

    /** Stop one running tool call; the turn goes on, and the model is told. */
    cancelTool(id) {
        const ctl = this.calls.get(id);
        if (!ctl || ctl.signal.aborted) return false;
        ctl.abort();
        return true;
    }

    /** Ids of the tool calls running now. */
    runningCalls() { return [...this.calls.keys()]; }

    /* The most of one tool result the model gets: the setting, and never more
     * than a quarter of the context window (about 4 characters a token). */
    _outputCap() {
        const set = valueOf(this.toolOutputMax);
        const byWindow = Math.floor(this.context.limit(this.provider) * 4 * TOOL_OUTPUT_SHARE);
        return Math.min(Number.isFinite(set) && set > 0 ? set : Infinity, byWindow > 0 ? byWindow : Infinity);
    }

    /*
     * One tool call, with its own stop: the turn's signal stops it too. `run`,
     * if given, does the work instead of the tools (a resumed sub-agent; one that
     * returns null gets the "interrupted" result).
     */
    async _runCall(call, signal, run = null) {
        const { tools, on, provider } = this;
        if (signal?.aborted) return { id: call.id, content: 'Stopped by the user.', isError: true };
        const ctl = new AbortController();
        const stop = () => ctl.abort();
        signal?.addEventListener('abort', stop, { once: true });
        this.calls.set(call.id, ctl);
        on.toolStart?.(call);
        const started = Date.now();
        let result;
        try {
            if (call.error) {
                result = { content: call.error, isError: true };
            } else {
                const ctx = {
                    signal: ctl.signal,
                    onOutput: (t) => on.toolOutput?.(call, t),
                    provider,   // Delegate forks it for a sub-agent
                    agent: this.name,
                    callId: call.id,
                    meta: this.meta,
                    tools,      // Delegate gives its sub-agent these, less itself
                };
                const work = run ? run(call, ctx) : tools.run(call.name, call.input, ctx);
                // A stopped call answers at once, even if its tool doesn't watch the signal.
                const stopped = new Promise((resolve) => {
                    if (ctl.signal.aborted) resolve(null);
                    ctl.signal.addEventListener('abort', () => resolve(null), { once: true });
                });
                result = await Promise.race([
                    Promise.resolve(work).then(
                        // A runner may answer with plain text, as Delegate's does.
                        (r) => (typeof r === 'string' ? { content: r, isError: false } : r),
                        (e) => ({ content: run ? e.message : `Tool failed: ${e.message}`, isError: true }),
                    ),
                    stopped,
                ]);
                result ??= ctl.signal.aborted ? { content: 'Stopped by the user.', isError: true } : { content: INTERRUPTED, isError: true };
            }
        } finally {
            signal?.removeEventListener('abort', stop);
            this.calls.delete(call.id);
        }
        let content = String(result.content ?? '');
        if (ctl.signal.aborted && !signal?.aborted) {
            content = `${content}${content ? '\n' : ''}[The user stopped this tool call; the rest of your work goes on. `
                + 'Don\'t simply run it again: consider why it was stopped.]';
        }
        result = { content: limitToolOutput(content, this._outputCap()), isError: !!result.isError || ctl.signal.aborted };
        const ms = Date.now() - started;
        this._log('tool', { id: call.id, name: call.name, input: call.input, content: result.content, isError: result.isError, ms });
        on.toolEnd?.(call, result, { ms });
        return { id: call.id, ...result };
    }

    /* All calls in a step run at once. They start in order, and a provider gets
     * one result per call, in order, even after a stop. Names are matched
     * loosely (bash → Bash), so the cards and the log show the tool that ran. */
    async _runCalls(calls, signal, run = null) {
        const resolved = calls.map((c) => ({ ...c, name: this.tools.resolve ? this.tools.resolve(c.name) : c.name }));
        return Promise.all(resolved.map((call) => this._runCall(call, signal, run)));
    }

    /**
     * Carry on a turn that was cut off (the page reloaded): the calls its history
     * left without results go to `run(call, ctx)`, which resolves to a result,
     * its text, or null for the "interrupted" result (with no `run`, the tools
     * run them again); `note` is added as a user message; then the model goes on.
     */
    async resumePending(signal, run = null, note = null) {
        this._prepare();
        const pending = this.provider.pendingCalls?.() ?? [];
        if (pending.length) this.provider.addToolResults(await this._runCalls(pending, signal, run));
        if (signal?.aborted) return { stop: 'aborted' };
        if (note) this.provider.addUser(note);
        this._log('user', { resumed: true, ...(note ? { text: note } : {}) });
        return this._run(signal);
    }

    /** Answer every call the history left open with `text`, without running anything. */
    closePending(text = INTERRUPTED) {
        const pending = this.provider.pendingCalls?.() ?? [];
        if (pending.length) this.provider.addToolResults(pending.map((c) => ({ id: c.id, content: text, isError: true })));
        return pending.length;
    }

    async _run(signal) {
        const { on } = this;
        let overflowRetried = false;
        let pauseRetried = false;
        let networkFails = 0;   // in a row: a request that gets through starts the count over
        for (let i = 0; i < valueOf(this.maxSteps); i++) {
            // A long turn can fill the context between its steps.
            if (i > 0) await this._autoCompact(signal, true);
            if (signal?.aborted) return { stop: 'aborted' };
            on.stepStart?.();
            const pausedBefore = pauses.total;
            let step;
            try {
                step = await this._step(signal, i);
                networkFails = 0;
            } catch (e) {
                if (signal?.aborted) return { stop: 'aborted' };
                // The browser stopped the page mid-request (a frozen tab, a sleeping
                // computer), and the connection didn't survive: ask once more.
                if (!pauseRetried && pauses.total > pausedBefore && !isContextOverflow(e)) {
                    pauseRetried = true;
                    on.retrying?.(`The page was paused while waiting for the model (${e.message}); asking again.`);
                    i--;
                    continue;
                }
                // No connection: wait and ask again, for as long as it takes. Nothing
                // of the failed request is in the history, so the same one goes out.
                if (isNetworkError(e)) {
                    const delayMs = networkRetryDelay(networkFails, this.networkRetryMs);
                    networkFails++;
                    this._log('error', { step: i, message: e.message, network: true, attempt: networkFails, retryInMs: delayMs });
                    const message = `Can't reach the model (${String(e.message).split('\n')[0].slice(0, 120)})`;
                    on.retrying?.(`${message}; trying again in ${Math.round(delayMs / 1000)} s.`,
                        { network: true, attempt: networkFails, delayMs, message });
                    await waitForNetwork(delayMs, signal);
                    if (signal?.aborted) return { stop: 'aborted' };
                    i--;
                    continue;
                }
                // The API said it doesn't fit: compact once and send it again.
                if (overflowRetried || !isContextOverflow(e)) {
                    this._log('error', { step: i, message: e.message });
                    throw e;
                }
                overflowRetried = true;
                const done = await this.compact({ signal, reason: 'overflow', midTurn: true });
                if (done?.aborted) return { stop: 'aborted' };
                if (!done) throw e;
                i--;
                continue;
            }
            if (step.stop !== 'tool_use') {
                // The model finished, but the user has said more meanwhile: go on.
                if (step.stop === 'end' && !signal?.aborted && this._inject(false)) continue;
                return step;
            }
            this.provider.addToolResults(await this._runCalls(step.toolCalls, signal));
            if (signal?.aborted) return { stop: 'aborted' };
            this._inject(true);
        }
        const max = valueOf(this.maxSteps);
        return { stop: 'max_steps', detail: `Stopped after ${max} steps.` };
    }
}
