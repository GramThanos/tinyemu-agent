// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * state.js — what the page's modules share while it runs, and small formatting
 * helpers. Nothing here imports another src/app module, so any of them can import
 * it at load without a cycle.
 */

'use strict';

export const params = new URLSearchParams(location.search);

/* The page's state. Plain objects, changed in place; store.js tells React. */
export const S = {
    chats: [],          // the chat records (js/chats.js)
    chat: null,         // the open one
    sessions: new Map(),// chat id -> session (sessions.js)
    projects: [],       // the project records (js/projects.js)
    providers: [],      // the providers set up in Settings → Models
    migratedPick: null, // the old saved connection's model, for chats that had none
    mcpServers: [],     // Settings → Integrations
    modes: [],          // the agent's modes (js/modes.js), Settings → Modes
    lastHealth: null,   // the guest after the latest Bash call (GuestBridge.parseHealth), any chat
    lastLimits: null,   // the provider's latest rate limits (figures.js parseRateLimits)
    loadingText: '',    // a model loading (WebLLM reports progress)
    importedLog: null,  // { exchanges, conversation } from a file, shown in the Log tab
    resumeAsked: false, // offerResume has run
    distroList: [],     // [{ name, label, arch, description, config }]
    distroProblem: null,// why the list couldn't be read
    loaded: false,      // boot() has opened a chat
};

/* The modal and floating things the page shows: React draws them from here. */
export const UI = {
    settings: null,     // the Settings section shown, or null when closed
    project: undefined, // the project in the project dialog: a record, null for a new one, undefined when closed
    choice: null,       // { title, text, options, resolve }: choose()
    menu: null,         // { anchor (a DOM rect), items }: openMenu()
    chatInfo: false,    // the ⓘ panel
    contextPanel: false,// the context meter's panel
    skillsNote: { problems: [], note: '' },
};

export const chatById = (id) => S.chats.find((c) => c.id === id) || null;
export const anyRunning = () => [...S.sessions.values()].some((s) => s.running);

/* ---- localStorage, which may not be there ------------------------------------ */

export function readJSON(key, fallback = null) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
export function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/* ---- formatting ------------------------------------------------------------- */

export const fmt = (n) => n.toLocaleString();
export const short = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));
export const seconds = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
export const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');
export const pct = (x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const megabytes = (n) => `${(n / 1048576).toFixed(0)} MB`;

export function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

/* When a message was sent or finished: the time today, else the date too. */
export function stampText(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

/* Text unless it has a NUL early on or isn't valid UTF-8. */
export function asText(bytes) {
    if (bytes.subarray(0, 8192).includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/* Hand a blob to the browser as a download. */
export function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
