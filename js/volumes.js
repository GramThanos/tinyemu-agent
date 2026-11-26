// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * volumes.js — a set of JS volumes (the in-memory 9p stores of jsLab) that the
 * page can use whether or not a VM is running, through the same calls a VM has:
 * volumeList, volumeGetFile, volumePutFile, volumeDelete, volumeMkdir,
 * volumeRename, volumeFlush.
 *
 * A volume has one writer at a time. While no VM has it, the page holds it: an
 * Fs9pStore here, saved to IndexedDB on its own timer. A VM that boots with it
 * loads it in its worker, so the page first flushes and closes its copy
 * (`handTo(vm)`); every call then goes to the VM. When that VM stops (and has
 * flushed), `takeBack()` reads it again. Two VMs must never hold one volume:
 * environments.js keeps one VM per project for that reason.
 *
 * Everything the page shows of a project's files (the Files panel, linked
 * folders, bash.js, Read/Edit/Write served from the page) goes through a
 * VolumeHost, so none of it cares where the volume lives right now.
 */

'use strict';

import { Fs9pStore } from '../deps/jsLab/lib/volumes/Fs9pStore.js';

const FLUSH_MS = 3000;   // like the worker's: the page's copy saves itself this often

export class VolumeHost {
    /**
     * @param {{name:string, storageKey:string}[]} specs  the volumes, by name
     * @param {object} [o]
     * @param {(spec) => Promise<object>} [o.open]  opens a store (tests pass one in memory)
     */
    constructor(specs, { open = null } = {}) {
        this.specs = new Map(specs.map((s) => [s.name, { backend: 'indexeddb', type: 'files', ...s }]));
        this._open = open || ((spec) => Fs9pStore.fromSpec(spec));
        this.stores = new Map();   // name -> Fs9pStore, while the page holds it
        this.vm = null;            // the VM holding the volumes, or null
        this._ready = null;        // the page's copies loading
        this._timer = 0;
        this._listeners = new Set();
        this._gate = Promise.resolve();   // hand-overs, one at a time
        this._vmReady = null;      // settles once the VM holding the volumes has started
        this._markReady = null;
        this.version = 0;          // bumped by every change made through this host
    }

    /** The volume specs for a VM's config (each with its storage key). */
    volumeSpecs(names = [...this.specs.keys()]) { return names.map((n) => ({ ...this.specs.get(n) })); }

    /** Who holds the volumes: 'page' or 'vm'. */
    get holder() { return this.vm ? 'vm' : 'page'; }

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emit() { for (const fn of this._listeners) { try { fn(this.holder); } catch { /* a listener's problem */ } } }

    /** Load the page's copies (once; again after takeBack). */
    open() {
        if (this._closed) return Promise.resolve();
        this._ready ||= (async () => {
            for (const [name, spec] of this.specs) {
                if (this.stores.has(name)) continue;
                try {
                    this.stores.set(name, await this._open(spec));
                } catch (e) {
                    console.warn(`volumes: could not open ${name}`, e);
                }
            }
            this._schedule();
        })();
        return this._ready;
    }

    _schedule() {
        clearInterval(this._timer);
        this._timer = setInterval(() => { this.flushPage().catch(() => {}); }, FLUSH_MS);
    }

    async flushPage() {
        for (const s of this.stores.values()) await s.flush?.();
    }

    /**
     * Hand the volumes to a VM that is about to boot with them: the page's copies
     * are saved and closed, so the worker loads the latest and is the only writer.
     */
    handTo(vm) {
        return this._gated(async () => {
            await this._ready;
            clearInterval(this._timer);
            this._timer = 0;
            await this.flushPage();
            for (const s of this.stores.values()) await s.backend?.close?.();
            this.stores.clear();
            this._ready = null;
            this.vm = vm;
            this._vmReady = new Promise((resolve) => { this._markReady = resolve; });
            this._emit();
        });
    }

    /** The VM the volumes were handed to has started (or failed to): calls go to it now. */
    vmStarted() { this._markReady?.(); }

    /** The VM is gone (stopped after flushing its volumes): the page holds them again. */
    takeBack(vm = this.vm) {
        return this._gated(async () => {
            if (this.vm !== vm) return;
            this._markReady?.();
            this.vm = null;
            await this.open();
            this._emit();
        });
    }

    _gated(fn) {
        const r = this._gate.then(fn);
        this._gate = r.catch(() => {});
        return r;
    }

    /* Each call goes to whoever holds the volume once any hand-over in progress is done. */
    async _call(name, onVM, onStore) {
        await this._gate;
        if (this._closed) return null;
        if (this.vm) {
            await this._vmReady;
            if (this.vm) return onVM(this.vm);
        }
        await this.open();
        const s = this.stores.get(name);
        if (!s) return null;
        return onStore(s);
    }

    volumeList(name, path = '/') {
        return this._call(name, (vm) => vm.volumeList(name, path), (s) => s.listDir(path));
    }

    volumeGetFile(name, path) {
        return this._call(name, (vm) => vm.volumeGetFile(name, path), (s) => s.getFile(path));
    }

    volumePutFile(name, path, data) {
        this.version++;
        return this._call(name, (vm) => vm.volumePutFile(name, path, data), (s) => s.putFile(path, data || new Uint8Array(0)));
    }

    volumeDelete(name, path) {
        this.version++;
        return this._call(name, (vm) => vm.volumeDelete(name, path), (s) => s.removePath(path));
    }

    volumeMkdir(name, path) {
        this.version++;
        return this._call(name, (vm) => vm.volumeMkdir(name, path), (s) => { s._mkdirp(path); return 0; });
    }

    volumeRename(name, from, to) {
        this.version++;
        return this._call(name, (vm) => vm.volumeRename(name, from, to), (s) => s.rename(from, to));
    }

    volumeFlush(name) {
        return this._call(name, (vm) => vm.volumeFlush(name), async (s) => { await s.flush?.(); return 0; });
    }

    /** Save the page's copies now (pagehide); a VM saves its own. */
    flush() { return this.vm ? this.vm.flush?.() : this.flushPage(); }

    /**
     * Close the page's copies for good, so their databases can be deleted (a
     * deleted project). No VM may hold them: stop it first. Later calls find no
     * volume, and nothing opens them again.
     */
    close() {
        return this._gated(async () => {
            if (this.vm) throw new Error('a VM still holds the volumes');
            this._closed = true;
            await this._ready?.catch?.(() => {});
            clearInterval(this._timer);
            this._timer = 0;
            for (const s of this.stores.values()) await s.backend?.close?.();
            this.stores.clear();
            this._ready = Promise.resolve();
        });
    }
}

/* jsLab's IndexedDB backend (deps/jsLab/lib/volumes/backends/IndexedDBBackend.js)
 * keeps a volume in the database `tinyemu-vol-<storage key>`. */
export const volumeDbName = (storageKey) => `tinyemu-vol-${storageKey}`;

/**
 * Delete the databases of volumes nobody holds open any more: the page closed its
 * copies (VolumeHost.close) and no VM runs with them. Never for a volume in use:
 * whoever holds it would write it back. Resolves once each is gone, or blocked.
 * @param {string[]} storageKeys
 */
export function deleteVolumeDatabases(storageKeys) {
    if (typeof indexedDB === 'undefined') return Promise.resolve();
    return Promise.all(storageKeys.map((key) => new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(volumeDbName(key));
        req.onsuccess = req.onerror = () => resolve();
        // Someone still has it open: it goes once they close it.
        req.onblocked = () => resolve();
    })));
}
