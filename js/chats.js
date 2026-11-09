/*
 * chats.js — the page's chats, kept in this browser (IndexedDB), so a reload
 * brings them back and the page can hold several, one per tab.
 *
 * A chat is one record:
 *   { id, title, titled, created, updated, model,
 *     events,      what the chat shows, in order (see below), to draw it again
 *     history,     the provider's own conversation (exportHistory()), so the
 *                  model carries on where it left; only a provider of the same
 *                  kind can take it back (its `format`)
 *     usage, toolStats, compactions, exchanges }   the Settings and Log tabs' figures
 *
 * Events are plain JSON, never markup: the page draws them with textContent, as it
 * draws live messages.
 *   { k: 'user', text, at, took? }          a message you sent (took: when the
 *                                           agent took one sent while it worked)
 *   { k: 'assistant', text, stat? }         a reply; stat: { text, title }
 *   { k: 'thinking', text, stat? }
 *   { k: 'tool', call, output, isError, statText, statTitle, title, done }
 *   { k: 'compaction', c, who }
 *   { k: 'note' | 'problem', text }
 */

'use strict';

const DB_NAME = 'tinyemu-agent-chats';
export const DEFAULT_TITLE = 'New chat';
/* The Log tab's exchanges kept per chat: the latest ones. */
export const MAX_EXCHANGES = 2000;

export class ChatStore {
    async _db() {
        this.db ||= await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore('chats', { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this.db;
    }
    async _op(mode, fn) {
        const db = await this._db();
        return new Promise((resolve, reject) => {
            const t = db.transaction('chats', mode);
            const r = fn(t.objectStore('chats'));
            t.oncomplete = () => resolve(r.result);
            t.onerror = t.onabort = () => reject(t.error);
        });
    }
    all() { return this._op('readonly', (s) => s.getAll()); }
    put(chat) { return this._op('readwrite', (s) => s.put(chat)); }
    delete(id) { return this._op('readwrite', (s) => s.delete(id)); }
    clear() { return this._op('readwrite', (s) => s.clear()); }
}

/** A chat store in memory: for tests, and for browsers without IndexedDB. */
export class MemoryChatStore {
    constructor() { this.items = new Map(); }
    async all() { return [...this.items.values()].map((c) => structuredClone(c)); }
    async put(chat) { this.items.set(chat.id, structuredClone(chat)); }
    async delete(id) { this.items.delete(id); }
    async clear() { this.items.clear(); }
}

export function newChat(now = Date.now()) {
    return {
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: DEFAULT_TITLE, titled: false, created: now, updated: now, model: null,
        events: [], history: null, usage: null, toolStats: null, compactions: null, exchanges: [],
    };
}

/** A tab title from the first message: its first line, cut at a word, at most `max` long. */
export function titleFrom(text, max = 40) {
    const line = String(text).trim().split('\n')[0].replace(/\s+/g, ' ');
    if (!line) return DEFAULT_TITLE;
    if (line.length <= max) return line;
    const cut = line.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** The chat to open: the one named, if it still exists, else the latest updated. */
export function pickChat(chats, id) {
    return chats.find((c) => c.id === id) || [...chats].sort((a, b) => b.updated - a.updated)[0] || null;
}
