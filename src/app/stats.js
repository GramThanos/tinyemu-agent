// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * stats.js — each chat's figures, kept on its record (js/chats.js): token usage,
 * tool stats, compactions, the log of exchanges, turn counts and the running
 * figures (js/figures.js). A chat saved before some of them existed gets them
 * empty. Also the Log tab's export and import.
 *
 * The log is what the agents said and did, the sub-agents' included: their
 * messages, each reply with its tool calls and usage, each tool result with its
 * time. The latest MAX_EXCHANGES are saved with the chat. Entries hold model and
 * guest text, so the page shows them as text only. An imported log is shown
 * instead of the chat's until the chat logs something new.
 */

'use strict';

import { figuresShape, recordExchange } from '../../js/figures.js';
import { emit } from './store.js';
import { S } from './state.js';

export const USAGE_COLUMNS = [
    ['requests', 'Requests'], ['input', 'Input'], ['cacheWrite', 'Cache write'],
    ['cacheRead', 'Cache read'], ['output', 'Output'], ['thinking', 'Thinking'],
];
export const emptyUsage = () => ({ requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, thinkingKnown: false });

export function ensureChatShape(c) {
    const u = c.usage && typeof c.usage === 'object' ? c.usage : {};
    c.usage = { main: { ...emptyUsage(), ...u.main }, sub: { ...emptyUsage(), ...u.sub }, compaction: { ...emptyUsage(), ...u.compaction } };
    if (!c.toolStats || typeof c.toolStats !== 'object') c.toolStats = {};
    c.compactions = { main: 0, sub: 0, ...(c.compactions || {}) };
    if (!Array.isArray(c.exchanges)) c.exchanges = [];
    c.stats = { turns: 0, workMs: 0, apiMs: 0, ...(c.stats || {}) };
    c.figs = figuresShape(c.figs);
    return c;
}

/* Per tool: calls, failures, and time, the chat's agent and its sub-agents together. */
export function countTool(c, name, ms, failed) {
    if (!c) return;
    const t = c.toolStats[name] ||= { calls: 0, failed: 0, total: 0, longest: 0 };
    t.calls++;
    if (failed) t.failed++;
    t.total += ms;
    t.longest = Math.max(t.longest, ms);
    if (c === S.chat) emit('ui');
}

/* Per chat: its agent's requests and its sub-agents', as the providers report
 * them (see Agent.js for the shape). kind 'compaction' is a summary's own
 * request, whoever's context it was. */
export function addUsage(c, who, u, kind) {
    if (!c) return;
    const t = c.usage[kind === 'compaction' ? 'compaction' : who];
    t.requests++;
    for (const k of ['input', 'cacheWrite', 'cacheRead', 'output']) t[k] += u[k] || 0;
    if (Number.isInteger(u.thinking)) { t.thinking += u.thinking; t.thinkingKnown = true; }
    if (c === S.chat) emit('ui');
}

export function usageTotal(c) {
    const total = emptyUsage();
    for (const t of [c.usage.main, c.usage.sub, c.usage.compaction]) {
        for (const [k] of USAGE_COLUMNS) total[k] += t[k];
        total.thinkingKnown ||= t.thinkingKnown;
    }
    return total;
}

export function logExchange(c, entry) {
    if (!c) return;
    const e = { t: new Date().toISOString(), ...entry };
    c.exchanges.push(e);
    // Time waiting on the model, sub-agents' included (the log itself is capped).
    if (e.type === 'response' && Number.isFinite(e.ms)) c.stats.apiMs += e.ms;
    recordExchange(c.figs, e, c.kind === 'sub' ? c.subName : 'main');
    if (e.type === 'tool' && e.health) S.lastHealth = { ...e.health, at: Date.now() };
    if (e.type === 'response' && e.usage?.limits) S.lastLimits = { list: e.usage.limits, at: Date.now() };
    if (c !== S.chat) return;
    S.importedLog = null;
    emit('log');
}

export const shownExchanges = () => (S.importedLog ? S.importedLog.exchanges : S.chat?.exchanges || []);

export const LOG_FORMAT = 'tinyemu-agent-log';
