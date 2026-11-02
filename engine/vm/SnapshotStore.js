/*
 * SnapshotStore.js — keep VM snapshots (see snapshot.js) in IndexedDB, one per
 * key, each tagged with a fingerprint of everything it depends on.
 *
 * A snapshot only works in an instance of the same wasm build, with the same
 * machine config and the same disk images underneath it. The caller computes a
 * fingerprint of those with snapshotFingerprint() and load() hands back a
 * snapshot only if it matches; a stale one is deleted.
 */

'use strict';

const DB = 'tinyemu-snapshots';
const STORE = 'snapshots';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx(mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            const req = fn(t.objectStore(STORE));
            t.oncomplete = () => resolve(req?.result);
            t.onerror = t.onabort = () => reject(t.error);
        });
    } finally {
        db.close();
    }
}

/* 53-bit string/bytes hash (cyrb53). Change detection only, not security, and
 * unlike crypto.subtle it works outside a secure context (a LAN http page). */
function hash53(chunks) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    const mix = (c) => {
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    };
    for (const chunk of chunks) {
        const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        for (let i = 0; i < bytes.length; i++) mix(bytes[i]);
        mix(0x1f);   // separator, so ['ab','c'] and ['a','bc'] differ
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/* What identifies a remote file's content without downloading it. */
async function fileVersion(url) {
    try {
        const r = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
        if (!r.ok) return `missing:${r.status}`;
        const h = r.headers;
        return [h.get('etag'), h.get('last-modified'), h.get('content-length')].join('|');
    } catch (e) {
        return `unreachable:${e.message}`;
    }
}

/**
 * Fingerprint what a snapshot depends on: the wasm build, the machine config
 * text (whose kernel and drive files are checked by their HTTP validators,
 * since a rebuilt image can keep its URL) and the VM options.
 * @param {object} o
 * @param {string} o.wasmUrl
 * @param {string} o.configUrl
 * @param {object} o.options   anything else the machine depends on (memory, cmdline, ...)
 */
export async function snapshotFingerprint({ wasmUrl, configUrl, options = {} }) {
    const [wasm, cfgText] = await Promise.all([
        fetch(wasmUrl, { cache: 'no-cache' }).then((r) => r.arrayBuffer()),
        fetch(configUrl, { cache: 'no-cache' }).then((r) => r.text()),
    ]);
    const files = [...cfgText.matchAll(/\b(?:kernel|initrd|bios|file)\s*:\s*"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((f) => !f.startsWith('js:'))   // JS volumes persist on their own
        .map((f) => new URL(f, configUrl).href);
    const versions = await Promise.all(files.map(async (f) => `${f}=${await fileVersion(f)}`));
    return hash53([wasm, cfgText, JSON.stringify(options), ...versions]);
}

export const SnapshotStore = {
    /** @returns {Promise<{blob: Blob, info: object, savedAt: number}|null>} */
    async load(key, fingerprint) {
        const rec = await tx('readonly', (s) => s.get(key)).catch(() => null);
        if (!rec) return null;
        if (rec.fingerprint !== fingerprint) {
            await this.delete(key);
            return null;
        }
        return rec;
    },

    save(key, fingerprint, { blob, info }) {
        return tx('readwrite', (s) => s.put({ fingerprint, blob, info, savedAt: Date.now() }, key));
    },

    delete(key) {
        return tx('readwrite', (s) => s.delete(key)).catch(() => {});
    },
};
