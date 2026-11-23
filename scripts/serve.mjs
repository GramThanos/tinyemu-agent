#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * scripts/serve.mjs — dev server for the agent demo (no dependencies).
 *
 * Serves this repository (the folder above this one) statically (the page
 * loads jsLab and bash.js from the deps/ submodules, and the engine from
 * deps/jsLab/engine/), plus the guest image from a TinyEMU-distros build where
 * a release (scripts/build.mjs) puts it, next to the page:
 *   /distro/<name>/guest.cfg   the distro's config.cfg, made ready for the
 *                              agent (scripts/guest-config.mjs)
 *   /distro/<name>/<file>      the distro's files: a local build/<name>/
 *                              directory, or a published copy of one
 *                              (mirrored, so its host needs no CORS)
 *   /distro/index.json         the distros on offer, for the page's VM tab
 * <name> is the build directory's name, or --name (with one --distro). --distro
 * can be given more than once; the first is listed first. Mirrored files are
 * cached under .cache/. Binds to loopback unless --host says otherwise
 * (--host 0.0.0.0 opens it to the network).
 *
 *   node scripts/serve.mjs --distro <build dir or URL> [--distro ...] [--name <name>] [--host <addr>] [port]
 *   then open http://localhost:8000/
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distroEntry, guestConfigText } from './guest-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CACHE = join(ROOT, '.cache');

const USAGE = 'usage: node scripts/serve.mjs --distro <TinyEMU-distros build dir or URL> [--distro ...] [--name <name>] [--host <addr>] [port]';
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const DISTRO_ARGS = [];
for (let d; (d = option('--distro'));) DISTRO_ARGS.push(d);
if (!DISTRO_ARGS.length && process.env.AGENT_DISTRO) DISTRO_ARGS.push(process.env.AGENT_DISTRO);
const NAME_ARG = option('--name');
const HOST = option('--host', process.env.HOST || '127.0.0.1');
const PORT = parseInt(args[0] || process.env.PORT || '8000', 10);
if (!DISTRO_ARGS.length) { console.error(USAGE); process.exit(2); }
if (NAME_ARG && DISTRO_ARGS.length > 1) { console.error('--name goes with a single --distro'); process.exit(2); }

/* name -> { url } or { dir }, in the order given. */
const DISTROS = new Map();
for (const arg of DISTRO_ARGS) {
    const url = /^https?:\/\//.test(arg) ? arg.replace(/\/+$/, '') : null;
    const dir = url ? null : resolve(arg);
    // The page asks for distro/<name>/ (?distro=, its VM tab, else its default): name it to match.
    const name = NAME_ARG || basename(url ? new URL(url).pathname : dir);
    if (!/^[\w-][\w.-]*$/.test(name)) { console.error(`not a usable distro name: ${name}; pass --name`); process.exit(2); }
    if (DISTROS.has(name)) { console.error(`two distros are named ${name}`); process.exit(2); }
    if (dir) {
        try { await fs.access(join(dir, 'config.cfg')); } catch {
            console.error(`no config.cfg in ${dir}; pass a TinyEMU-distros build/<name> directory\n${USAGE}`);
            process.exit(2);
        }
    }
    DISTROS.set(name, { url, dir });
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8',
    '.cfg': 'text/plain; charset=utf-8',
};

// One in-flight upstream fetch per file; the emulator requests blocks concurrently.
const pending = new Map();

async function mirror(url) {
    const file = join(CACHE, createHash('sha256').update(url).digest('hex'));
    try {
        await fs.access(file);
        return file;
    } catch { /* not cached yet */ }
    if (pending.has(file)) return pending.get(file);
    const job = (async () => {
        const r = await fetch(url);
        if (!r.ok) throw Object.assign(new Error(`upstream ${r.status}`), { status: r.status });
        const body = new Uint8Array(await r.arrayBuffer());
        await fs.mkdir(CACHE, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, file);
        return file;
    })().finally(() => pending.delete(file));
    pending.set(file, job);
    return job;
}

/** Local path of a distro file, fetching it first when the distro is remote. */
async function distroFile(distro, name) {
    // A distro is one flat directory; this also keeps a URL distro from reaching
    // anything else on its host.
    if (!/^[\w-][\w.-]*$/.test(name)) throw Object.assign(new Error('not found'), { status: 404 });
    return distro.url ? mirror(`${distro.url}/${name}`) : join(distro.dir, name);
}

/* distro/index.json, as scripts/build.mjs writes it. */
async function distroIndex() {
    const distros = [];
    for (const [name, d] of DISTROS) distros.push(distroEntry(name, await fs.readFile(await distroFile(d, 'config.cfg'), 'utf8')));
    return `${JSON.stringify({ distros }, null, 2)}\n`;
}

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

        if (pathname === '/distro/index.json') {
            res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
            return res.end(req.method === 'HEAD' ? undefined : await distroIndex());
        }
        const m = pathname.match(/^\/distro\/([^/]+)\/([^/]+)$/);
        if (m) {
            const distro = DISTROS.get(decodeURIComponent(m[1]));
            if (!distro) return fail(res, 404, `this server has the distros ${[...DISTROS.keys()].join(', ')}`);
            const name = decodeURIComponent(m[2]);
            if (name === 'guest.cfg') {
                // Generated each time, as a release build writes it; Last-Modified
                // is config.cfg's, which the snapshot fingerprint then follows.
                const src = await distroFile(distro, 'config.cfg');
                const body = guestConfigText(await fs.readFile(src, 'utf8'), undefined, { base: distro.url });
                res.writeHead(200, {
                    'content-type': MIME['.cfg'], 'cache-control': 'no-store',
                    'last-modified': (await fs.stat(src)).mtime.toUTCString(),
                });
                return res.end(req.method === 'HEAD' ? undefined : body);
            }
            const file = await distroFile(distro, name);
            return sendFile(req, res, file, await fs.stat(file), 'application/octet-stream');
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
    for (const [name, d] of DISTROS) console.log(`  distro ${name}: ${d.url || d.dir}`);
    if (HOST === '127.0.0.1' || HOST === 'localhost') return;
    const lan = Object.values(networkInterfaces()).flat()
        .filter((a) => a.family === 'IPv4' && !a.internal)
        .map((a) => `http://${a.address}:${PORT}/`);
    console.log(`open to the network on ${HOST}:\n  ${lan.join('\n  ')}`);
});
