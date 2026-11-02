/*
 * VolumeManager.js — provisions Docker-like volumes and overlay images backed
 * by browser storage, and tracks which volumes belong to which VM.
 *
 * A volume spec:
 *   {
 *     name:       'data',                 // unique per VM
 *     backend:    'indexeddb'|'opfs'|'fsaccess',
 *     type:       'files'|'block',        // files = 9p mount, block = overlay disk
 *     mountpoint: '/mnt/data',            // guest path (files) — applied at boot
 *     sizeMB:     256,                    // block images only
 *     baseUrl:    'distro/rootfs.img',    // overlay base image (block, optional)
 *     dirHandle:  <FileSystemDirectoryHandle>,  // fsaccess, optional pre-grant
 *   }
 *
 * NOTE: This provisions and manages the *browser-side* storage. Making the guest
 * actually see it (mount the 9p share / attach the overlay disk) needs the
 * C-side bridge described in plan-c-changes.md; the mount metadata here is what
 * that bridge will consume.
 */

'use strict';

import { IndexedDBBackend } from './backends/IndexedDBBackend.js';
import { OPFSBackend } from './backends/OPFSBackend.js';
import { FileSystemAccessBackend } from './backends/FileSystemAccessBackend.js';

export class VolumeMount {
    constructor(vmId, spec, backend) {
        this.vmId = vmId;
        this.name = spec.name;
        this.type = spec.type || (backend.supports('block') && spec.sizeMB ? 'block' : 'files');
        this.mountpoint = spec.mountpoint || null;
        this.baseUrl = spec.baseUrl || null;
        this.backend = backend;
    }
    toJSON() {
        return { name: this.name, type: this.type, mountpoint: this.mountpoint,
                 backend: this.backend.name, persistent: this.backend.capabilities.persistent };
    }
}

const BACKENDS = {
    indexeddb: IndexedDBBackend,
    idb: IndexedDBBackend,
    opfs: OPFSBackend,
    fsaccess: FileSystemAccessBackend,
    filesystem: FileSystemAccessBackend,
};

export class VolumeManager {
    constructor(options = {}) {
        this.options = options;
        this.mounts = new Map();     // vmId -> VolumeMount[]
    }

    /** Build (but don't open) a backend for a spec. */
    createBackend(spec) {
        const Ctor = BACKENDS[(spec.backend || 'indexeddb').toLowerCase()];
        if (!Ctor) throw new Error(`unknown volume backend: ${spec.backend}`);
        // Namespace storage per spec.name to avoid collisions across VMs/volumes.
        return new Ctor(spec.storageKey || spec.name, spec);
    }

    /** Provision volumes for a VM. Returns an array of open VolumeMount. */
    async attach(vmId, specs) {
        const mounts = [];
        for (const spec of specs) {
            const backend = this.createBackend(spec);
            await backend.open();
            const mount = new VolumeMount(vmId, spec, backend);

            // For an overlay whose base is an HTTP image, we could pre-seed the
            // sparse store here; leave that to the C bridge which streams the
            // base on read-miss. (See plan-c-changes.md.)
            mounts.push(mount);
        }
        this.mounts.set(vmId, mounts);
        return mounts;
    }

    get(vmId) { return this.mounts.get(vmId) || []; }

    async detach(vmId) {
        for (const m of this.get(vmId)) {
            try { await m.backend.flush(); await m.backend.close(); } catch {}
        }
        this.mounts.delete(vmId);
    }

    getStatus() {
        const out = {};
        for (const [vmId, mounts] of this.mounts) out[vmId] = mounts.map(m => m.toJSON());
        return out;
    }
}
