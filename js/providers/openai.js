// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * openai.js — any OpenAI-compatible chat completions API: OpenAI itself, Gemini's
 * compatibility endpoint, OpenRouter, Mistral, Groq, DeepSeek, xAI, ... or a server
 * of your own (llama.cpp, Ollama, LM Studio, vLLM). Called directly from the page
 * with the user's key, which stays in this page's memory and never reaches the guest.
 *
 * Plain fetch + server-sent events, so there is no SDK to load. The providers
 * differ in small ways the client copes with in one code path:
 *   - reasoning text comes back as delta.reasoning_content (DeepSeek, Moonshot,
 *     vLLM, llama.cpp), delta.reasoning (Groq, OpenRouter, Together, Ollama), or as
 *     `thinking` parts of delta.content (Mistral); OpenRouter adds
 *     reasoning_details. What came back is kept on the assistant message under the
 *     same names, because some must have it back (Moonshot's and DeepSeek's
 *     thinking models during tool calls, OpenRouter's encrypted reasoning);
 *   - Gemini puts a thought signature on a tool call (extra_content.google), which
 *     must go back on that call or Gemini 3 and later answer 400;
 *   - a streamed tool call may come without `index` (one complete call a chunk);
 *   - errors are { error: { message } }, [{ error }] (Gemini), { error: "..." }
 *     (xAI), { detail } (Mistral, DeepInfra) or { message } (Cerebras).
 */

'use strict';

import { parseRateLimits } from '../figures.js';

/* Providers offered by name. Every one of them must allow a page to call it
 * (CORS). `url` presets are servers on this computer: their URL is a
 * default the user can change, and they need no key. Anything else goes in as a
 * custom base URL. */
export const OPENAI_PRESETS = [
    { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
    { id: 'gemini', label: 'Gemini (Google AI Studio)', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    // OpenRouter asks apps to name themselves; the page's own origin, which the browser sends anyway.
    { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
        headers: () => ({ 'HTTP-Referer': globalThis.location?.origin || 'https://gramthanos.github.io/tinyemu-agent/', 'X-Title': 'TinyEMU Agent' }) },
    { id: 'mistral', label: 'Mistral', baseURL: 'https://api.mistral.ai/v1' },
    { id: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1' },
    { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com' },
    { id: 'xai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1' },
    { id: 'moonshot', label: 'Moonshot (Kimi)', baseURL: 'https://api.moonshot.ai/v1' },
    { id: 'together', label: 'Together AI', baseURL: 'https://api.together.ai/v1' },
    { id: 'fireworks', label: 'Fireworks', baseURL: 'https://api.fireworks.ai/inference/v1' },
    { id: 'cerebras', label: 'Cerebras', baseURL: 'https://api.cerebras.ai/v1' },
    { id: 'deepinfra', label: 'DeepInfra', baseURL: 'https://api.deepinfra.com/v1/openai' },
    { id: 'huggingface', label: 'Hugging Face (Inference Providers)', baseURL: 'https://router.huggingface.co/v1' },
    // Local servers, at their default addresses (the user can change them). Each
    // must allow this page's origin (CORS); `cors` says how, for the hint shown
    // when a listing can't reach it. A key only where the server asks for one.
    { id: 'ollama', label: 'Ollama', url: 'http://localhost:11434/v1',
        cors: 'start Ollama with OLLAMA_ORIGINS set to this page\'s address (or *)' },
    { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234/v1',
        cors: 'start LM Studio\'s server with "Enable CORS" on (Developer → Server settings)' },
    { id: 'openwebui', label: 'Open WebUI', url: 'http://localhost:3000/api',
        cors: 'give it an API key from Settings → Account, and set CORS_ALLOW_ORIGIN to this page\'s address' },
    { id: 'llamacpp', label: 'llama.cpp server', url: 'http://localhost:8080/v1',
        cors: 'start llama-server (it allows other origins by default; add --api-key only if you also give it here)' },
    { id: 'vllm', label: 'vLLM', url: 'http://localhost:8000/v1',
        cors: 'start vllm serve with --allowed-origins \'["*"]\' (and a port other than this page\'s)' },
    { id: 'localai', label: 'LocalAI', url: 'http://localhost:8080/v1',
        cors: 'start LocalAI with CORS=true' },
    { id: 'jan', label: 'Jan', url: 'http://localhost:1337/v1',
        cors: 'start Jan\'s local API server with CORS on (Settings → Local API Server)' },
    { id: 'koboldcpp', label: 'KoboldCpp', url: 'http://localhost:5001/v1',
        cors: 'start KoboldCpp (it allows other origins by default)' },
    { id: 'textgen', label: 'text-generation-webui', url: 'http://localhost:5000/v1',
        cors: 'start it with --api (and --listen-host if it runs on another computer)' },
    { id: 'gpt4all', label: 'GPT4All', url: 'http://localhost:4891/v1',
        cors: 'turn on "Enable Local API Server" in its settings' },
];

const MAX_RETRIES = 4;   // for rate limits (429) and overload (502-504)
const RETRY_STATUS = new Set([429, 502, 503, 504]);

/* Listed models that can't hold a chat: embeddings, speech, images, video, ... */
const NOT_CHAT = /embed|tts|whisper|transcri|audio|speech|image|imagen|veo|dall-e|sora|moderation|lyria|aqa|live|realtime|robotics|search-preview/i;

const headers = (apiKey, extra = {}) => ({
    'content-type': 'application/json',
    ...extra,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});

/* The API's own message from an error body: { error: { message } }, an array of
 * those (Gemini), { error: "..." } (xAI), { detail } (Mistral, DeepInfra; a string
 * or a list of { msg }), or { message }. */
export function errorMessage(status, text) {
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const e = Array.isArray(body) ? body[0] : body;
    const detail = Array.isArray(e?.detail) ? e.detail.map((d) => d?.msg || JSON.stringify(d)).join('; ') : e?.detail;
    const pick = [e?.error?.message, typeof e?.error === 'string' ? e.error : null, typeof detail === 'string' ? detail : null, e?.message]
        .find((x) => typeof x === 'string' && x.trim());
    const message = pick || text.trim().slice(0, 300);
    return `API error ${status}${message ? `: ${message}` : ''}`;
}

/** An Error for an HTTP error answer, with its status: an answer from the server is
 * never taken for a network failure (isNetworkError in Agent.js). */
export function apiError(status, text) {
    return Object.assign(new Error(errorMessage(status, text)), { status });
}

const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/* Retry-After in seconds, else 2, 4, 8, 16 s. */
function retryDelayMs(response, attempt) {
    const secs = parseFloat(response.headers.get('retry-after'));
    return Number.isFinite(secs) ? Math.min(secs * 1000, 60000) : 2000 * 2 ** attempt;
}

/* /models has no standard field for the context window; servers that report it
 * use one of these (OpenRouter, LM Studio, vLLM, llama.cpp, others). */
function contextWindowOf(m) {
    const n = m.context_length ?? m.context_window ?? m.max_context_length ?? m.max_model_len
        ?? m.top_provider?.context_length ?? m.meta?.n_ctx ?? m.meta?.n_ctx_train
        // Hugging Face's router: per serving provider.
        ?? (Array.isArray(m.providers) ? Math.max(0, ...m.providers.map((p) => p?.context_length).filter(Number.isInteger)) || null : null);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** The chat models a provider lists, as [{ id, label, contextWindow }], sorted by id. */
export async function listOpenAIModels({ baseURL, apiKey, signal, extraHeaders = {} }) {
    const r = await fetch(`${baseURL}/models`, { headers: headers(apiKey, extraHeaders), signal });
    const text = await r.text();
    if (!r.ok) throw apiError(r.status, text);
    const data = JSON.parse(text).data || [];
    return data
        // Gemini lists "models/gemini-...", and takes the name without the prefix.
        .map((m) => ({ id: String(m.id).replace(/^models\//, ''), label: m.display_name || m.name, contextWindow: contextWindowOf(m) }))
        .filter((m) => !NOT_CHAT.test(m.id))
        .map((m) => ({ ...m, label: m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/* Parse a text/event-stream body, yielding each `data:` payload. */
async function* sse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        const { done, value } = await reader.read();
        buf += decoder.decode(value || new Uint8Array(), { stream: !done });
        let m;
        while ((m = /\r?\n\r?\n/.exec(buf))) {
            const event = buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trimStart()).join('\n');
            if (data) yield data;
        }
        if (done) return;
    }
}

/* Fold one streamed tool-call delta into the call being built. Strings in
 * `function` arrive in pieces; every other field is kept as sent, because some
 * APIs put data there that must go back unchanged (Gemini's thought signatures
 * ride in extra_content).
 *
 * Some servers send the whole name with every delta, others in pieces. A piece
 * that repeats the name so far is a repeat only when that name is already a whole
 * tool's (`known`): otherwise "a" + "a" would stay "a". */
export function mergeCall(call, delta, known = null) {
    for (const [k, v] of Object.entries(delta)) {
        if (k === 'index') continue;
        if (k === 'function') {
            call.function ||= { name: '', arguments: '' };
            const name = call.function.name;
            const repeat = !!name && (v.name === name ? !known || known.has(name) : false);
            if (v.name && !repeat) {
                // The whole name sent again after a first piece of it: take it as is.
                call.function.name = name && v.name.startsWith(name) && known?.has(v.name) ? v.name : name + v.name;
            }
            if (v.arguments) call.function.arguments += v.arguments;
        } else if (v !== null && v !== undefined && v !== '') {
            call[k] = v;
        }
    }
}

/* Which call a streamed tool-call delta belongs to. With `index`, that one.
 * Without (one complete call a chunk, as some servers send), a delta that names a
 * function or brings a new id starts a call; anything else (a thought signature,
 * more arguments) belongs to the last one. */
export function callIndex(calls, tc) {
    if (Number.isInteger(tc.index)) return tc.index;
    const last = calls.length - 1;
    const fresh = last < 0 || !!tc.function?.name || (tc.id && calls[last]?.id && tc.id !== calls[last].id);
    return fresh ? calls.length : last;
}

/* OpenRouter's reasoning_details arrive in pieces, each with an index: text and
 * summaries add up, the other fields (signature, data, format, type) are kept. */
export function mergeDetails(into, pieces) {
    for (const p of pieces) {
        if (!p || typeof p !== 'object') continue;
        const i = Number.isInteger(p.index) ? into.findIndex((x) => x.index === p.index) : -1;
        if (i < 0) { into.push({ ...p }); continue; }
        const d = into[i];
        for (const [k, v] of Object.entries(p)) {
            if ((k === 'text' || k === 'summary') && typeof v === 'string') d[k] = (d[k] || '') + v;
            else if (v !== null && v !== undefined) d[k] = v;
        }
    }
    return into;
}

/* The text of Mistral's thinking: a string, or a list of { type: 'text', text }. */
const partsText = (t) => (typeof t === 'string' ? t : Array.isArray(t) ? t.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('') : '');

/* The page's usage shape from an OpenAI-style one. prompt_tokens counts cached
 * tokens too, so they are taken out of `input`; reasoning is part of the output. */
export function openAIUsage(u) {
    // Cache hits: OpenAI's field, else Together's flat one, else DeepSeek's.
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
    const reasoning = u.completion_tokens_details?.reasoning_tokens;
    return {
        input: Math.max(0, (u.prompt_tokens || 0) - cached),
        cacheWrite: 0,
        cacheRead: cached,
        output: u.completion_tokens || 0,
        thinking: Number.isInteger(reasoning) ? reasoning : null,
    };
}

/* reasoning_effort, which most of these APIs take (OpenAI, Gemini, Mistral, Groq,
 * DeepSeek, xAI, Moonshot, Cerebras, Ollama); '' sends none, leaving it to the
 * model, and to servers that don't know the field. Which levels a model accepts
 * is its own: OpenAI's newer models reject 'none', Gemini 2.5 Pro and later
 * can't turn thinking off, 'xhigh' only exists on a few. A level a model refuses
 * comes back as the API's error. */
export const OPENAI_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export class OpenAICompatProvider {
    constructor({ apiKey, baseURL, model, system, tools, effort = '', contextWindow = null, extraHeaders = {} }) {
        this.apiKey = apiKey;
        this.baseURL = baseURL;
        this.extraHeaders = extraHeaders;   // a preset's own (OpenRouter's app name)
        this.tokenField = 'max_tokens';     // OpenAI's own API wants max_completion_tokens
        this.maxOutput = null;              // a reply's limit, sent only when set
        this.temperature = null;
        this.tuning = {};
        this.model = model;
        this.effort = effort;
        this.contextWindow = contextWindow;   // tokens, or null if /models didn't say
        this.system = system;
        this.setTools(tools);
        this.messages = [{ role: 'system', content: system }];
        this._seq = 0;
    }

    /** The system message leads the history; replace it. */
    setSystem(system) {
        this.system = system;
        this.messages[0] = { role: 'system', content: system };
    }

    setTools(tools) {
        this.tools = tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
    }

    withTuning(t) { this.setTuning(t); return this; }

    /* The model was picked from the provider's own list: nothing to load. */
    async load() {}

    /** Applies from the next request. */
    setEffort(effort) { this.effort = effort; }

    /**
     * The user's settings for this model (Settings → Models), from the next request:
     * { contextWindow, maxOutput, temperature, windowSet, tokenField }. Each null one
     * is left to the server (nothing sent) or, for the window, to the listing.
     */
    setTuning(t = {}) {
        this.tuning = { ...t };
        if (Number.isInteger(t.contextWindow)) this.contextWindow = t.contextWindow;
        this.maxOutput = Number.isInteger(t.maxOutput) ? t.maxOutput : null;
        this.temperature = Number.isFinite(t.temperature) ? t.temperature : null;
        if (t.tokenField) this.tokenField = t.tokenField;
    }

    /** A new conversation with the same model and server, for a sub-agent or a compaction. */
    fork({ system, tools }) {
        return new OpenAICompatProvider({
            apiKey: this.apiKey, baseURL: this.baseURL, model: this.model, system, tools, effort: this.effort,
            contextWindow: this.contextWindow, extraHeaders: this.extraHeaders,
        }).withTuning(this.tuning);
    }

    /** The history as plain entries, for a compaction summary. */
    transcript() {
        const out = [];
        for (const m of this.messages.slice(1)) {
            if (m.role === 'tool') { out.push({ role: 'result', text: String(m.content ?? '') }); continue; }
            if (typeof m.content === 'string' && m.content) out.push({ role: m.role, text: m.content });
            for (const c of m.tool_calls || []) out.push({ role: 'call', text: `${c.function?.name} ${c.function?.arguments || ''}` });
        }
        return out;
    }

    /** Keep the system prompt; replace the rest with one user message. */
    resetHistory(text) { this.messages = [this.messages[0], { role: 'user', content: text }]; }

    /** The history less the system prompt, as plain JSON, for the page's log export. */
    exportHistory() { return { format: 'openai', messages: structuredClone(this.messages.slice(1)) }; }

    /** Put back an exported history (the page's log import), under the current system prompt. */
    importHistory(h) {
        if (h?.format !== 'openai' || !Array.isArray(h.messages)) throw new Error('that is not a conversation of this kind');
        this.messages = [this.messages[0], ...structuredClone(h.messages)];
    }

    /** The last reply's tool calls that no `tool` message answers yet (the page reloaded mid-turn). */
    pendingCalls() {
        let i = this.messages.length - 1;
        while (i > 0 && this.messages[i].role === 'tool') i--;
        const m = this.messages[i];
        if (i < 1 || m.role !== 'assistant' || !m.tool_calls?.length) return [];
        const answered = new Set(this.messages.slice(i + 1).map((t) => t.tool_call_id));
        return m.tool_calls.filter((c) => !answered.has(c.id)).map((c) => {
            let input = {};
            try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* shown as it was */ }
            return { id: c.id, name: c.function?.name || '', input };
        });
    }

    addUser(text) { this.messages.push({ role: 'user', content: text }); }

    addToolResults(results) {
        for (const r of results) {
            this.messages.push({
                role: 'tool',
                tool_call_id: r.id,
                content: r.isError ? `Error: ${r.content}` : r.content,
            });
        }
    }

    async step({ onText, onThinking, onUsage, signal }) {
        const response = await this._request(signal);
        if (!response) return { stop: 'aborted' };
        const limits = parseRateLimits(response.headers);

        let text = '';
        let finish = null;
        let extra = {};
        let usage = null;
        const thought = { field: null, text: '' };   // reasoning, under the name the server used
        const details = [];                          // OpenRouter's reasoning_details
        const calls = [];
        const known = new Set(this.tools.map((t) => t.function.name));
        const think = (t) => { if (t) onThinking?.(t); };
        try {
            for await (const data of sse(response)) {
                if (data === '[DONE]') break;
                const chunk = JSON.parse(data);
                if (chunk.error) throw new Error(errorMessage(chunk.error.code || 'in stream', JSON.stringify(chunk)));
                // Asked for with include_usage: a last chunk, usually with no choices.
                // Some servers send usage on more than one chunk; the last one counts.
                if (chunk.usage) usage = chunk.usage;
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                const d = choice.delta || {};
                for (const field of ['reasoning_content', 'reasoning']) {
                    if (typeof d[field] !== 'string' || !d[field]) continue;
                    thought.field ||= field;
                    if (thought.field === field) { thought.text += d[field]; think(d[field]); }
                }
                if (Array.isArray(d.reasoning_details)) mergeDetails(details, d.reasoning_details);
                if (typeof d.content === 'string' && d.content) { text += d.content; onText(d.content); }
                // Mistral: content as parts, its thinking among them.
                if (Array.isArray(d.content)) {
                    for (const part of d.content) {
                        if (part?.type === 'text' && part.text) { text += part.text; onText(part.text); }
                        if (part?.type === 'thinking') think(partsText(part.thinking));
                    }
                }
                for (const tc of d.tool_calls || []) mergeCall(calls[callIndex(calls, tc)] ||= { type: 'function' }, tc, known);
                if (d.extra_content) extra = { extra_content: d.extra_content };
                if (choice.finish_reason) finish = choice.finish_reason;
            }
        } catch (e) {
            if (signal?.aborted) return { stop: 'aborted' };
            throw e;
        }
        if (usage) onUsage?.({ ...openAIUsage(usage), ...(limits ? { limits } : {}) });
        // What the server said it thought goes back with the message, under its own names.
        if (thought.field) extra[thought.field] = thought.text;
        if (details.length) extra.reasoning_details = details;

        const toolCalls = calls.filter(Boolean);
        if (finish === 'length') {
            if (toolCalls.length) return { stop: 'max_tokens', detail: 'The response hit the output limit in the middle of a tool call.' };
            this.messages.push({ role: 'assistant', content: text, ...extra });
            return { stop: 'max_tokens', detail: 'The response hit the output limit.' };
        }
        if (finish === 'content_filter') return { stop: 'refusal', detail: 'The provider filtered the response.' };
        // Nothing to keep: left out of the history, so the same request can go again.
        if (!text && !toolCalls.length) return { stop: 'empty', detail: 'The model returned an empty response.' };

        for (const c of toolCalls) c.id ||= `call_${++this._seq}`;
        this.messages.push({
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            ...extra,
        });
        if (!toolCalls.length) return { stop: 'end' };

        return {
            stop: 'tool_use',
            toolCalls: toolCalls.map((c) => {
                const name = c.function?.name || '';
                const raw = c.function?.arguments || '';
                try {
                    const input = raw.trim() ? JSON.parse(raw) : {};
                    return { id: c.id, name, input };
                } catch {
                    return { id: c.id, name, input: {}, error: `The arguments were not valid JSON: ${raw.slice(0, 200)}` };
                }
            }),
        };
    }

    async _request(signal) {
        const body = JSON.stringify({
            model: this.model,
            messages: this.messages,
            // Some servers reject an empty list; a compaction request has no tools.
            ...(this.tools.length ? { tools: this.tools } : {}),
            stream: true,
            stream_options: { include_usage: true },
            ...(this.effort ? { reasoning_effort: this.effort } : {}),
            ...(this.maxOutput ? { [this.tokenField]: this.maxOutput } : {}),
            ...(this.temperature !== null ? { temperature: this.temperature } : {}),
        });
        for (let attempt = 0; ; attempt++) {
            let r;
            try {
                r = await fetch(`${this.baseURL}/chat/completions`, {
                    method: 'POST', headers: headers(this.apiKey, this.extraHeaders), body, signal,
                });
            } catch (e) {
                if (signal?.aborted) return null;
                throw e;
            }
            if (r.ok) return r;
            const text = await r.text();
            if (RETRY_STATUS.has(r.status) && attempt < MAX_RETRIES) {
                await sleep(retryDelayMs(r, attempt), signal);
                if (signal?.aborted) return null;
                continue;
            }
            throw apiError(r.status, text);
        }
    }
}
