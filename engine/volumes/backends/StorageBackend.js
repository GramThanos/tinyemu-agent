/*
 * StorageBackend.js — common async interface for volume storage.
 *
 * Two access styles share one interface; a backend implements whichever it can:
 *
 *   Block (for OVERLAY / whole-disk images, virtio-block):
 *     getSectorCount()            -> number of `sectorSize`-byte sectors
 *     readSectors(sector, count)  -> Uint8Array
 *     writeSectors(sector, data)  -> void
 *
 *   Files (for DOCKER-LIKE volumes mapped to a guest path, virtio-9p):
 *     readFile(path)   -> Uint8Array | null
 *     writeFile(path, data)
 *     unlink(path)
 *     list(path)       -> [{ name, dir, size }]
 *     stat(path)       -> { size, dir, mtime } | null
 *
 * All methods are async. `flush()` persists any buffered writes; `close()`
 * releases handles. Capability flags let callers pick a suitable backend.
 */

'use strict';

export const SECTOR_SIZE = 512;

export class StorageBackend {
    constructor(name, options = {}) {
        this.name = name;
        this.sectorSize = options.sectorSize || SECTOR_SIZE;
        this.capabilities = { block: false, files: false, persistent: true };
    }

    async open() { throw new Error('open() not implemented'); }
    async close() {}
    async flush() {}

    // --- block ---
    async getSectorCount() { throw new Error(`${this.name}: block not supported`); }
    async readSectors() { throw new Error(`${this.name}: block not supported`); }
    async writeSectors() { throw new Error(`${this.name}: block not supported`); }

    // --- files ---
    async readFile() { throw new Error(`${this.name}: files not supported`); }
    async writeFile() { throw new Error(`${this.name}: files not supported`); }
    async unlink() { throw new Error(`${this.name}: files not supported`); }
    async list() { throw new Error(`${this.name}: files not supported`); }
    async stat() { throw new Error(`${this.name}: files not supported`); }

    supports(cap) { return !!this.capabilities[cap]; }
}
