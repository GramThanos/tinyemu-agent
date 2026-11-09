/*
 * zip.js — build a .zip archive in memory, for downloading workspace folders.
 *
 * Files are deflated with the platform's CompressionStream('deflate-raw') when
 * there is one, and stored otherwise, or when deflating doesn't make them
 * smaller. No ZIP64: an archive must stay under 4 GB, far above what the
 * in-memory workspace can hold. Names are UTF-8 (general purpose bit 11).
 */

'use strict';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
        return null;   // a browser without deflate-raw
    }
}

/* MS-DOS date and time, local time, 2 s resolution. */
function dosTime(seconds) {
    const d = new Date((seconds || Date.now() / 1000) * 1000);
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/**
 * @param {{name: string, data?: Uint8Array, dir?: boolean, mtime?: number}[]} entries
 *        paths inside the archive, '/'-separated, no leading '/'; folders may
 *        be listed (dir: true) so empty ones are kept
 * @param {{onProgress?: (done:number, total:number) => void}} [o]
 * @returns {Promise<Blob>}
 */
export async function makeZip(entries, { onProgress } = {}) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    let i = 0;
    for (const e of entries) {
        const name = enc.encode(e.dir && !e.name.endsWith('/') ? `${e.name}/` : e.name);
        const data = e.dir ? new Uint8Array(0) : e.data || new Uint8Array(0);
        const crc = crc32(data);
        let method = 0;
        let body = data;
        if (data.length > 64) {
            const packed = await deflateRaw(data);
            if (packed && packed.length < data.length) { method = 8; body = packed; }
        }
        const { time, date } = dosTime(e.mtime);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);              // version needed: 2.0
        local.setUint16(6, 0x0800, true);          // UTF-8 names
        local.setUint16(8, method, true);
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, body.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        parts.push(new Uint8Array(local.buffer), name, body);

        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true);
        cd.setUint16(4, (3 << 8) | 20, true);      // made by: Unix, 2.0
        cd.setUint16(6, 20, true);
        cd.setUint16(8, 0x0800, true);
        cd.setUint16(10, method, true);
        cd.setUint16(12, time, true);
        cd.setUint16(14, date, true);
        cd.setUint32(16, crc, true);
        cd.setUint32(20, body.length, true);
        cd.setUint32(24, data.length, true);
        cd.setUint16(28, name.length, true);
        // Unix mode in the high half: a folder or a regular file, rwx for folders.
        cd.setUint32(38, ((e.dir ? 0o40755 : 0o100644) << 16) | (e.dir ? 0x10 : 0), true);
        cd.setUint32(42, offset, true);
        central.push(new Uint8Array(cd.buffer), name);

        offset += 30 + name.length + body.length;
        if (offset > 0xffffffff) throw new Error('the archive would be larger than 4 GB');
        onProgress?.(++i, entries.length);
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    if (entries.length > 0xffff) throw new Error('more than 65535 entries');
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
