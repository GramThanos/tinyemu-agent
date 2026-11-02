/*
 * IndexedDBBackend — persistent storage in the browser DB. No permissions,
 * works on the main thread and in workers, widely supported. Supports both the
 * block interface (chunked sectors) and the file interface.
 *
 * Layout: one database `tinyemu-vol-<name>`, object stores:
 *   'blocks' : key = chunk index, value = Uint8Array (CHUNK sectors)
 *   'files'  : key = path,        value = { data:Uint8Array, dir:bool, mtime }
 *   'meta'   : key = 'info',      value = { sectorCount, sectorSize }
 */

'use strict';

import { StorageBackend } from './StorageBackend.js';

const CHUNK_SECTORS = 128;   // 64 KiB chunks (128 * 512)

export class IndexedDBBackend extends StorageBackend {
    constructor(name, options = {}) {
        super(name, options);
        this.capabilities = { block: true, files: true, persistent: true };
        this.dbName = `tinyemu-vol-${name}`;
        this.db = null;
        this.sectorCount = options.sizeMB ? Math.floor((options.sizeMB * 1024 * 1024) / this.sectorSize) : 0;
        this._chunkBytes = CHUNK_SECTORS * this.sectorSize;
    }

    async open() {
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks');
                if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const info = await this._get('meta', 'info');
        if (info) {
            this.sectorCount = info.sectorCount;
            this.sectorSize = info.sectorSize;
        } else if (this.sectorCount > 0) {
            await this._put('meta', 'info', { sectorCount: this.sectorCount, sectorSize: this.sectorSize });
        }
        return this;
    }

    async close() { this.db?.close(); this.db = null; }

    /* ---- block ---- */

    async getSectorCount() { return this.sectorCount; }

    async readSectors(sector, count) {
        const out = new Uint8Array(count * this.sectorSize);
        let done = 0;
        while (done < count) {
            const abs = sector + done;
            const chunkIdx = Math.floor(abs / CHUNK_SECTORS);
            const within = abs % CHUNK_SECTORS;
            const n = Math.min(CHUNK_SECTORS - within, count - done);
            const chunk = await this._get('blocks', chunkIdx);
            if (chunk) {
                out.set(chunk.subarray(within * this.sectorSize, (within + n) * this.sectorSize),
                        done * this.sectorSize);
            } // else: sparse => zeros (already zero-filled)
            done += n;
        }
        return out;
    }

    async writeSectors(sector, data) {
        const count = Math.floor(data.length / this.sectorSize);
        let done = 0;
        while (done < count) {
            const abs = sector + done;
            const chunkIdx = Math.floor(abs / CHUNK_SECTORS);
            const within = abs % CHUNK_SECTORS;
            const n = Math.min(CHUNK_SECTORS - within, count - done);
            let chunk = await this._get('blocks', chunkIdx);
            if (!chunk) chunk = new Uint8Array(this._chunkBytes);
            else chunk = new Uint8Array(chunk);   // copy (structured-clone returns fresh, but be safe)
            chunk.set(data.subarray(done * this.sectorSize, (done + n) * this.sectorSize),
                      within * this.sectorSize);
            await this._put('blocks', chunkIdx, chunk);
            done += n;
        }
    }

    /* ---- files ---- */

    async readFile(path) {
        const rec = await this._get('files', path);
        return rec && !rec.dir ? rec.data : null;
    }
    async writeFile(path, data) {
        await this._put('files', path, { data: new Uint8Array(data), dir: false, mtime: Date.now() });
    }
    async unlink(path) { await this._del('files', path); }
    async stat(path) {
        const rec = await this._get('files', path);
        return rec ? { size: rec.dir ? 0 : rec.data.length, dir: rec.dir, mtime: rec.mtime } : null;
    }
    async list(prefix = '') {
        const keys = await this._keys('files');
        return keys.filter(k => k.startsWith(prefix)).map(k => ({ name: k }));
    }

    /* ---- idb helpers ---- */

    _tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
    _get(store, key) {
        return new Promise((res, rej) => { const r = this._tx(store, 'readonly').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    }
    _put(store, key, val) {
        return new Promise((res, rej) => { const r = this._tx(store, 'readwrite').put(val, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
    }
    _del(store, key) {
        return new Promise((res, rej) => { const r = this._tx(store, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
    }
    _keys(store) {
        return new Promise((res, rej) => { const r = this._tx(store, 'readonly').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    }
}
