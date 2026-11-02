/*
 * OverlayBlockStore.js — copy-on-write block device: read-only HTTP base image
 * + a writable JS overlay. Lets a VM boot the normal distro disk yet keep every
 * write across reboots.
 *
 * It exposes the same interface the engine's block path expects
 * (getSectorCount / readSectors / writeSectors / flush), so it drops into
 * Module.api.blk.list[vol] exactly like a plain backend — the C device
 * (block_js.c) and the js_block_* bindings are unchanged.
 *
 * Semantics: a per-sector dirty bitmap records which sectors live in the
 * overlay. read = overlay for dirty sectors, HTTP base for clean ones (grouped
 * into contiguous runs); write = overlay only, marking sectors dirty. The
 * bitmap persists in the overlay backend (files interface) so dirtiness
 * survives reloads.
 *
 * The HTTP base uses TinyEMU's split-image format (see block_net.c): a JSON
 * descriptor { block_size: <KB>, n_block } beside `blk%09u.bin` block files,
 * each block_size*512 bytes.
 */

'use strict';

const SECTOR = 512;
const BITMAP_KEY = '__overlay_bitmap__';

export class OverlayBlockStore {
    /**
     * @param {object} o
     * @param {number} o.sectorCount   total sectors (from the base image)
     * @param {(sector:number,count:number)=>Promise<Uint8Array>} o.readBase
     * @param {object} o.overlay       an open StorageBackend (block + files)
     */
    constructor({ sectorCount, readBase, overlay }) {
        this.name = overlay?.name;
        this.sectorCount = sectorCount;
        this.readBase = readBase;
        this.overlay = overlay;
        this.bitmap = new Uint8Array((sectorCount + 7) >> 3);
        this._bitmapDirty = false;
    }

    async open() {
        try {
            const saved = await this.overlay.readFile?.(BITMAP_KEY);
            if (saved && saved.length === this.bitmap.length) this.bitmap.set(saved);
        } catch { /* no saved bitmap yet */ }
    }

    async getSectorCount() { return this.sectorCount; }

    _isDirty(s) { return (this.bitmap[s >> 3] >> (s & 7)) & 1; }
    _setDirty(s) { this.bitmap[s >> 3] |= (1 << (s & 7)); }

    async readSectors(sector, count) {
        const out = new Uint8Array(count * SECTOR);
        let i = 0;
        while (i < count) {
            const dirty = this._isDirty(sector + i);
            // extend a run of same-dirtiness sectors to batch the I/O
            let run = 1;
            while (i + run < count && this._isDirty(sector + i + run) === dirty) run++;
            const src = dirty
                ? await this.overlay.readSectors(sector + i, run)
                : await this.readBase(sector + i, run);
            out.set(src.subarray(0, run * SECTOR), i * SECTOR);
            i += run;
        }
        return out;
    }

    async writeSectors(sector, data) {
        const n = Math.floor(data.length / SECTOR);
        await this.overlay.writeSectors(sector, data);
        for (let i = 0; i < n; i++) this._setDirty(sector + i);
        this._bitmapDirty = true;
    }

    async flush() {
        await this.overlay.flush?.();
        if (this._bitmapDirty) {
            await this.overlay.writeFile?.(BITMAP_KEY, this.bitmap);
            this._bitmapDirty = false;
        }
    }
}

/**
 * Build an HTTP base reader from a TinyEMU split-image descriptor URL.
 * Returns { sectorCount, blockSizeSectors, readBase }. Block files are fetched
 * on demand and LRU-cached; `readBase(sector, count)` assembles the range.
 */
export async function makeHttpBase(descUrl, options = {}) {
    const cacheMax = options.blockCache || 64;
    const r = await fetch(descUrl, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`base descriptor ${descUrl}: HTTP ${r.status}`);
    const desc = await r.json();
    const blockSizeSectors = (desc.block_size | 0) * 2;      // block_size is in KB
    const nBlocks = desc.n_block | 0;
    if (blockSizeSectors <= 0 || nBlocks <= 0) throw new Error('invalid base descriptor');
    const sectorCount = blockSizeSectors * nBlocks;
    const dir = descUrl.slice(0, descUrl.lastIndexOf('/') + 1);

    const cache = new Map();   // blockNum -> Uint8Array
    async function fetchBlock(blockNum) {
        const hit = cache.get(blockNum);
        if (hit) return hit;
        const name = dir + 'blk' + String(blockNum).padStart(9, '0') + '.bin';
        const resp = await fetch(name, { cache: 'force-cache' });
        if (!resp.ok) throw new Error(`base block ${blockNum}: HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        cache.set(blockNum, buf);
        if (cache.size > cacheMax) cache.delete(cache.keys().next().value);
        return buf;
    }

    async function readBase(sector, count) {
        const out = new Uint8Array(count * SECTOR);
        let i = 0;
        while (i < count) {
            const s = sector + i;
            const blockNum = Math.floor(s / blockSizeSectors);
            const off = s % blockSizeSectors;
            const n = Math.min(count - i, blockSizeSectors - off);
            const block = await fetchBlock(blockNum);
            out.set(block.subarray(off * SECTOR, (off + n) * SECTOR), i * SECTOR);
            i += n;
        }
        return out;
    }

    return { sectorCount, blockSizeSectors, readBase };
}
