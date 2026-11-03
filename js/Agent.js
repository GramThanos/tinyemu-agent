/*
 * Agent.js — the provider-independent agent loop.
 *
 * A provider owns its conversation history and wire format, and exposes:
 *   addUser(text)
 *   step({ onText, onThinking, onUsage, signal }) -> { toolCalls:[{id,name,input,error?}], stop }
 *       onUsage({ input, cacheWrite, cacheRead, output, thinking }) once per API
 *       response: `input` is uncached input, `output` includes any thinking, and
 *       `thinking` is null when the API doesn't count it apart.
 *       stop: 'end' | 'tool_use' | 'refusal' | 'max_tokens' | 'aborted'; `detail` optionally
 *       explains it. A call with `error` is not run: the error is its result.
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

export const SYSTEM_PROMPT = `You are an agent working inside a Linux virtual machine that runs in the user's web browser. You act on the VM through your tools.

The VM is a 32-bit x86 Linux (see /etc/os-release for the distribution), emulated in WebAssembly, so it is much slower than a real machine: prefer one targeted command to several broad ones. It has no network access. You are root, and you start in /workspace.

Work in /workspace. It is the user's folder: it is kept in their browser, survives page reloads, and they can see its files in a file browser next to the console. Changes anywhere else in the VM can be lost when the page reloads, so put anything the user should keep in /workspace. Everything you do stays inside this VM.

Tool calls in the same message run at the same time, so put independent work together and send anything that depends on an earlier result in a later message. Calls that read or change the same file through Read, Edit and Write keep their order. To keep working while a long command runs, use Bash with run_in_background.

Do the work with your tools rather than describing it, check that it worked, and then tell the user briefly what happened.`;

/** A sub-agent's prompt: the agent's own (the default, or the user's edit) plus its role. */
export function subagentPrompt(system = SYSTEM_PROMPT) {
    return `${system}

You are a sub-agent: another agent gave you this task through its Delegate tool, and the user is not reading along. Do the task, then end with a report for that agent: what you did, what you found, the paths of anything you created or changed, and anything that failed or is left undone. Your final message is the only thing it receives, so put everything it needs there.`;
}

export const SUBAGENT_PROMPT = subagentPrompt();

const SUBAGENT_MAX_STEPS = 50;

/**
 * The Delegate tool's runner, for createTools({ delegate }): forks the calling
 * agent's provider into a new conversation, runs the task with `tools` (which
 * should leave Delegate out) and resolves to the sub-agent's final message.
 * Its progress goes to the call's onOutput; its usage to `on.usage(u, kind)` and
 * its compactions to `on.compacted`. `context` is passed to its Agent. `system`
 * is a prompt, or a function giving one when each sub-agent starts.
 */
export function createDelegate({ tools, system = SUBAGENT_PROMPT, maxSteps = SUBAGENT_MAX_STEPS, on = {}, context = {} }) {
    return async ({ prompt }, { provider, signal, onOutput } = {}) => {
        if (!provider?.fork) throw new Error('This model connection cannot start a sub-agent.');
        const subSystem = typeof system === 'function' ? system() : system;
        let lineStart = true;
        const out = (t) => { if (t) { lineStart = t.endsWith('\n'); onOutput?.(t); } };
        const line = (t) => out(`${lineStart ? '' : '\n'}${t}\n`);
        let report = '';   // the text of the latest step: after its last tool call, the report
        const sub = new Agent({
            provider: provider.fork({ system: subSystem, tools: tools.defs }),
            tools,
            maxSteps,
            context,
            on: {
                stepStart() { report = ''; if (!lineStart) out('\n'); },
                text(t) { report += t; out(t); },
                toolStart(call) { line(`▸ ${call.name} ${toolArg(call)}`); },
                toolEnd(call, result) { if (result.isError) line(`  ✗ ${call.name}: ${result.content.split('\n')[0].slice(0, 200)}`); },
                usage: (u, kind) => on.usage?.(u, kind),
                compacted(c) {
                    line(`⟲ compacted the context: ${c.before.toLocaleString()} → ~${c.after.toLocaleString()} tokens`);
                    on.compacted?.(c);
                },
                compactFailed(e) { line(`  ✗ compaction failed: ${e.message}`); },
            },
        });
        const r = await sub.send(prompt, signal);
        if (r.stop === 'aborted') throw new Error('Stopped by the user.');
        const text = report.trim();
        if (r.stop !== 'end') {
            const why = r.detail || r.stop;
            if (!text) throw new Error(`The sub-agent stopped without a report: ${why}`);
            return `${text}\n\n[The sub-agent stopped early: ${why}]`;
        }
        return text || '(The sub-agent finished without writing a report.)';
    };
}

/* The argument that identifies a call best, for one-line progress. */
export const TOOL_ARG = { Read: 'path', Edit: 'path', Write: 'path', Glob: 'pattern', Grep: 'pattern', Bash: 'command', skill: 'name', Delegate: 'description' };
function toolArg(call) {
    const v = String(call.input?.[TOOL_ARG[call.name]] ?? '');
    const line = v.split('\n')[0];
    return line.length > 120 || v.includes('\n') ? `${line.slice(0, 120)}…` : line;
}

export class Agent {
    /**
     * @param {object} opts
     * @param {object} opts.provider  see above
     * @param {object} opts.tools     from createTools()
     * @param {object} [opts.on]      UI callbacks: text, thinking, stepStart,
     *                                toolStart(call), toolOutput(call, text),
     *                                toolEnd(call, result), usage(u, kind) with kind
     *                                'compaction' for a summary's own request,
     *                                context(info), compactStart(reason),
     *                                compacted(c), compactFailed(error)
     * @param {number} [opts.maxSteps]
     * @param {object} [opts.context] functions read at each check: auto() whether
     *                                to compact by itself, threshold() the share of
     *                                the window that triggers it, limit(provider)
     *                                the window in tokens
     * @param {() => string} [opts.system]  the system prompt, read at each message;
     *                                a change goes to the provider (setSystem). Leave
     *                                it out to keep the provider's own.
     */
    constructor({ provider, tools, on = {}, maxSteps = 100, context = {}, system = null }) {
        this.provider = provider;
        this.tools = tools;
        this.on = on;
        this.maxSteps = maxSteps;
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

    /** Run one user turn to completion. @returns {Promise<{stop:string, detail?:string}>} */
    async send(text, signal) {
        const { provider, tools, on } = this;
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
        await this._autoCompact(signal, false);
        if (signal?.aborted) return { stop: 'aborted' };
        provider.addUser(text);

        let overflowRetried = false;
        for (let i = 0; i < this.maxSteps; i++) {
            // A long turn can fill the context between its steps.
            if (i > 0) await this._autoCompact(signal, true);
            if (signal?.aborted) return { stop: 'aborted' };
            on.stepStart?.();
            let step;
            try {
                step = await provider.step({
                    onText: (t) => on.text?.(t),
                    onThinking: (t) => on.thinking?.(t),
                    onUsage: (u) => this._noteUsage(u),
                    signal,
                });
            } catch (e) {
                // The API said it doesn't fit: compact once and send it again.
                if (overflowRetried || !isContextOverflow(e)) throw e;
                overflowRetried = true;
                const done = await this.compact({ signal, reason: 'overflow', midTurn: true });
                if (done?.aborted) return { stop: 'aborted' };
                if (!done) throw e;
                i--;
                continue;
            }
            if (step.stop !== 'tool_use') return step;

            // All calls in a step run at once. They start in order, and a provider
            // gets one result per call, in order, even after a stop.
            const results = await Promise.all(step.toolCalls.map(async (call) => {
                if (signal?.aborted) return { id: call.id, content: 'Stopped by the user.', isError: true };
                on.toolStart?.(call);
                const result = call.error
                    ? { content: call.error, isError: true }
                    : await tools.run(call.name, call.input, {
                        signal,
                        onOutput: (t) => on.toolOutput?.(call, t),
                        provider,   // Delegate forks it for a sub-agent
                    });
                on.toolEnd?.(call, result);
                return { id: call.id, ...result };
            }));
            provider.addToolResults(results);
            if (signal?.aborted) return { stop: 'aborted' };
        }
        return { stop: 'max_steps', detail: `Stopped after ${this.maxSteps} steps.` };
    }
}
