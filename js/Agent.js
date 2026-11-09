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
 *   contextWindow    the model's window in tokens, or null if unknown
 *   maxOutput        tokens a reply may take, kept free in the window (optional)
 */

'use strict';

import {
    COMPACT_PROMPT, compactedMessage, DEFAULT_CONTEXT_WINDOW, estimateTokens, isContextOverflow, renderTranscript,
} from './compaction.js';

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

/* A number, or a function giving one when it is read (a setting). */
const valueOf = (v) => (typeof v === 'function' ? v() : v);

const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
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

/**
 * The Delegate tool's runner, for createTools({ delegate }): forks the calling
 * agent's provider into a new conversation, runs the task with `tools` (which
 * should leave Delegate out) and resolves to the sub-agent's final message.
 * Each sub-agent gets its own shell (tools.forShell), so its `cd` and variables
 * don't move the caller's. Its progress goes to the call's onOutput; its usage to
 * `on.usage(u, kind)`, its compactions to `on.compacted` and its tool calls to
 * `on.toolEnd(call, result, stats)`. `context` is passed to its Agent, and `log`
 * gets its exchanges (see Agent). `system` is a prompt, or a function giving one
 * when each sub-agent starts. `maxSteps` and `maxConcurrent` (how many run at
 * once; more wait for a turn) are numbers or functions read when needed.
 */
export function createDelegate({
    tools, system = SUBAGENT_PROMPT, maxSteps = SUBAGENT_MAX_STEPS, maxConcurrent = 0, on = {}, context = {}, log = null,
    emptyRetries = EMPTY_RETRIES,
}) {
    const running = slots(maxConcurrent);
    let count = 0;
    return async ({ prompt, description }, { provider, signal, onOutput, agent: parent, callId } = {}) => {
        if (!provider?.fork) throw new Error('This model connection cannot start a sub-agent.');
        let lineStart = true;
        const out = (t) => { if (t) { lineStart = t.endsWith('\n'); onOutput?.(t); } };
        const line = (t) => out(`${lineStart ? '' : '\n'}${t}\n`);

        if (!running.tryAcquire()) {
            line('… waiting: as many sub-agents as Settings allow are running');
            await running.acquire(signal);
        }
        try {
            const n = ++count;
            const name = `sub-agent ${n}`;
            const subSystem = typeof system === 'function' ? system() : system;
            const subTools = tools.forShell ? tools.forShell(`sub-agent-${n}`) : tools;
            let report = '';   // the text of the latest step: after its last tool call, the report
            const sub = new Agent({
                name,
                provider: provider.fork({ system: subSystem, tools: subTools.defs }),
                tools: subTools,
                maxSteps,
                emptyRetries,
                context,
                log,
                on: {
                    stepStart() { report = ''; if (!lineStart) out('\n'); },
                    text(t) { report += t; out(t); },
                    toolStart(call) { line(`▸ ${call.name} ${toolArg(call)}`); },
                    toolEnd(call, result, stats) {
                        if (result.isError) line(`  ✗ ${call.name}: ${result.content.split('\n')[0].slice(0, 200)}`);
                        on.toolEnd?.(call, result, stats);
                    },
                    usage: (u, kind) => on.usage?.(u, kind),
                    retrying(why) { line(`  ↻ ${why}`); },
                    compacted(c) {
                        line(`⟲ compacted the context: ${c.before.toLocaleString()} → ~${c.after.toLocaleString()} tokens`);
                        on.compacted?.(c);
                    },
                    compactFailed(e) { line(`  ✗ compaction failed: ${e.message}`); },
                },
            });
            log?.({ agent: name, type: 'start', parent: parent ?? null, callId: callId ?? null, description, system: subSystem, tools: subTools.defs.map((d) => d.name), shell: subTools.shell ?? null });
            const r = await sub.send(prompt, signal);
            if (r.stop === 'aborted') throw new Error('Stopped by the user.');
            const text = report.trim();
            if (r.stop !== 'end') {
                const why = r.detail || r.stop;
                if (!text) throw new Error(`The sub-agent stopped without a report: ${why}`);
                return `${text}\n\n[The sub-agent stopped early: ${why}]`;
            }
            return text || '(The sub-agent finished without writing a report.)';
        } finally {
            running.release();
        }
    };
}

/* The argument that identifies a call best, for one-line progress. */
export const TOOL_ARG = { Read: 'path', Edit: 'path', Write: 'path', Glob: 'pattern', Grep: 'pattern', Bash: 'command', skill: 'name', Delegate: 'description' };
function toolArg(call) {
    const v = String(call.input?.[TOOL_ARG[call.name]] ?? '');
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
     */
    constructor({
        provider, tools, on = {}, maxSteps = MAX_STEPS, context = {}, system = null, name = 'main', log = null,
        emptyRetries = EMPTY_RETRIES,
    }) {
        this.provider = provider;
        this.tools = tools;
        this.on = on;
        this.maxSteps = maxSteps;
        this.name = name;
        this.log = log;
        this.emptyRetries = emptyRetries;
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

        const message = compactedMessage(summary, midTurn);
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

    async _run(signal) {
        const { provider, tools, on } = this;
        let overflowRetried = false;
        for (let i = 0; i < valueOf(this.maxSteps); i++) {
            // A long turn can fill the context between its steps.
            if (i > 0) await this._autoCompact(signal, true);
            if (signal?.aborted) return { stop: 'aborted' };
            on.stepStart?.();
            let step;
            try {
                step = await this._step(signal, i);
            } catch (e) {
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

            // All calls in a step run at once. They start in order, and a provider
            // gets one result per call, in order, even after a stop.
            const results = await Promise.all(step.toolCalls.map(async (call) => {
                if (signal?.aborted) return { id: call.id, content: 'Stopped by the user.', isError: true };
                on.toolStart?.(call);
                const started = Date.now();
                const result = call.error
                    ? { content: call.error, isError: true }
                    : await tools.run(call.name, call.input, {
                        signal,
                        onOutput: (t) => on.toolOutput?.(call, t),
                        provider,   // Delegate forks it for a sub-agent
                        agent: this.name,
                        callId: call.id,
                    });
                const ms = Date.now() - started;
                this._log('tool', { id: call.id, name: call.name, input: call.input, content: result.content, isError: result.isError, ms });
                on.toolEnd?.(call, result, { ms });
                return { id: call.id, ...result };
            }));
            provider.addToolResults(results);
            if (signal?.aborted) return { stop: 'aborted' };
            this._inject(true);
        }
        const max = valueOf(this.maxSteps);
        return { stop: 'max_steps', detail: `Stopped after ${max} steps.` };
    }
}
