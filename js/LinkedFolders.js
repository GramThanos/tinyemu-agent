/*
 * LinkedFolders.js — folders on the user's computer linked into the workspace.
 *
 * The guest's 9p filesystem is served synchronously from an in-memory store,
 * while the File System Access API is asynchronous, so a picked folder can't be
 * mounted as it is. Instead it is copied into the workspace and kept in sync:
 * sync() runs at actions (around tool calls, before a message, on Files tab
 * refreshes, when the page regains focus) and moves changes both ways.
 *
 * Each link keeps a baseline: per file, its signature on disk (size and
 * lastModified), in the workspace (size, mtime and the store's change counter
 * `gen`) and a hash of the content both sides last agreed on. A side whose
 * signature moved has changed, unless its content still hashes the same. Then:
 *   - changed on one side: copied to the other, or deleted there if it was deleted;
 *   - changed on both: the disk wins, and the workspace's version is kept next to
 *     it as <name>.workspace-conflict, on both sides;
 *   - a change against a deletion: the change wins.
 * Deleting the linked folder itself in the workspace (or replacing it, which
 * gives it a new inode) only unlinks it: nothing is deleted on disk then.
 *
 * Names from the disk reach the page only as text (the Files tab).
 */

'use strict';

export const LINK_MAX_BYTES = 200 * 1024 * 1024;
const DB_NAME = 'tinyemu-agent-links';
const CONFLICT_SUFFIX = '.workspace-conflict';

const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const relParent = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const megabytes = (n) => `${Math.round(n / 1048576)} MB`;

const diskSig = (f) => `${f.size}:${f.lastModified}`;
const wsSig = (e) => `${e.size}:${e.mtime}:${e.gen}`;

async function hashOf(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Links persist in IndexedDB: directory handles are structured-cloneable, and
 * the browser asks for permission again after a reload. */
export class IdbLinkStore {
    async _db() {
        this.db ||= await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore('links', { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this.db;
    }
    async _op(mode, fn) {
        const db = await this._db();
        return new Promise((resolve, reject) => {
            const r = fn(db.transaction('links', mode).objectStore('links'));
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    all() { return this._op('readonly', (s) => s.getAll()); }
    put(link) { return this._op('readwrite', (s) => s.put(link)); }
    delete(id) { return this._op('readwrite', (s) => s.delete(id)); }
}

export class LinkError extends Error {}

export class LinkedFolders {
    /**
     * @param {object} o
     * @param {string} o.volume     the workspace volume's name
     * @param {string} o.root       where the guest mounts it, for messages
     * @param {object} [o.store]    persistence (all/put/delete); IndexedDB by default
     * @param {number} [o.maxBytes]
     */
    constructor({ volume, root, store = new IdbLinkStore(), maxBytes = LINK_MAX_BYTES }) {
        this.volume = volume;
        this.root = root;
        this.store = store;
        this.maxBytes = maxBytes;
        this.vm = null;
        this.links = [];   // [{ id, path, name, handle, rootIno, base, needsPermission }]
        this.linking = new Set();   // workspace paths being linked now (their first copy runs)
        this._listeners = new Set();
        this._chain = Promise.resolve();
        this._queued = null;
    }

    setVM(vm) { this.vm = vm; }

    /** on('notice', (text, kind) => ...) for things the user should hear about;
     * on('change', () => ...) when the set of links or their state changed. */
    on(fn) { this._listeners.add(fn); }
    _emit(type, ...args) { for (const fn of this._listeners) fn(type, ...args); }

    async load() {
        try { this.links = (await this.store.all()) || []; } catch (e) { console.warn('links: could not load', e); this.links = []; }
        for (const link of this.links) link.needsPermission = !(await this._granted(link.handle, false));
        this._emit('change');
    }

    get needingPermission() { return this.links.filter((l) => l.needsPermission); }

    /** The link whose folder is exactly `path`, or null. */
    at(path) { return this.links.find((l) => l.path === path) || null; }

    /** The link that `path` is in or under, or null. */
    containing(path) { return this.links.find((l) => path === l.path || path.startsWith(`${l.path}/`)) || null; }

    async _granted(handle, ask) {
        // Handles that need no grant (the origin's private storage) have no API for it.
        if (!handle.queryPermission) return true;
        try {
            const opts = { mode: 'readwrite' };
            if ((await handle.queryPermission(opts)) === 'granted') return true;
            return ask ? (await handle.requestPermission(opts)) === 'granted' : false;
        } catch {
            return false;
        }
    }

    /** Ask again for the folders a reload left without permission. Needs a click. */
    async reconnect() {
        for (const link of this.needingPermission) link.needsPermission = !(await this._granted(link.handle, true));
        this._emit('change');
        await this.sync();
        return this.needingPermission.length === 0;
    }

    /**
     * Link a picked folder into the workspace folder `dir`, as dir/<its name>.
     * Call from a click: the permission request needs one.
     */
    async link(handle, dir) {
        if (!this.vm) throw new LinkError('The VM is still starting; link the folder once it runs.');
        if (!(await this._granted(handle, true))) throw new LinkError('The browser was not given access to that folder.');
        for (const l of this.links) {
            if (await handle.isSameEntry?.(l.handle)) throw new LinkError(`That folder is already linked at ${this.root}${l.path}.`);
        }
        if (this.containing(dir)) throw new LinkError('A folder can\'t be linked inside another linked folder.');

        const taken = new Set(((await this.vm.volumeList(this.volume, dir)) || []).map((e) => e.name));
        let name = handle.name;
        for (let n = 2; taken.has(name); n++) name = `${handle.name}-${n}`;
        const path = join(dir, name);

        // The folder appears at once, marked as being linked, while its files copy in.
        this.linking.add(path);
        try {
            await this.vm.volumeMkdir(this.volume, path);
            this._emit('change');
            return await this._firstCopy(handle, path);
        } catch (e) {
            // Nothing half-copied stays behind.
            if (!this.at(path)) await this.vm.volumeDelete(this.volume, path).catch(() => {});
            throw e;
        } finally {
            this.linking.delete(path);
            this._emit('change');
        }
    }

    async _firstCopy(handle, path) {
        const disk = await this._scanDisk(handle);
        const link = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, path, name: handle.name, handle, base: {} };
        for (const rel of disk.dirs) {
            await this.vm.volumeMkdir(this.volume, `${path}/${rel}`);
            link.base[rel] = { dir: true };
        }
        for (const [rel, f] of disk.files) {
            const bytes = new Uint8Array(await (await f.handle.getFile()).arrayBuffer());
            link.base[rel] = { d: diskSig(f), w: await this._putWs(link, rel, bytes), h: await hashOf(bytes) };
        }
        link.rootIno = (await this._wsEntry(path))?.ino;
        this.links.push(link);
        await this._save(link);
        await this.vm.volumeFlush?.(this.volume).catch(() => {});
        return { path, files: disk.files.size, bytes: disk.bytes };
    }

    /**
     * Bring every link up to date. Calls while one runs share the next run, so a
     * burst of actions costs at most two passes.
     */
    sync() {
        if (!this.links.length || !this.vm) return Promise.resolve();
        if (!this._queued) {
            this._queued = this._chain.then(() => { this._queued = null; return this._syncAll(); });
            this._chain = this._queued.catch(() => {});
        }
        return this._queued;
    }

    async _syncAll() {
        for (const link of [...this.links]) {
            if (link.needsPermission) continue;
            try {
                await this._syncOne(link);
            } catch (e) {
                if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
                    link.needsPermission = true;
                    this._emit('change');
                } else {
                    this._emit('notice', `Could not sync ${this.root}${link.path} with ${link.name} on your computer: ${e.message}`, 'problem');
                }
            }
        }
    }

    async _unlink(link) {
        this.links = this.links.filter((l) => l !== link);
        await this.store.delete(link.id).catch(() => {});
        this._emit('change');
    }

    async _save(link) {
        // needsPermission is this session's state, not the link's.
        const { needsPermission, ...stored } = link;
        await this.store.put(stored).catch((e) => console.warn('links: could not save', e));
    }

    /* ---- the two sides ---------------------------------------------------- */

    async _wsEntry(path) {
        const entries = await this.vm.volumeList(this.volume, parentOf(path));
        return entries?.find((e) => e.name === baseOf(path)) || null;
    }

    async _scanDisk(handle) {
        const files = new Map();
        const dirs = [];
        let bytes = 0;
        const walk = async (dir, prefix) => {
            for await (const [name, h] of dir.entries()) {
                const rel = prefix + name;
                if (h.kind === 'directory') {
                    dirs.push(rel);
                    await walk(h, `${rel}/`);
                } else {
                    const f = await h.getFile();
                    bytes += f.size;
                    if (bytes > this.maxBytes) {
                        throw new LinkError(`The folder holds more than ${megabytes(this.maxBytes)}, the most a linked folder can, `
                            + 'since the workspace keeps it in browser memory.');
                    }
                    files.set(rel, { size: f.size, lastModified: f.lastModified, handle: h });
                }
            }
        };
        await walk(handle, '');
        return { files, dirs, bytes };
    }

    async _scanWs(link) {
        const files = new Map();
        const dirs = [];
        const walk = async (rel) => {
            for (const e of (await this.vm.volumeList(this.volume, rel ? `${link.path}/${rel}` : link.path)) || []) {
                const r = rel ? `${rel}/${e.name}` : e.name;
                if (e.dir) { dirs.push(r); await walk(r); } else files.set(r, e);
            }
        };
        await walk('');
        return { files, dirs };
    }

    async _diskDir(handle, rel, create) {
        let dir = handle;
        for (const part of rel.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create });
        return dir;
    }

    async _readDisk(link, rel) {
        const dir = await this._diskDir(link.handle, relParent(rel), false);
        const file = await (await dir.getFileHandle(baseOf(rel))).getFile();
        return { bytes: new Uint8Array(await file.arrayBuffer()), sig: diskSig(file) };
    }

    async _writeDisk(link, rel, bytes) {
        const dir = await this._diskDir(link.handle, relParent(rel), true);
        const fh = await dir.getFileHandle(baseOf(rel), { create: true });
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
        return diskSig(await fh.getFile());
    }

    async _deleteDisk(link, rel) {
        try {
            const dir = await this._diskDir(link.handle, relParent(rel), false);
            await dir.removeEntry(baseOf(rel), { recursive: true });
        } catch (e) {
            if (e?.name !== 'NotFoundError') throw e;
        }
    }

    async _readWs(link, rel) {
        const bytes = await this.vm.volumeGetFile(this.volume, `${link.path}/${rel}`);
        if (!bytes) throw new Error(`${rel} went away during the sync`);
        return bytes;
    }

    /** Write into the workspace; returns the file's new workspace signature. */
    async _putWs(link, rel, bytes) {
        const path = `${link.path}/${rel}`;
        await this.vm.volumePutFile(this.volume, path, bytes);
        const e = await this._wsEntry(path);
        return e ? wsSig(e) : null;
    }

    /* ---- one pass --------------------------------------------------------- */

    async _syncOne(link) {
        const rootEntry = await this._wsEntry(link.path);
        if (!rootEntry || !rootEntry.dir || rootEntry.ino !== link.rootIno) {
            await this._unlink(link);
            this._emit('notice', `Unlinked ${this.root}${link.path}: it was deleted from the workspace. `
                + `The folder ${link.name} on your computer is unchanged.`, 'note');
            return;
        }
        let disk;
        try {
            disk = await this._scanDisk(link.handle);
        } catch (e) {
            if (e instanceof LinkError) { this._emit('notice', `Not syncing ${this.root}${link.path}: ${e.message}`, 'problem'); return; }
            throw e;
        }
        const ws = await this._scanWs(link);
        const base = link.base;
        const done = { pulled: 0, pushed: 0, deletedDisk: [], deletedWs: 0, conflicts: [] };
        const diskFiles = new Set(disk.files.keys());
        const wsFiles = new Set(ws.files.keys());
        const diskDirs = new Set(disk.dirs);
        const wsDirs = new Set(ws.dirs);
        const addParents = (set, rel) => { for (let p = relParent(rel); p; p = relParent(p)) set.add(p); };

        const rels = new Set([...diskFiles, ...wsFiles, ...Object.keys(base).filter((r) => !base[r].dir)]);
        for (const rel of [...rels].sort()) {
            const b = base[rel]?.dir ? null : base[rel];
            const d = disk.files.get(rel);
            const w = ws.files.get(rel);
            let dChanged = d ? !b || b.d !== diskSig(d) : !!b;
            let wChanged = w ? !b || b.w !== wsSig(w) : !!b;
            if (!dChanged && !wChanged) continue;

            // A moved signature with the same content is no change.
            let dBytes = null, wBytes = null, dHash = null, wHash = null;
            if (d && dChanged) {
                ({ bytes: dBytes } = await this._readDisk(link, rel));
                dHash = await hashOf(dBytes);
                if (b && dHash === b.h) { b.d = diskSig(d); dChanged = false; }
            }
            if (w && wChanged) {
                wBytes = await this._readWs(link, rel);
                wHash = await hashOf(wBytes);
                if (b && wHash === b.h) { b.w = wsSig(w); wChanged = false; }
            }
            if (!dChanged && !wChanged) continue;

            const pull = async () => {
                base[rel] = { d: diskSig(d), w: await this._putWs(link, rel, dBytes), h: dHash };
                wsFiles.add(rel); addParents(wsDirs, rel); done.pulled++;
            };
            const push = async () => {
                base[rel] = { d: await this._writeDisk(link, rel, wBytes), w: wsSig(w), h: wHash };
                diskFiles.add(rel); addParents(diskDirs, rel); done.pushed++;
            };

            if (dChanged && !wChanged) {
                if (d) await pull();
                else if (w) { await this.vm.volumeDelete(this.volume, `${link.path}/${rel}`); wsFiles.delete(rel); delete base[rel]; done.deletedWs++; }
                else delete base[rel];
            } else if (wChanged && !dChanged) {
                if (w) await push();
                else { if (d) { await this._deleteDisk(link, rel); diskFiles.delete(rel); done.deletedDisk.push(rel); } delete base[rel]; }
            } else if (d && w) {
                if (dHash === wHash) {
                    base[rel] = { d: diskSig(d), w: wsSig(w), h: dHash };
                } else {
                    // Both changed: the disk wins; keep the workspace's version beside it.
                    let name = `${rel}${CONFLICT_SUFFIX}`;
                    for (let n = 2; diskFiles.has(name) || wsFiles.has(name); n++) name = `${rel}${CONFLICT_SUFFIX}-${n}`;
                    base[name] = { d: await this._writeDisk(link, name, wBytes), w: await this._putWs(link, name, wBytes), h: wHash };
                    diskFiles.add(name); wsFiles.add(name);
                    await pull();
                    done.pulled--;
                    done.conflicts.push(rel);
                }
            } else if (d) {
                await pull();      // deleted in the workspace, changed on disk: keep the change
            } else if (w) {
                await push();      // deleted on disk, changed in the workspace: keep the change
            } else {
                delete base[rel];
            }
        }

        // Folders, deepest first, so a removed tree goes from the bottom up.
        const holds = (files, dirs, rel) => [...files].some((f) => f.startsWith(`${rel}/`))
            || [...dirs].some((x) => x.startsWith(`${rel}/`));
        const allDirs = new Set([...diskDirs, ...wsDirs, ...Object.keys(base).filter((r) => base[r].dir)]);
        for (const rel of [...allDirs].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
            const inD = diskDirs.has(rel);
            const inW = wsDirs.has(rel);
            const was = !!base[rel]?.dir;
            if (inD && inW) { base[rel] = { dir: true }; continue; }
            if (inD) {
                if (was && !holds(diskFiles, diskDirs, rel)) {
                    await this._deleteDisk(link, rel); diskDirs.delete(rel); delete base[rel]; done.deletedDisk.push(`${rel}/`);
                } else {
                    await this.vm.volumeMkdir(this.volume, `${link.path}/${rel}`); wsDirs.add(rel); base[rel] = { dir: true };
                }
            } else if (inW) {
                if (was && !holds(wsFiles, wsDirs, rel)) {
                    await this.vm.volumeDelete(this.volume, `${link.path}/${rel}`); wsDirs.delete(rel); delete base[rel];
                } else {
                    await this._diskDir(link.handle, rel, true); diskDirs.add(rel); base[rel] = { dir: true };
                }
            } else {
                delete base[rel];
            }
        }

        const changed = done.pulled || done.pushed || done.deletedDisk.length || done.deletedWs || done.conflicts.length;
        if (!changed) return;
        await this._save(link);
        if (done.deletedDisk.length) {
            const list = done.deletedDisk.slice(0, 5).join(', ') + (done.deletedDisk.length > 5 ? `, and ${done.deletedDisk.length - 5} more` : '');
            this._emit('notice', `Deleted from ${link.name} on your computer, as in ${this.root}${link.path}: ${list}.`, 'note');
        }
        for (const rel of done.conflicts) {
            this._emit('notice', `${rel} in ${this.root}${link.path} changed both on your computer and in the workspace. `
                + `The computer's version is in place; the workspace's is saved beside it as ${baseOf(rel)}${CONFLICT_SUFFIX}.`, 'note');
        }
    }
}
