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
 *   fork({ system, tools })  a new, empty conversation with the same model, for
 *                    the Delegate tool's sub-agents
 */

'use strict';

export const SYSTEM_PROMPT = `You are an agent working inside a Linux virtual machine that runs in the user's web browser. You act on the VM through your tools.

The VM is a 32-bit x86 Linux (see /etc/os-release for the distribution), emulated in WebAssembly, so it is much slower than a real machine: prefer one targeted command to several broad ones. It has no network access. You are root, and you start in /workspace.

Work in /workspace. It is the user's folder: it is kept in their browser, survives page reloads, and they can see its files in a file browser next to the console. Changes anywhere else in the VM can be lost when the page reloads, so put anything the user should keep in /workspace. Everything you do stays inside this VM.

Tool calls in the same message run at the same time, so put independent work together and send anything that depends on an earlier result in a later message. Calls that read or change the same file through Read, Edit and Write keep their order. To keep working while a long command runs, use Bash with run_in_background.

Do the work with your tools rather than describing it, check that it worked, and then tell the user briefly what happened.`;

export const SUBAGENT_PROMPT = `${SYSTEM_PROMPT}

You are a sub-agent: another agent gave you this task through its Delegate tool, and the user is not reading along. Do the task, then end with a report for that agent: what you did, what you found, the paths of anything you created or changed, and anything that failed or is left undone. Your final message is the only thing it receives, so put everything it needs there.`;

const SUBAGENT_MAX_STEPS = 50;

/**
 * The Delegate tool's runner, for createTools({ delegate }): forks the calling
 * agent's provider into a new conversation, runs the task with `tools` (which
 * should leave Delegate out) and resolves to the sub-agent's final message.
 * Its progress goes to the call's onOutput; its usage to `on.usage`.
 */
export function createDelegate({ tools, system = SUBAGENT_PROMPT, maxSteps = SUBAGENT_MAX_STEPS, on = {} }) {
    return async ({ prompt }, { provider, signal, onOutput } = {}) => {
        if (!provider?.fork) throw new Error('This model connection cannot start a sub-agent.');
        let lineStart = true;
        const out = (t) => { if (t) { lineStart = t.endsWith('\n'); onOutput?.(t); } };
        const line = (t) => out(`${lineStart ? '' : '\n'}${t}\n`);
        let report = '';   // the text of the latest step: after its last tool call, the report
        const sub = new Agent({
            provider: provider.fork({ system, tools: tools.defs }),
            tools,
            maxSteps,
            on: {
                stepStart() { report = ''; if (!lineStart) out('\n'); },
                text(t) { report += t; out(t); },
                toolStart(call) { line(`▸ ${call.name} ${toolArg(call)}`); },
                toolEnd(call, result) { if (result.isError) line(`  ✗ ${call.name}: ${result.content.split('\n')[0].slice(0, 200)}`); },
                usage: (u) => on.usage?.(u),
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
     *                                toolEnd(call, result), usage(u)
     * @param {number} [opts.maxSteps]
     */
    constructor({ provider, tools, on = {}, maxSteps = 100 }) {
        this.provider = provider;
        this.tools = tools;
        this.on = on;
        this.maxSteps = maxSteps;
        this._defsKey = null;   // the tool list the provider last got
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
        provider.addUser(text);

        for (let i = 0; i < this.maxSteps; i++) {
            on.stepStart?.();
            const step = await provider.step({
                onText: (t) => on.text?.(t),
                onThinking: (t) => on.thinking?.(t),
                onUsage: (u) => on.usage?.(u),
                signal,
            });
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
