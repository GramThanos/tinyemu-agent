/*
 * FileSystemAccessBackend — map a REAL local directory the user picks into a
 * guest path (the closest analogue to `docker run -v /host/dir:/vm/dir`).
 *
 * Uses the File System Access API (showDirectoryPicker). Chromium-only, requires
 * a user gesture and a permission grant, and only works on the main thread. The
 * granted handle can be persisted in IndexedDB to survive reloads (re-prompting
 * for permission), which the VolumeManager can wire up later.
 *
 * File interface only — no block device (a real directory is file-level).
 */

'use strict';

import { StorageBackend } from './StorageBackend.js';

export class FileSystemAccessBackend extends StorageBackend {
    constructor(name, options = {}) {
        super(name, options);
        this.capabilities = { block: false, files: true, persistent: true };
        this._dir = options.dirHandle || null;   // a pre-granted handle, or null to prompt
        this._mode = options.mode || 'readwrite';
    }

    async open() {
        if (!this._dir) {
            if (!self.showDirectoryPicker) throw new Error('File System Access API unavailable');
            this._dir = await self.showDirectoryPicker({ mode: this._mode });
        }
        const perm = await this._dir.queryPermission({ mode: this._mode });
        if (perm !== 'granted') {
            const req = await this._dir.requestPermission({ mode: this._mode });
            if (req !== 'granted') throw new Error('permission to the directory was not granted');
        }
        return this;
    }

    get dirHandle() { return this._dir; }

    async readFile(path) {
        try {
            const fh = await this._resolveFile(path, false);
            const f = await fh.getFile();
            return new Uint8Array(await f.arrayBuffer());
        } catch { return null; }
    }

    async writeFile(path, data) {
        const fh = await this._resolveFile(path, true);
        const w = await fh.createWritable();
        await w.write(new Uint8Array(data));
        await w.close();
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
        } catch {
            try { await this._dirFor(path, false); return { size: 0, dir: true, mtime: 0 }; }
            catch { return null; }
        }
    }

    async list(path = '') {
        const d = await this._dirFor(path, false);
        const out = [];
        for await (const [name, handle] of d.entries()) {
            out.push({ name, dir: handle.kind === 'directory' });
        }
        return out;
    }

    _split(path) {
        const clean = path.replace(/^\/+/, '');
        const i = clean.lastIndexOf('/');
        return i < 0 ? { dir: '', base: clean } : { dir: clean.slice(0, i), base: clean.slice(i + 1) };
    }
    async _dirFor(dirPath, create) {
        let d = this._dir;
        for (const seg of (dirPath || '').split('/').filter(Boolean)) {
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
