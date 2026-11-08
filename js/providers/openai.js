/*
 * openai.js — any OpenAI-compatible chat completions API: OpenAI itself, Gemini's
 * compatibility endpoint, OpenRouter, or a server of your own (llama.cpp, Ollama,
 * vLLM, ...). Called directly from the page with the user's key, which stays in
 * this page's memory and never reaches the guest.
 *
 * Plain fetch + server-sent events, so there is no SDK to load.
 */

'use strict';

/* Providers offered by name. Anything else goes in as a custom base URL. */
export const OPENAI_PRESETS = [
    { id: 'gemini', label: 'Gemini (Google AI Studio)', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
    { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
];

const MAX_RETRIES = 4;   // for rate limits (429) and overload (502-504)
const RETRY_STATUS = new Set([429, 502, 503, 504]);

/* Listed models that can't hold a chat: embeddings, speech, images, video, ... */
const NOT_CHAT = /embed|tts|whisper|transcri|audio|speech|image|imagen|veo|dall-e|sora|moderation|lyria|aqa|live|realtime|robotics|search-preview/i;

const headers = (apiKey) => ({
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});

/* The API's own message from an error body, which is { error: { message } } or,
 * from Gemini, an array of those. */
function errorMessage(status, text) {
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const e = Array.isArray(body) ? body[0] : body;
    const message = e?.error?.message || e?.message || text.trim().slice(0, 300);
    return `API error ${status}${message ? `: ${message}` : ''}`;
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
        ?? m.top_provider?.context_length ?? m.meta?.n_ctx ?? m.meta?.n_ctx_train;
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** The chat models a provider lists, as [{ id, label, contextWindow }], sorted by id. */
export async function listOpenAIModels({ baseURL, apiKey, signal }) {
    const r = await fetch(`${baseURL}/models`, { headers: headers(apiKey), signal });
    const text = await r.text();
    if (!r.ok) throw new Error(errorMessage(r.status, text));
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
 * ride in extra_content). */
function mergeCall(call, delta) {
    for (const [k, v] of Object.entries(delta)) {
        if (k === 'index') continue;
        if (k === 'function') {
            call.function ||= { name: '', arguments: '' };
            if (v.name && call.function.name !== v.name) call.function.name += v.name;
            if (v.arguments) call.function.arguments += v.arguments;
        } else if (v !== null && v !== undefined && v !== '') {
            call[k] = v;
        }
    }
}

/* The page's usage shape from an OpenAI-style one. prompt_tokens counts cached
 * tokens too, so they are taken out of `input`; reasoning is part of the output. */
export function openAIUsage(u) {
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    const reasoning = u.completion_tokens_details?.reasoning_tokens;
    return {
        input: Math.max(0, (u.prompt_tokens || 0) - cached),
        cacheWrite: 0,
        cacheRead: cached,
        output: u.completion_tokens || 0,
        thinking: Number.isInteger(reasoning) ? reasoning : null,
    };
}

/* reasoning_effort, which OpenAI and Gemini's compatible API both take; '' sends
 * none, leaving it to the model (and to servers that don't know the field). */
export const OPENAI_EFFORTS = ['', 'low', 'medium', 'high'];

export class OpenAICompatProvider {
    constructor({ apiKey, baseURL, model, system, tools, effort = '', contextWindow = null }) {
        this.apiKey = apiKey;
        this.baseURL = baseURL;
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

    /* The model was picked from the provider's own list: nothing to load. */
    async load() {}

    /** Applies from the next request. */
    setEffort(effort) { this.effort = effort; }

    /** A new conversation with the same model and server, for a sub-agent or a compaction. */
    fork({ system, tools }) {
        return new OpenAICompatProvider({
            apiKey: this.apiKey, baseURL: this.baseURL, model: this.model, system, tools, effort: this.effort,
            contextWindow: this.contextWindow,
        });
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

        let text = '';
        let finish = null;
        let extra = {};
        const calls = [];
        try {
            for await (const data of sse(response)) {
                if (data === '[DONE]') break;
                const chunk = JSON.parse(data);
                if (chunk.error) throw new Error(errorMessage(chunk.error.code || 'in stream', JSON.stringify(chunk)));
                // Asked for with include_usage: a last chunk, usually with no choices.
                if (chunk.usage) onUsage?.(openAIUsage(chunk.usage));
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                const d = choice.delta || {};
                // Thinking appears under different names depending on the server.
                const thought = d.reasoning_content ?? d.reasoning;
                if (typeof thought === 'string' && thought) onThinking(thought);
                if (typeof d.content === 'string' && d.content) { text += d.content; onText(d.content); }
                for (const tc of d.tool_calls || []) {
                    const i = tc.index ?? calls.length;
                    calls[i] ||= { type: 'function' };
                    mergeCall(calls[i], tc);
                }
                if (d.extra_content) extra = { extra_content: d.extra_content };
                if (choice.finish_reason) finish = choice.finish_reason;
            }
        } catch (e) {
            if (signal?.aborted) return { stop: 'aborted' };
            throw e;
        }

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
        });
        for (let attempt = 0; ; attempt++) {
            let r;
            try {
                r = await fetch(`${this.baseURL}/chat/completions`, {
                    method: 'POST', headers: headers(this.apiKey), body, signal,
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
            throw new Error(errorMessage(r.status, text));
        }
    }
}
