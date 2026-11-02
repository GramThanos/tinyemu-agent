/*
 * snapshot.js — save a running emulator instance and restore it into a fresh one.
 *
 * In the browser everything the machine is lives in one WebAssembly memory: guest
 * RAM, the CPU, every device, and the run loop's own state. So a snapshot is that
 * memory, plus the one piece of state lib.js keeps outside it: the file buffers
 * (Module.api.fbuf_table) where block_net.c holds downloaded disk blocks and the
 * guest's disk writes. Restoring copies both into a new instance of the SAME wasm
 * build (function pointers are table indices, so another build won't do) and
 * restarts the run loop with vm_restore (jsemu.c).
 *
 * It must be taken between run-loop ticks — any JS task is — with no I/O in
 * flight, since a pending download or disk request would never complete in the
 * restored instance. EmulatorEngine.snapshot() waits for that.
 *
 * Format, gzip-compressed:
 *   "TEMUSNP1"  u32 header length  header JSON (padded to 4 bytes)
 *   u32[pages]  indices of the 64 KB memory pages that are not all zero
 *   those pages, in order
 *   the file buffers, in header order
 */

'use strict';

const MAGIC = 'TEMUSNP1';
const PAGE = 65536;
export const SNAPSHOT_VERSION = 1;

/** True if the instance has I/O in flight that a snapshot would cut off. */
export function ioPending(api) {
    return Object.keys(api.wgetRequests?.instance || {}).length > 0 || (api.blk?.pending || 0) > 0;
}

/**
 * Copy the state out, synchronously, so the instance can run on while it is
 * compressed. The caller pauses the run loop around this.
 * @returns {{ header: object, parts: Uint8Array[] }}
 */
export function captureSnapshot(M, api, clockNs) {
    const heap = M.HEAPU8;
    const words = new Uint32Array(heap.buffer, 0, heap.length >>> 2);
    const pageWords = PAGE >>> 2;
    const indices = [];
    const pages = [];
    for (let p = 0, n = heap.length / PAGE; p < n; p++) {
        const start = p * pageWords;
        for (let i = start, end = start + pageWords; i < end; i++) {
            if (words[i] !== 0) {
                indices.push(p);
                pages.push(heap.slice(p * PAGE, (p + 1) * PAGE));
                break;
            }
        }
    }

    const fbuf = [];
    const fbufData = [];
    for (const [h, data] of Object.entries(api.fbuf_table || {})) {
        fbuf.push({ h: Number(h), len: data.length });
        fbufData.push(data.slice());
    }

    const header = {
        version: SNAPSHOT_VERSION,
        memSize: heap.length,
        pageSize: PAGE,
        pages: indices.length,
        clockNs,
        fbuf,
        fbufNext: api.fbuf_next_handle || 1,
    };
    return { header, parts: [Uint32Array.from(indices), ...pages, ...fbufData] };
}

/** Pack and gzip a capture into a Blob. */
export async function encodeSnapshot({ header, parts }) {
    let json = new TextEncoder().encode(JSON.stringify(header));
    const padded = new Uint8Array((json.length + 3) & ~3).fill(0x20);
    padded.set(json);
    json = padded;
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, json.length, true);
    const raw = new Blob([new TextEncoder().encode(MAGIC), len, json, ...parts]);
    return new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

/** Unpack a snapshot Blob. @returns {{ header, indices, pages, fbufBytes }} */
export async function decodeSnapshot(blob) {
    let buf;
    try {
        buf = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } catch {
        // A corrupt stream surfaces as a fetch-style TypeError ("Failed to fetch").
        throw new Error('the snapshot is damaged');
    }
    const u8 = new Uint8Array(buf);
    if (new TextDecoder().decode(u8.subarray(0, 8)) !== MAGIC) throw new Error('not a TinyEMU snapshot');
    const hlen = new DataView(buf).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hlen)));
    if (header.version !== SNAPSHOT_VERSION || header.pageSize !== PAGE) {
        throw new Error(`unsupported snapshot version ${header.version}`);
    }
    let off = 12 + hlen;
    const indices = new Uint32Array(buf, off, header.pages);
    off += header.pages * 4;
    const pages = u8.subarray(off, off + header.pages * PAGE);
    off += header.pages * PAGE;
    const fbufBytes = u8.subarray(off);
    return { header, indices, pages, fbufBytes };
}

/** Load a decoded snapshot into a fresh instance and start it running. */
export function applySnapshot(M, api, { header, indices, pages, fbufBytes }) {
    if (M.HEAPU8.length < header.memSize && !M._vm_reserve_memory(header.memSize)) {
        throw new Error(`could not grow memory to ${header.memSize} bytes`);
    }
    const heap = M.HEAPU8;   // after growing: the old view is detached
    heap.fill(0);
    for (let k = 0; k < indices.length; k++) {
        heap.set(pages.subarray(k * PAGE, (k + 1) * PAGE), indices[k] * PAGE);
    }

    const table = {};
    let off = 0;
    for (const { h, len } of header.fbuf) {
        table[h] = fbufBytes.slice(off, off + len);   // own copies: the decoded buffer can go
        off += len;
    }
    api.fbuf_table = table;
    api.fbuf_next_handle = header.fbufNext;

    M._vm_restore(header.clockNs);
}
