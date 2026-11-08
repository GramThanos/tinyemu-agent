/*
 * webllm.js — a model that runs entirely in the browser on WebGPU (WebLLM). No key
 * and no server; the weights download once and are cached by the browser.
 */

'use strict';

import { parseToolCalls, stripThinking, toolPrompt, VisibleTextFilter } from './toolProtocol.js';

const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.87';
const CONTEXT_WINDOW = 8192;
const MAX_RESULT_CHARS = 6000;   // small context: one tool result must not fill it

const MAX_TOKENS = 2048;

export const WEBLLM_MODELS = [
    { id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC', label: 'Hermes 3 3B (2.3 GB VRAM)' },
    { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen3 4B (3.4 GB VRAM)' },
    { id: 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC', label: 'Hermes 3 8B (4.9 GB VRAM)' },
    { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B (1.6 GB VRAM, weak with tools)' },
].map((m) => ({ ...m, contextWindow: CONTEXT_WINDOW }));

/* navigator.gpu can exist with no adapter behind it, e.g. on a blocklisted GPU. */
export async function hasWebGPU() {
    try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
}

export class WebLLMProvider {
    constructor({ model, system, tools, onProgress }) {
        this.model = model;
        this.onProgress = onProgress;
        this.system = system;
        this.toolDefs = tools;   // for rewriting the prompt when the system part changes
        this.messages = [{ role: 'system', content: toolPrompt(system, tools) }];
        this.engine = null;
        this._seq = 0;
        // The engine is loaded with this window, and a reply needs room in it too.
        this.contextWindow = CONTEXT_WINDOW;
        this.maxOutput = MAX_TOKENS;
    }

    /** The history as plain entries, for a compaction summary. Tool results come
     * back as user messages of <tool_response> blocks. */
    transcript() {
        return this.messages.slice(1).map((m) => (m.role === 'user' && m.content.startsWith('<tool_response')
            ? { role: 'result', text: m.content }
            : { role: m.role, text: m.content }));
    }

    /** Keep the system prompt; replace the rest with one user message. */
    resetHistory(text) { this.messages = [this.messages[0], { role: 'user', content: text }]; }

    /** The history less the system prompt, as plain JSON, for the page's log export. */
    exportHistory() { return { format: 'webllm', messages: structuredClone(this.messages.slice(1)) }; }

    /** Put back an exported history (the page's log import), under the current system prompt. */
    importHistory(h) {
        if (h?.format !== 'webllm' || !Array.isArray(h.messages)) throw new Error('that is not a conversation of this kind');
        this.messages = [this.messages[0], ...structuredClone(h.messages)];
    }

    /* The tools are described in the system prompt, so it is rewritten. */
    setTools(tools) {
        this.toolDefs = tools;
        this.messages[0] = { role: 'system', content: toolPrompt(this.system, tools) };
    }

    /* The tools are described in the same prompt, so both go in again. */
    setSystem(system) {
        this.system = system;
        this.messages[0] = { role: 'system', content: toolPrompt(system, this.toolDefs) };
    }

    async load() {
        if (!(await hasWebGPU())) throw new Error('No usable WebGPU adapter here, which in-browser models need.');
        const { CreateMLCEngine } = await import(WEBLLM_URL);
        this.engine = await CreateMLCEngine(
            this.model,
            { initProgressCallback: (p) => this.onProgress?.(p.text) },
            { context_window_size: CONTEXT_WINDOW },
        );
    }

    /** A new conversation on the same loaded engine, for a sub-agent: a second
     * engine would load the weights again. */
    fork({ system, tools }) {
        const p = new WebLLMProvider({ model: this.model, system, tools });
        p.engine = this.engine;
        return p;
    }

    addUser(text) { this.messages.push({ role: 'user', content: text }); }

    addToolResults(results) {
        const body = results.map((r) => {
            const content = r.content.length > MAX_RESULT_CHARS
                ? `${r.content.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
                : r.content;
            return `<tool_response${r.isError ? ' error="true"' : ''}>\n${content}\n</tool_response>`;
        }).join('\n');
        this.messages.push({ role: 'user', content: body });
    }

    /* An engine generates one reply at a time, and forks share it (parallel
     * sub-agents), so generations queue on the engine. */
    _exclusive(fn) {
        const engine = this.engine;
        const run = (engine._agentQueue || Promise.resolve()).then(fn);
        engine._agentQueue = run.catch(() => {});
        return run;
    }

    step(args) { return this._exclusive(() => this._step(args)); }

    async _step({ onText, onUsage, signal }) {
        if (signal?.aborted) return { stop: 'aborted' };
        const stream = await this.engine.chat.completions.create({
            messages: this.messages,
            stream: true,
            stream_options: { include_usage: true },
            temperature: 0.2,
            max_tokens: MAX_TOKENS,
        });

        const filter = new VisibleTextFilter(onText);
        let reply = '';
        let finish = null;
        for await (const chunk of stream) {
            if (signal?.aborted) { this.engine.interruptGenerate(); break; }
            if (chunk.usage) {
                onUsage?.({
                    input: chunk.usage.prompt_tokens || 0, cacheWrite: 0, cacheRead: 0,
                    output: chunk.usage.completion_tokens || 0, thinking: null,
                });
            }
            const choice = chunk.choices[0];
            const delta = choice?.delta?.content || '';
            reply += delta;
            filter.push(delta);
            finish = choice?.finish_reason || finish;
        }
        filter.end();

        const clean = stripThinking(reply).trim();
        if (signal?.aborted) { this.messages.push({ role: 'assistant', content: clean }); return { stop: 'aborted' }; }
        // Left out of the history, so the same request can go again.
        if (!clean && finish !== 'length') return { stop: 'empty', detail: 'The model returned an empty response.' };
        this.messages.push({ role: 'assistant', content: clean });

        const { calls } = parseToolCalls(clean);
        if (!calls.length) {
            return finish === 'length'
                ? { stop: 'max_tokens', detail: 'The response hit the length limit.' }
                : { stop: 'end' };
        }
        return {
            stop: 'tool_use',
            // A call that did not parse carries `error`, so the model sees the
            // problem in its next message and can write it again.
            toolCalls: calls.map((c) => ({
                id: `call_${++this._seq}`,
                name: c.name || 'invalid',
                input: c.input || {},
                error: c.error,
            })),
        };
    }
}
