/*
 * claude.js — Claude over the Anthropic API, called directly from the page with
 * the user's own key. The key stays in this page's memory: it is never stored, and
 * never reaches the guest.
 */

'use strict';

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@1.3.0';
const MAX_JSON_RETRIES = 2;

/** The models this key can use, newest first, as [{ id, label, contextWindow }].
 * The context window is the API's max_input_tokens, where it reports one. */
export async function listClaudeModels({ apiKey, baseURL, signal }) {
    const { default: Anthropic } = await import(SDK_URL);
    const client = new Anthropic({ apiKey, baseURL: baseURL || undefined, dangerouslyAllowBrowser: true });
    const models = [];
    try {
        for await (const m of client.models.list({ limit: 100 }, { signal })) {
            models.push({
                id: m.id,
                label: m.display_name ? `${m.display_name} (${m.id})` : m.id,
                contextWindow: Number.isInteger(m.max_input_tokens) ? m.max_input_tokens : null,
            });
        }
    } catch (e) {
        // The SDK's message is the raw response body; keep just the API's words.
        const message = e?.error?.error?.message;
        throw message ? new Error(`API error ${e.status}: ${message}`) : e;
    }
    return models;
}

/* Haiku has no server-side fallback; the others re-run a declined request elsewhere. */
const fallbackParams = (model) => (model.startsWith('claude-haiku')
    ? { betas: [] }
    : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

/* Thinking depth: output_config.effort. Not every model takes every level, and
 * '' leaves it to the model's own default. */
export const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const MAX_TOKENS = 64000;

export class ClaudeProvider {
    constructor({ apiKey, model, system, tools, baseURL, effort = 'high', contextWindow = null }) {
        this.apiKey = apiKey;
        this.baseURL = baseURL;
        this.model = model;
        this.system = system;
        this.effort = effort;
        this.contextWindow = contextWindow;   // tokens, or null if the API didn't say
        this.maxOutput = MAX_TOKENS;
        this.setTools(tools);
        this.messages = [];
        this.Anthropic = null;
        this.client = null;
    }

    /** Applies from the next request; a change misses the prompt cache once. */
    setSystem(system) { this.system = system; }

    setTools(tools) {
        // Input is streamed unbuffered, which is why tools.js validates every call.
        this.tools = tools.map((t) => ({ ...t, eager_input_streaming: true }));
    }

    async load() {
        const { default: Anthropic } = await import(SDK_URL);
        this.Anthropic = Anthropic;
        this.client = new Anthropic({
            apiKey: this.apiKey,
            baseURL: this.baseURL || undefined,
            dangerouslyAllowBrowser: true,
        });
    }

    /** Applies from the next request. A change mid-conversation costs a cache miss. */
    setEffort(effort) { this.effort = effort; }

    /** A new conversation with the same model and client, for a sub-agent or a compaction. */
    fork({ system, tools }) {
        const p = new ClaudeProvider({
            apiKey: this.apiKey, model: this.model, system, tools, baseURL: this.baseURL, effort: this.effort,
            contextWindow: this.contextWindow,
        });
        p.Anthropic = this.Anthropic;
        p.client = this.client;
        return p;
    }

    /** The history as plain entries, for a compaction summary. Thinking is left out. */
    transcript() {
        const out = [];
        for (const m of this.messages) {
            if (typeof m.content === 'string') { out.push({ role: m.role, text: m.content }); continue; }
            for (const b of m.content) {
                if (b.type === 'text' && b.text) out.push({ role: m.role, text: b.text });
                else if (b.type === 'tool_use') out.push({ role: 'call', text: `${b.name} ${JSON.stringify(b.input)}` });
                else if (b.type === 'tool_result') {
                    const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                    out.push({ role: 'result', text, isError: !!b.is_error });
                }
            }
        }
        return out;
    }

    /** Replace the history with one user message: a new conversation, so no
     * earlier thinking block is edited (the API checks that). */
    resetHistory(text) { this.messages = [{ role: 'user', content: text }]; }

    addUser(text) { this.messages.push({ role: 'user', content: text }); }

    addToolResults(results) {
        this.messages.push({
            role: 'user',
            content: results.map((r) => ({
                type: 'tool_result',
                tool_use_id: r.id,
                content: r.content,
                is_error: r.isError,
            })),
        });
    }

    async step({ onText, onThinking, onUsage, signal }) {
        for (let jsonRetries = 0; ;) {
            const stream = this.client.beta.messages.stream({
                model: this.model,
                max_tokens: MAX_TOKENS,
                system: this.system,
                ...(this.tools.length ? { tools: this.tools } : {}),
                messages: this.messages,
                thinking: { type: 'adaptive', display: 'summarized' },
                ...(this.effort ? { output_config: { effort: this.effort } } : {}),
                cache_control: { type: 'ephemeral' },
                ...fallbackParams(this.model),
            }, { signal });
            stream.on('text', (t) => onText(t));
            stream.on('thinking', (t) => onThinking(t));

            let message;
            try {
                message = await stream.finalMessage();
                jsonRetries = 0;
            } catch (e) {
                if (e instanceof this.Anthropic.APIUserAbortError || signal?.aborted) return { stop: 'aborted' };
                // Anything but an API error here is a tool input the SDK could not parse.
                if (e instanceof this.Anthropic.APIError || jsonRetries++ >= MAX_JSON_RETRIES) throw e;
                continue;
            }
            // Thinking is billed inside output_tokens; the API doesn't count it apart.
            const u = message.usage || {};
            onUsage?.({
                input: u.input_tokens || 0,
                cacheWrite: u.cache_creation_input_tokens || 0,
                cacheRead: u.cache_read_input_tokens || 0,
                output: u.output_tokens || 0,
                thinking: null,
            });

            // Always append the content verbatim: thinking and fallback blocks must
            // go back unchanged on the next request.
            const reason = message.stop_reason;
            if (reason === 'refusal') {
                return { stop: 'refusal', detail: message.stop_details?.explanation || 'The model declined this request.' };
            }
            const toolUses = message.content.filter((b) => b.type === 'tool_use');
            if (reason === 'max_tokens' && toolUses.length) {
                // The inputs may be cut off, and answering would run them; drop the turn.
                return { stop: 'max_tokens', detail: 'The response hit max_tokens in the middle of a tool call.' };
            }
            this.messages.push({ role: 'assistant', content: message.content });
            if (reason === 'pause_turn') continue;
            if (reason === 'max_tokens') return { stop: 'max_tokens', detail: 'The response hit max_tokens.' };
            if (!toolUses.length) return { stop: 'end' };
            return {
                stop: 'tool_use',
                toolCalls: toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input })),
            };
        }
    }
}
