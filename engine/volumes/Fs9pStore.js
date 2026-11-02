/*
 * Fs9pStore.js — an in-memory 9p filesystem tree, persisted to a StorageBackend.
 *
 * This is the JS half of the JS-backed 9p volume (see the C side in fs_js.c and
 * the js_fs_* bindings in web/js/lib.js). The whole volume lives in memory as a
 * path→node tree during a session; it is loaded from the backend BEFORE the VM
 * boots and flushed back at boundaries (stop, or an explicit flush()). Because
 * the live tree is in RAM, every js_fs_* call the guest makes is served
 * synchronously — no Asyncify, works on the main thread and in a worker.
 *
 * Suited to docker-like data volumes (config/state dirs, file exchange), not
 * multi-GB disks. For whole-disk persistence use the (planned) overlay block
 * device instead.
 *
 * Persistence format (single backend file, key IMAGE_KEY):
 *   [u32 headerLen LE][header JSON UTF-8][concatenated file data bytes]
 * header = { version, nextIno, entries:[{p,m,i,t,d,o,l}] }
 *   p=path m=mode i=ino t=mtime(s) d=isDir o=dataOffset l=dataLen
 */

'use strict';

import { IndexedDBBackend } from './backends/IndexedDBBackend.js';
import { OPFSBackend } from './backends/OPFSBackend.js';
import { FileSystemAccessBackend } from './backends/FileSystemAccessBackend.js';

// P9 mode type bits (must match fs.h).
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFMT  = 0xF000;

// P9 errno codes (negated on return; must match fs.h).
const ENOENT = 2, EIO = 5, EEXIST = 17, ENOTDIR = 20, EINVAL = 22, ENOTEMPTY = 39;

const IMAGE_KEY = '__fs9p_image__';

const BACKENDS = {
    indexeddb: IndexedDBBackend, idb: IndexedDBBackend,
    opfs: OPFSBackend,
    fsaccess: FileSystemAccessBackend, filesystem: FileSystemAccessBackend,
};

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

function nowSec() { return Math.floor(Date.now() / 1000); }
function dirOf(path) { const i = path.lastIndexOf('/'); return i <= 0 ? '/' : path.slice(0, i); }
function baseOf(path) { const i = path.lastIndexOf('/'); return path.slice(i + 1); }

export class Fs9pStore {
    /**
     * @param {string} name   volume name (the `js:<name>` in the cfg)
     * @param {object} backend an open StorageBackend (files interface)
     */
    constructor(name, backend) {
        this.name = name;
        this.backend = backend;
        this.vol = -1;              // handle assigned at registration
        this.tree = new Map();      // path -> node
        this.nextIno = 2;           // 1 reserved for root
        // Change counter, bumped on every content or mtime change and listed as a
        // node's `gen`, so a host-side sync sees edits that keep size and mtime
        // (mtime has 1 s resolution). Not persisted: it starts from the clock, so
        // gens from different sessions never compare equal.
        this._gen = Date.now() * 1000;
        this._dirty = false;
        this._initRoot();
    }

    /** Build a store (and its backend) from a volume spec. */
    static async fromSpec(spec) {
        const Ctor = BACKENDS[(spec.backend || 'indexeddb').toLowerCase()];
        if (!Ctor) throw new Error(`Fs9pStore: unknown backend ${spec.backend}`);
        const backend = new Ctor(spec.storageKey || spec.name, spec);
        await backend.open();
        const store = new Fs9pStore(spec.name, backend);
        await store.load();
        return store;
    }

    _initRoot() {
        this.tree.clear();
        this.tree.set('/', { mode: S_IFDIR | 0o755, ino: 1, mtime: nowSec(),
                             data: null, children: new Set() });
    }

    _node(path) { return this.tree.get(path) || null; }
    _isDir(node) { return (node.mode & S_IFMT) === S_IFDIR; }

    /* Sorted child-name list for a directory node, cached on the node.
     * The guest reads a directory one index at a time, so without this each
     * readdir() would re-spread and re-sort the whole Set — O(N^2 log N) to
     * list an N-entry dir. Invalidated via _touchDir() on any child add/remove. */
    _sortedChildren(node) {
        let s = node._sorted;
        if (!s) { s = [...node.children].sort(); node._sorted = s; }
        return s;
    }
    _touchDir(node) { if (node) node._sorted = null; }

    /* ---- persistence ------------------------------------------------- */

    async load() {
        let blob = null;
        try { blob = await this.backend.readFile(IMAGE_KEY); }
        catch { blob = null; }
        if (!blob || blob.length < 4) { this._initRoot(); return; }
        try { this._deserialize(blob); }
        catch (e) { console.error(`Fs9pStore(${this.name}) load failed:`, e); this._initRoot(); }
    }

    async flush() {
        if (!this._dirty) return;
        const blob = this._serialize();
        await this.backend.writeFile(IMAGE_KEY, blob);
        await this.backend.flush?.();
        this._dirty = false;
    }

    _serialize() {
        const entries = [];
        const datas = [];
        let off = 0;
        for (const [p, n] of this.tree) {
            const isDir = this._isDir(n);
            const l = (!isDir && n.data) ? n.data.length : 0;
            entries.push({ p, m: n.mode, i: n.ino, t: n.mtime, d: isDir ? 1 : 0, o: off, l });
            if (l) { datas.push(n.data); off += l; }
        }
        const header = JSON.stringify({ version: 1, nextIno: this.nextIno, entries });
        const headerBytes = TEXT_ENC.encode(header);
        const total = 4 + headerBytes.length + off;
        const out = new Uint8Array(total);
        new DataView(out.buffer).setUint32(0, headerBytes.length, true);
        out.set(headerBytes, 4);
        let p = 4 + headerBytes.length;
        for (const d of datas) { out.set(d, p); p += d.length; }
        return out;
    }

    _deserialize(blob) {
        const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        const headerLen = dv.getUint32(0, true);
        const header = JSON.parse(TEXT_DEC.decode(blob.subarray(4, 4 + headerLen)));
        const dataBase = 4 + headerLen;
        this.tree.clear();
        this.nextIno = header.nextIno || 2;
        for (const e of header.entries) {
            const node = { mode: e.m, ino: e.i, mtime: e.t, data: null, children: null, gen: this._gen };
            if (e.d) node.children = new Set();
            else node.data = e.l ? blob.slice(dataBase + e.o, dataBase + e.o + e.l) : new Uint8Array(0);
            this.tree.set(e.p, node);
        }
        // Rebuild children sets from the path list.
        if (!this.tree.has('/')) this._initRoot();
        for (const p of this.tree.keys()) {
            if (p === '/') continue;
            const parent = this.tree.get(dirOf(p));
            if (parent && parent.children) parent.children.add(baseOf(p));
        }
    }

    /* ---- synchronous ops called from lib.js -------------------------- */

    stat(path) {
        const n = this._node(path);
        if (!n) return null;
        return { mode: n.mode, ino: n.ino, mtime: n.mtime,
                 size: this._isDir(n) ? 0 : (n.data ? n.data.length : 0) };
    }

    /** Ordered directory entry by index, including "." and "..". */
    readdir(path, index) {
        const n = this._node(path);
        if (!n || !this._isDir(n)) return null;
        if (index === 0) return { name: '.', mode: n.mode, ino: n.ino };
        if (index === 1) {
            const parent = this._node(dirOf(path)) || n;
            return { name: '..', mode: parent.mode, ino: parent.ino };
        }
        const names = this._sortedChildren(n);
        const e = names[index - 2];
        if (e === undefined) return null;
        const child = this._node(path === '/' ? '/' + e : path + '/' + e);
        if (!child) return null;
        return { name: e, mode: child.mode, ino: child.ino };
    }

    read(path, offset, count) {
        const n = this._node(path);
        if (!n) return null;
        if (this._isDir(n)) return null;
        const data = n.data || new Uint8Array(0);
        const start = Math.min(offset, data.length);
        const end = Math.min(start + count, data.length);
        return data.subarray(start, end);
    }

    write(path, offset, src) {
        const n = this._node(path);
        if (!n || this._isDir(n)) return -EINVAL;
        const end = offset + src.length;
        let data = n.data || new Uint8Array(0);
        if (end > data.length) {
            const grown = new Uint8Array(end);
            grown.set(data, 0);
            data = grown;
        }
        data.set(src, offset);
        n.data = data;
        n.mtime = nowSec();
        n.gen = ++this._gen;
        this._dirty = true;
        return src.length;
    }

    create(path, mode, isDir) {
        if (this.tree.has(path)) return -EEXIST;
        const parentPath = dirOf(path);
        const parent = this._node(parentPath);
        if (!parent) return -ENOENT;
        if (!this._isDir(parent)) return -ENOTDIR;
        const typedMode = isDir ? ((mode & 0o7777) | S_IFDIR) : ((mode & 0o7777) | S_IFREG);
        const node = { mode: typedMode, ino: this.nextIno++, mtime: nowSec(),
                       data: isDir ? null : new Uint8Array(0),
                       children: isDir ? new Set() : null, gen: ++this._gen };
        this.tree.set(path, node);
        parent.children.add(baseOf(path));
        this._touchDir(parent);
        this._dirty = true;
        return 0;
    }

    truncate(path, size) {
        const n = this._node(path);
        if (!n || this._isDir(n)) return -EINVAL;
        const cur = n.data || new Uint8Array(0);
        if (size === cur.length) return 0;
        const next = new Uint8Array(size);
        next.set(cur.subarray(0, Math.min(size, cur.length)), 0);
        n.data = next;
        n.mtime = nowSec();
        n.gen = ++this._gen;
        this._dirty = true;
        return 0;
    }

    chmod(path, mode) {
        const n = this._node(path);
        if (!n) return -ENOENT;
        n.mode = (n.mode & S_IFMT) | (mode & 0o7777);
        this._dirty = true;
        return 0;
    }

    utime(path, mtime) {
        const n = this._node(path);
        if (!n) return -ENOENT;
        n.mtime = mtime > 0 ? Math.floor(mtime) : nowSec();
        n.gen = ++this._gen;
        this._dirty = true;
        return 0;
    }

    unlink(path) {
        const n = this._node(path);
        if (!n) return -ENOENT;
        if (this._isDir(n) && n.children.size > 0) return -ENOTEMPTY;
        const parent = this._node(dirOf(path));
        if (parent && parent.children) { parent.children.delete(baseOf(path)); this._touchDir(parent); }
        this.tree.delete(path);
        this._dirty = true;
        return 0;
    }

    /* ---- host-side helpers for live "hotplug" file injection --------- */

    _mkdirp(path) {
        if (path === '/' || this._node(path)) return;
        this._mkdirp(dirOf(path));
        this.create(path, 0o755, true);
    }

    /** Create/overwrite a file (making parent dirs). data: Uint8Array. */
    putFile(path, data) {
        this._mkdirp(dirOf(path));
        if (!this._node(path)) {
            const e = this.create(path, 0o644, false);
            if (e < 0 && e !== -EEXIST) return e;
        }
        const n = this._node(path);
        if (!n || this._isDir(n)) return -EINVAL;
        n.data = new Uint8Array(data);
        n.mtime = nowSec();
        n.gen = ++this._gen;
        this._dirty = true;
        return 0;
    }

    /** Read a whole file, or null if missing/dir. */
    getFile(path) {
        const n = this._node(path);
        if (!n || this._isDir(n)) return null;
        return n.data ? new Uint8Array(n.data) : new Uint8Array(0);
    }

    /** List a directory: [{ name, dir, size, mtime, ino, gen }] or null if not a dir. */
    listDir(path) {
        const n = this._node(path);
        if (!n || !this._isDir(n)) return null;
        return this._sortedChildren(n).map(name => {
            const c = this._node(path === '/' ? '/' + name : path + '/' + name);
            return { name, dir: this._isDir(c), size: (c && c.data) ? c.data.length : 0, mtime: c ? c.mtime : 0,
                     ino: c ? c.ino : 0, gen: c ? c.gen : 0 };
        });
    }

    /** Recursively remove a path (file or directory). */
    removePath(path) {
        const n = this._node(path);
        if (!n) return -ENOENT;
        if (this._isDir(n)) {
            for (const name of [...n.children])
                this.removePath(path === '/' ? '/' + name : path + '/' + name);
        }
        return this.unlink(path);
    }

    rename(from, to) {
        const n = this._node(from);
        if (!n) return -ENOENT;
        const toParent = this._node(dirOf(to));
        if (!toParent || !this._isDir(toParent)) return -ENOENT;

        const moves = [[from, to]];
        if (this._isDir(n)) {
            const prefix = from + '/';
            for (const p of this.tree.keys()) {
                if (p.startsWith(prefix)) moves.push([p, to + p.slice(from.length)]);
            }
        }
        // Remove any existing destination (POSIX rename replaces).
        if (this.tree.has(to)) this.unlink(to);
        for (const [src, dst] of moves) {
            const node = this.tree.get(src);
            this.tree.delete(src);
            this.tree.set(dst, node);
        }
        const oldParent = this._node(dirOf(from));
        if (oldParent && oldParent.children) { oldParent.children.delete(baseOf(from)); this._touchDir(oldParent); }
        toParent.children.add(baseOf(to));
        this._touchDir(toParent);
        this._dirty = true;
        return 0;
    }
}
