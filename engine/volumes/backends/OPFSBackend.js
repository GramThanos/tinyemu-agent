/*
 * OPFSBackend — Origin Private File System. Sandboxed, fast, persistent, no
 * user prompt. Best backend for overlay images: inside a Web Worker it can use
 * FileSystemSyncAccessHandle for synchronous random-access read/write at an
 * offset — ideal for a block device and for an Asyncify bridge to the guest.
 *
 *   type 'block'  : one image file `<name>.img`, random access by sector.
 *   type 'files'  : a directory `<name>/` holding the volume's files.
 *
 * Sync access handles are only available in workers. On the main thread we fall
 * back to createWritable (file-level ops work; block ops require the worker).
 */

'use strict';

import { StorageBackend } from './StorageBackend.js';

const inWorker = (typeof WorkerGlobalScope !== 'undefined')
    && (typeof self !== 'undefined')
    && (self instanceof WorkerGlobalScope);

export class OPFSBackend extends StorageBackend {
    constructor(name, options = {}) {
        super(name, options);
        this.type = options.type || 'block';
        this.capabilities = { block: this.type === 'block', files: true, persistent: true };
        this.sectorCount = options.sizeMB ? Math.floor((options.sizeMB * 1024 * 1024) / this.sectorSize) : 0;

        this._root = null;      // OPFS root dir
        this._dir = null;       // volume dir (files mode)
        this._fileHandle = null;
        this._sync = null;      // FileSystemSyncAccessHandle (block mode, worker)
    }

    async open() {
        if (!navigator.storage?.getDirectory) throw new Error('OPFS unavailable in this browser');
        this._root = await navigator.storage.getDirectory();

        if (this.type === 'block') {
            this._fileHandle = await this._root.getFileHandle(`${this.name}.img`, { create: true });
            if (inWorker && this._fileHandle.createSyncAccessHandle) {
                this._sync = await this._fileHandle.createSyncAccessHandle();
                const cur = this._sync.getSize();
                const want = this.sectorCount * this.sectorSize;
                if (want && cur < want) this._sync.truncate(want);
                if (!this.sectorCount) this.sectorCount = Math.floor(cur / this.sectorSize);
            } else if (!inWorker) {
                // block random-writes need the worker; expose only sizing here.
                const f = await this._fileHandle.getFile();
                if (!this.sectorCount) this.sectorCount = Math.floor(f.size / this.sectorSize);
                this.capabilities.block = false;
            }
        } else {
            this._dir = await this._root.getDirectoryHandle(this.name, { create: true });
        }
        return this;
    }

    async close() {
        if (this._sync) { try { this._sync.flush(); this._sync.close(); } catch {} this._sync = null; }
    }
    async flush() { if (this._sync) this._sync.flush(); }

    /* ---- block (worker + sync access handle) ---- */

    async getSectorCount() { return this.sectorCount; }

    async readSectors(sector, count) {
        if (!this._sync) throw new Error('OPFS block reads require a Web Worker');
        const out = new Uint8Array(count * this.sectorSize);
        this._sync.read(out, { at: sector * this.sectorSize });
        return out;
    }

    async writeSectors(sector, data) {
        if (!this._sync) throw new Error('OPFS block writes require a Web Worker');
        this._sync.write(data, { at: sector * this.sectorSize });
    }

    /* ---- files ---- */

    async readFile(path) {
        try {
            const fh = await this._resolveFile(path, false);
            const f = await fh.getFile();
            return new Uint8Array(await f.arrayBuffer());
        } catch { return null; }
    }

    async writeFile(path, data) {
        const fh = await this._resolveFile(path, true);
        if (inWorker && fh.createSyncAccessHandle) {
            const h = await fh.createSyncAccessHandle();
            h.truncate(0); h.write(new Uint8Array(data), { at: 0 }); h.flush(); h.close();
        } else {
            const w = await fh.createWritable();
            await w.write(new Uint8Array(data)); await w.close();
        }
    }

    async unlink(path) {
        const { dir, base } = this._split(path);
        const d = await this._dirFor(dir, false);
        await d.removeEntry(base);
    }

    async stat(path) {
        try {
            const fh = await this._resolveFile(path, false);
            const f = await fh.getFile();
            return { size: f.size, dir: false, mtime: f.lastModified };
        } catch { return null; }
    }

    async list(path = '') {
        const d = await this._dirFor(path, false);
        const out = [];
        for await (const [name, handle] of d.entries()) {
            out.push({ name, dir: handle.kind === 'directory' });
        }
        return out;
    }

    /* ---- path helpers ---- */

    _split(path) {
        const clean = path.replace(/^\/+/, '');
        const i = clean.lastIndexOf('/');
        return i < 0 ? { dir: '', base: clean } : { dir: clean.slice(0, i), base: clean.slice(i + 1) };
    }
    async _dirFor(dirPath, create) {
        let d = this._dir;
        if (!dirPath) return d;
        for (const seg of dirPath.split('/').filter(Boolean)) {
            d = await d.getDirectoryHandle(seg, { create });
        }
        return d;
    }
    async _resolveFile(path, create) {
        const { dir, base } = this._split(path);
        const d = await this._dirFor(dir, create);
        return d.getFileHandle(base, { create });
    }
}
