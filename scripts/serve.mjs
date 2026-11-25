#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * scripts/serve.mjs — dev server for the agent (no dependencies).
 *
 * Serves this repository (the folder above this one) statically: the page, and
 * jsLab and bash.js from the deps/ submodules. The engine and the distros aren't
 * served here: the page loads them from TinyEMU's and TinyEMU-distros' GitHub
 * Pages (js/distros.js).
 *
 * To try a local TinyEMU-distros build, --distro <build dir> serves its files
 * (one flat directory) at /distro/<name>/, <name> being the directory's name;
 * open the page with ?cfg=distro/<name>/config.cfg. It can be given more than
 * once. Binds to loopback unless --host says otherwise (--host 0.0.0.0 opens it
 * to the network).
 *
 *   node scripts/serve.mjs [--distro <build dir>] [--host <addr>] [port]
 *   then open http://localhost:8000/
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const USAGE = 'usage: node scripts/serve.mjs [--distro <TinyEMU-distros build dir>] [--distro ...] [--host <addr>] [port]';
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
/* name -> directory, for /distro/<name>/. */
const DISTRO_NAME = /^[\w-][\w.-]*$/;
const DISTROS = new Map();
for (let arg; (arg = option('--distro'));) {
    const dir = resolve(arg);
    const name = basename(dir);
    if (!DISTRO_NAME.test(name)) { console.error(`not a usable distro name: ${name}`); process.exit(2); }
    if (DISTROS.has(name)) { console.error(`two distros are named ${name}`); process.exit(2); }
    try { await fs.access(join(dir, 'config.cfg')); } catch {
        console.error(`no config.cfg in ${dir}; pass a TinyEMU-distros build/<name> directory\n${USAGE}`);
        process.exit(2);
    }
    DISTROS.set(name, dir);
}
const HOST = option('--host', process.env.HOST || '127.0.0.1');
const PORT = parseInt(args[0] || process.env.PORT || '8000', 10);
if (!Number.isInteger(PORT) || args.length > 1) { console.error(USAGE); process.exit(2); }

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8',
    '.cfg': 'text/plain; charset=utf-8',
};

function fail(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(text + '\n');
}

/* no-store: a rebuilt engine or edited page is never served stale. Last-Modified
 * lets a saved VM snapshot notice that the kernel or disk image changed. */
function sendFile(req, res, path, { size, mtime }, type) {
    res.writeHead(200, {
        'content-type': type,
        'content-length': size,
        'last-modified': mtime.toUTCString(),
        'cache-control': 'no-store',
    });
    return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res);
}

createServer(async (req, res) => {
    try {
        if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
        const { pathname } = new URL(req.url, 'http://localhost');

        const m = pathname.match(/^\/distro\/([^/]+)\/([^/]+)$/);
        if (m) {
            const dir = DISTROS.get(decodeURIComponent(m[1]));
            const name = decodeURIComponent(m[2]);
            // A distro is one flat directory.
            if (!dir || !DISTRO_NAME.test(name)) return fail(res, 404, 'not found');
            const file = join(dir, name);
            return sendFile(req, res, file, await fs.stat(file), MIME[extname(name)] || 'application/octet-stream');
        }

        let path = resolve(ROOT, '.' + decodeURIComponent(pathname));
        if (path !== ROOT && !path.startsWith(ROOT + sep)) return fail(res, 403, 'forbidden');
        if ((await fs.stat(path)).isDirectory()) path = join(path, 'index.html');
        return sendFile(req, res, path, await fs.stat(path), MIME[extname(path)] || 'application/octet-stream');
    } catch (e) {
        if (res.headersSent) return res.destroy();
        if (e.code === 'ENOENT') return fail(res, 404, 'not found');
        return fail(res, e.status || 502, e.message);
    }
}).listen(PORT, HOST, () => {
    console.log(`agent: http://localhost:${PORT}/`);
    for (const [name, dir] of DISTROS) console.log(`  distro ${name}: ${dir}, open http://localhost:${PORT}/?cfg=distro/${name}/config.cfg`);
    if (HOST === '127.0.0.1' || HOST === 'localhost') return;
    const lan = Object.values(networkInterfaces()).flat()
        .filter((a) => a.family === 'IPv4' && !a.internal)
        .map((a) => `http://${a.address}:${PORT}/`);
    console.log(`open to the network on ${HOST}:\n  ${lan.join('\n  ')}`);
});
