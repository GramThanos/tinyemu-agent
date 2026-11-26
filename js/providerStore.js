// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * providerStore.js — the model providers the user has set up, and the models
 * each one offers to the chats.
 *
 * A provider is one record, kept in this browser (localStorage):
 *   { id, type, label, baseURL?, apiKey?, models, enabled, modelSettings }
 * `type` is one of PROVIDER_TYPES (its wire format is the type's `kind`);
 * `models` is what the provider's own API listed last ([{ id, label,
 * contextWindow }]), and `enabled` the ids of those the user picked to offer
 * in the chats' model menu. Nothing is hard-coded: the lists come from the APIs.
 * `modelSettings` is the user's own per model, by id, over what was listed: { label,
 * contextWindow, maxOutput, temperature } (Settings → Models' ⚙), kept when the
 * list is fetched again.
 *
 * The key stays in the record and only ever goes to that provider (in a header;
 * see the providers). A custom URL is any OpenAI-compatible server.
 *
 * `Connections` loads a provider once per (provider, model) and gives each chat
 * a fork of it: a conversation of its own on the same client (or, for WebLLM,
 * the same loaded engine).
 */

'use strict';

import { CLAUDE_EFFORTS, ClaudeProvider, listClaudeModels } from './providers/claude.js';
import { listOpenAIModels, OPENAI_EFFORTS, OPENAI_PRESETS, OpenAICompatProvider } from './providers/openai.js';
import { WebLLMProvider, WEBLLM_MODELS } from './providers/webllm.js';

const PROVIDERS_KEY = 'tinyemu-agent-providers';
const OLD_CONNECTION = 'tinyemu-agent-connection';

export const PROVIDER_TYPES = [
    { type: 'claude', label: 'Claude (Anthropic)', kind: 'claude', key: true },
    // A preset with a fixed URL needs a key; a local server's preset has a URL to
    // change (like a custom one, starting from its default) and no key.
    ...OPENAI_PRESETS.map((p) => (p.url
        ? { type: p.id, label: `${p.label} (on this computer)`, kind: 'openai', custom: true, local: true, defaultURL: p.url, key: false, cors: p.cors }
        : { type: p.id, label: p.label, kind: 'openai', baseURL: p.baseURL, key: true, headers: p.headers })),
    { type: 'custom', label: 'OpenAI-compatible API', kind: 'openai', custom: true, key: false },
    { type: 'webllm', label: 'In this browser (WebGPU)', kind: 'webllm', key: false },
];
export const typeOf = (cfg) => PROVIDER_TYPES.find((t) => t.type === cfg?.type) || null;

/* Thinking levels per wire format; '' is the model's default. In-browser models have none. */
export const EFFORTS = { claude: CLAUDE_EFFORTS, openai: OPENAI_EFFORTS };
export const EFFORT_DEFAULT = { claude: 'high', openai: '' };

/** The URL requests go to: the type's own, or the record's for a custom server. */
export function baseURLOf(cfg) {
    const t = typeOf(cfg);
    if (!t) return '';
    return t.custom ? String(cfg.baseURL || t.defaultURL || '').trim().replace(/\/+$/, '') : t.baseURL || '';
}

/* The limits a setting may take: [min, max]. */
export const MODEL_LIMITS = { contextWindow: [1000, 10000000], maxOutput: [1, 1000000], temperature: [0, 2] };

/** One model's settings as kept: only what is set and in range. */
export function modelSettingsShape(s) {
    if (!s || typeof s !== 'object') return null;
    const out = {};
    if (typeof s.label === 'string' && s.label.trim()) out.label = s.label.trim().slice(0, 80);
    for (const [k, [min, max]] of Object.entries(MODEL_LIMITS)) {
        const n = typeof s[k] === 'string' && s[k].trim() ? Number(s[k]) : s[k];
        if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) continue;
        out[k] = k === 'temperature' ? Math.round(n * 100) / 100 : Math.round(n);
    }
    return Object.keys(out).length ? out : null;
}

/**
 * What a provider is loaded with for one model: the user's settings over the
 * listing. { contextWindow, maxOutput, temperature, windowSet, tokenField }.
 */
export function modelTuning(cfg, modelId) {
    const s = cfg?.modelSettings?.[modelId] || {};
    const listed = cfg?.models?.find((m) => m.id === modelId)?.contextWindow ?? null;
    return {
        contextWindow: s.contextWindow ?? listed,
        maxOutput: s.maxOutput ?? null,
        temperature: s.temperature ?? null,
        windowSet: s.contextWindow != null,
        // OpenAI's own API takes max_completion_tokens (its reasoning models refuse max_tokens).
        tokenField: cfg?.type === 'openai' ? 'max_completion_tokens' : 'max_tokens',
    };
}

const modelShape = (m) => (m && typeof m.id === 'string'
    ? { id: m.id, label: typeof m.label === 'string' ? m.label : m.id, contextWindow: Number.isInteger(m.contextWindow) ? m.contextWindow : null }
    : null);

export function providerShape(p) {
    const t = typeOf(p);
    if (!t) return null;
    const models = Array.isArray(p.models) ? p.models.map(modelShape).filter(Boolean) : [];
    return {
        id: typeof p.id === 'string' && p.id ? p.id : `${t.type}-${Math.random().toString(36).slice(2, 7)}`,
        type: t.type,
        label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : t.label,
        baseURL: t.custom ? String(p.baseURL || t.defaultURL || '') : undefined,
        apiKey: t.key || t.custom ? String(p.apiKey || '') : undefined,
        models: t.kind === 'webllm' ? WEBLLM_MODELS.map(modelShape) : models,
        enabled: Array.isArray(p.enabled) ? p.enabled.filter((id) => typeof id === 'string') : [],
        modelSettings: Object.fromEntries(Object.entries(p.modelSettings && typeof p.modelSettings === 'object' ? p.modelSettings : {})
            .map(([id, s]) => [id, modelSettingsShape(s)]).filter(([, s]) => s)),
    };
}

/* The page's localStorage, or null: with storage blocked (all cookies blocked, some
 * private modes), merely reading `localStorage` throws. */
function pageStorage() {
    try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class ProviderStore {
    constructor({ storage = pageStorage() } = {}) { this.storage = storage; }

    /** The providers, and on first use the connection the page saved before (with its model enabled). */
    load() {
        let list = null;
        try { list = JSON.parse(this.storage?.getItem(PROVIDERS_KEY)); } catch { /* none */ }
        if (Array.isArray(list)) return { providers: list.map(providerShape).filter(Boolean), migrated: null };
        let old = null;
        try { old = JSON.parse(this.storage?.getItem(OLD_CONNECTION)); } catch { /* none */ }
        if (!old?.provider) return { providers: [], migrated: null };
        const p = providerShape({ id: old.provider, type: old.provider, baseURL: old.baseURL, apiKey: old.apiKey,
            enabled: old.model ? [old.model] : [], models: old.model ? [{ id: old.model, label: old.model }] : [] });
        return { providers: p ? [p] : [], migrated: p && old.model ? { provider: p.id, model: old.model } : null };
    }

    save(list) {
        try { this.storage?.setItem(PROVIDERS_KEY, JSON.stringify(list)); return true; } catch { return false; }
    }

    clear() {
        try { this.storage?.removeItem(PROVIDERS_KEY); this.storage?.removeItem(OLD_CONNECTION); } catch { /* nothing saved */ }
    }
}

/** List a provider's models from its API. @returns [{ id, label, contextWindow }] */
export async function listModels(cfg, { signal, claudeBaseURL } = {}) {
    const t = typeOf(cfg);
    if (!t) throw new Error('unknown provider type');
    if (t.kind === 'webllm') return WEBLLM_MODELS.map(modelShape);
    const apiKey = String(cfg.apiKey || '').trim();
    if (t.custom && !/^https?:\/\/\S+$/.test(baseURLOf(cfg))) throw new Error('enter the API URL first, like http://localhost:8080/v1');
    if (!t.custom && !apiKey) throw new Error(`enter your ${t.label} API key first`);
    const models = t.kind === 'claude'
        ? await listClaudeModels({ apiKey, baseURL: claudeBaseURL, signal })
        : await listOpenAIModels({ baseURL: baseURLOf(cfg), apiKey, signal, extraHeaders: t.headers?.() || {} });
    return models.map(modelShape).filter(Boolean);
}

/** Every model the chats can pick: the enabled ones of each provider, in order. */
export function offeredModels(providers) {
    const out = [];
    for (const p of providers) {
        for (const id of p.enabled) {
            const m = p.models.find((x) => x.id === id) || { id, label: id, contextWindow: null };
            const own = p.modelSettings?.[id];
            out.push({ provider: p.id, providerLabel: p.label, kind: typeOf(p)?.kind, model: id,
                label: own?.label || (m.label || id).replace(/\s*\([^)]*\)$/, '') || id, contextWindow: own?.contextWindow ?? m.contextWindow });
        }
    }
    return out;
}

/**
 * Loaded providers, one per (provider, model). A chat never talks to one of
 * these itself: `conversation()` forks it, so every chat has its own history.
 */
export class Connections {
    /**
     * @param {object} o
     * @param {() => object[]} o.providers   the configured providers, read at each use
     * @param {(kind:string) => string} o.effort  the thinking level for a wire format
     * @param {() => string|undefined} [o.claudeBaseURL]   a loopback test server (?baseURL=)
     * @param {(text:string) => void} [o.onProgress]   WebLLM's loading progress
     */
    constructor({ providers, effort, claudeBaseURL = () => undefined, onProgress = () => {} }) {
        this.providers = providers;
        this.effort = effort;
        this.claudeBaseURL = claudeBaseURL;
        this.onProgress = onProgress;
        this.loaded = new Map();   // `${provider}/${model}` -> Promise<provider>
    }

    config(id) { return this.providers().find((p) => p.id === id) || null; }

    /** A label for a pick: "Claude (Anthropic): claude-opus-5-5". */
    label(pick) {
        const cfg = this.config(pick?.provider);
        return cfg ? `${cfg.label}: ${pick.model}` : pick?.model || '';
    }

    /** The model's name as its provider listed it. */
    modelName(pick) {
        const cfg = this.config(pick?.provider);
        const own = cfg?.modelSettings?.[pick?.model]?.label;
        if (own) return own;
        const m = cfg?.models.find((x) => x.id === pick?.model);
        return (m?.label || '').replace(/\s*\([^)]*\)$/, '') || pick?.model || '';
    }

    _key(pick) { return `${pick.provider}/${pick.model}`; }

    /** Load (once) the provider for a pick; a failed load is forgotten, so it can be tried again. */
    root(pick, { system = '', tools = [] } = {}) {
        const k = this._key(pick);
        let p = this.loaded.get(k);
        if (!p) {
            p = this._load(pick, { system, tools });
            this.loaded.set(k, p);
            p.catch(() => { if (this.loaded.get(k) === p) this.loaded.delete(k); });
        }
        return p;
    }

    async _load(pick, { system, tools }) {
        const cfg = this.config(pick.provider);
        const t = typeOf(cfg);
        if (!cfg || !t) throw new Error(`the provider ${pick.provider} is not set up any more (Settings → Models)`);
        const tuning = modelTuning(cfg, pick.model);
        const contextWindow = tuning.contextWindow;
        const common = { model: pick.model, system, tools };
        const effort = this.effort(t.kind);
        const provider = t.kind === 'claude'
            ? new ClaudeProvider({ ...common, apiKey: String(cfg.apiKey || '').trim(), baseURL: this.claudeBaseURL(), effort, contextWindow })
            : t.kind === 'openai'
                ? new OpenAICompatProvider({ ...common, apiKey: String(cfg.apiKey || '').trim(), baseURL: baseURLOf(cfg), effort, contextWindow, extraHeaders: t.headers?.() || {} })
                : new WebLLMProvider({ ...common, onProgress: (text) => this.onProgress(text, pick) });
        provider.kind = t.kind;
        provider.setTuning?.(tuning);
        await provider.load();
        return provider;
    }

    /** A new conversation with the pick's model. */
    async conversation(pick, { system, tools }) {
        const root = await this.root(pick, { system, tools });
        if (!root.fork) throw new Error('this provider can\'t hold more than one conversation');
        const p = root.fork({ system, tools });
        p.kind = root.kind;
        return p;
    }

    /** Settings changed (a key, a URL): load afresh next time. */
    forget(providerId = null) {
        for (const k of [...this.loaded.keys()]) if (!providerId || k.startsWith(`${providerId}/`)) this.loaded.delete(k);
    }

    /**
     * A model's settings changed: the loaded root takes them (new chats fork it), and
     * so does every conversation given, from its next request.
     * @param {object[]} conversations  the chats' providers on that pick
     */
    async retune(pick, conversations = []) {
        const tuning = modelTuning(this.config(pick.provider), pick.model);
        const root = await this.loaded.get(this._key(pick))?.catch(() => null);
        for (const p of [root, ...conversations]) p?.setTuning?.(tuning);
    }

    /** Apply a thinking level to every loaded provider of a wire format (forks copy it when made). */
    async setEffort(kind, level) {
        for (const p of this.loaded.values()) {
            const x = await p.catch(() => null);
            if (x?.kind === kind) x.setEffort?.(level);
        }
    }
}
