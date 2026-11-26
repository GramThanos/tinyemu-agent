// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * models.js — the providers the user set up (Settings → Models), each with the
 * models it offers, and the model each chat talks to (c.pick: { provider, model }).
 * A first load turns the connection the page used to save into a provider.
 */

'use strict';

import { Connections, modelSettingsShape, offeredModels, ProviderStore } from '../../js/providerStore.js';
import { emit } from './store.js';
import { chatById, params, S } from './state.js';
import { effortFor } from './settings.js';
import { projectOf } from './world.js';

export const providerStore = new ProviderStore();
{
    const r = providerStore.load();
    S.providers = r.providers;
    S.migratedPick = r.migrated;
    if (r.migrated) providerStore.save(S.providers);
}
/** @returns false when this browser has no storage for them */
export function saveProviders() {
    const ok = providerStore.save(S.providers);
    emit('ui', 'settings');
    return ok;
}

/* ?baseURL= points Claude's client at a local proxy or test server. Loopback only:
 * otherwise a crafted link could send a key typed here to any host. */
export function localBaseURL() {
    const value = params.get('baseURL');
    if (!value) return undefined;
    const { hostname } = new URL(value);
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') throw new Error('baseURL must be on localhost');
    return value;
}

export const connections = new Connections({
    providers: () => S.providers,
    effort: (kind) => effortFor(kind),
    claudeBaseURL: () => { try { return localBaseURL(); } catch { return undefined; } },
    onProgress: (text) => { S.loadingText = text.slice(0, 60); emit('ui'); },
});

/* A scripted provider from agentDemo.useProvider: it stands in for a pick. */
export const TEST_PROVIDER = '__test';
export function injectProvider(provider, label) {
    const pick = { provider: TEST_PROVIDER, model: label };
    connections.loaded.set(`${TEST_PROVIDER}/${label}`, Promise.resolve(provider));
    return pick;
}

export const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;
/* The model a chat uses: its own pick, else its project's, else the one saved before
 * projects, else the first offered. A sub-agent's chat shows its parent's. */
export function pickOf(c) {
    const main = c?.kind === 'sub' ? chatById(c.parent) || c : c;
    const offered = offeredModels(S.providers);
    // A scripted provider lasts until the page reloads.
    const usable = (p) => p && (p.provider === TEST_PROVIDER ? connections.loaded.has(`${p.provider}/${p.model}`) : offered.some((m) => sameModel(m, p)));
    for (const p of [main?.pick, projectOf(main)?.model, S.migratedPick]) if (usable(p)) return p;
    return offered[0] ? { provider: offered[0].provider, model: offered[0].model } : null;
}
/**
 * Change one model's own settings (Settings → Models' ⚙): { label, contextWindow,
 * maxOutput, temperature }, empty ones dropped; null clears them all. Chats on that
 * model take them from their next request, and new ones start with them.
 */
export function setModelSettings(p, modelId, values) {
    const shaped = values ? modelSettingsShape(values) : null;
    p.modelSettings = { ...(p.modelSettings || {}) };
    if (shaped) p.modelSettings[modelId] = shaped; else delete p.modelSettings[modelId];
    const ok = saveProviders();
    const pick = { provider: p.id, model: modelId };
    const mine = [...S.sessions.values()].filter((s) => s.agent && sameModel(s.pick, pick)).map((s) => s.agent.provider);
    connections.retune(pick, mine).then(() => emit('ui'));
    return ok;
}

export const pickLabel = (pick) => (pick?.provider === TEST_PROVIDER ? pick.model : connections.label(pick));
export const pickName = (pick) => (pick?.provider === TEST_PROVIDER ? pick.model : connections.modelName(pick));
