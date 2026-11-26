// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * vite.config.js — the page's build (vite build → dist/) and dev server (vite).
 *
 * The site is the page, bundled: React, the agent's modules (js/, src/), jsLab's
 * runtime and bash.js from the deps/ submodules, and jsLab's VM worker as its own
 * chunk. The engine and the guest images are not in it: the page loads them from
 * TinyEMU's and TinyEMU-distros' GitHub Pages (js/distros.js). `base: './'` makes
 * every URL relative, so the same build works at any path (GitHub Pages serves it
 * under /tinyemu-agent/).
 *
 * The `tinyemu-agent` plugin below adds what the old scripts did:
 *   dev:   no-store caching, and local TinyEMU-distros builds at /distro/<name>/
 *          (TINYEMU_DISTROS=<build dir>[:<build dir>…], ; on Windows), for ?cfg=;
 *   build: build-info.json, README.md (scripts/release-README.md), LICENSE, the
 *          parts' licences in LICENSES/, .nojekyll, and the page's CSP (CSP below).
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEPS = join(ROOT, 'deps');
const NAME = /^[\w-][\w.-]*$/;   // distro and file names: one flat directory, no ..

/* The built page's Content-Security-Policy, as a <meta> (GitHub Pages sets no
 * headers). Scripts only from the page and the pinned CDNs its SDKs load from
 * (js/providers/claude.js, webllm.js), so an injected script can't load more.
 * Requests go anywhere over http(s): models, MCP servers and local servers are
 * the user's to choose. The engine's `new Function` runs in jsLab's worker, which
 * this doesn't cover; WebLLM needs 'wasm-unsafe-eval'. Not in the dev server,
 * whose React refresh needs an inline script. */
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://esm.sh https://esm.run https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
    "connect-src 'self' https: http: data: blob:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

function gitState(dir) {
    try {
        const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
        return { commit, dirty };
    } catch {
        return { commit: null, dirty: null };
    }
}
/* A constant js/distros.js sets: the engine release and the distros' Pages. */
const pageConstant = (name) => readFileSync(join(ROOT, 'js', 'distros.js'), 'utf8')
    .match(new RegExp(`export const ${name} = '([^']*)'`))?.[1] ?? null;

/* Local distro builds for the dev server: name -> directory. */
function localDistros() {
    const map = new Map();
    for (const arg of (process.env.TINYEMU_DISTROS || '').split(delimiter).filter(Boolean)) {
        const dir = resolve(arg);
        const name = basename(dir);
        if (!NAME.test(name)) throw new Error(`TINYEMU_DISTROS: not a usable distro name: ${name}`);
        if (!existsSync(join(dir, 'config.cfg'))) throw new Error(`TINYEMU_DISTROS: no config.cfg in ${dir}`);
        map.set(name, dir);
    }
    return map;
}

function tinyemuAgent() {
    return {
        name: 'tinyemu-agent',
        configureServer(server) {
            const distros = localDistros();
            for (const [name, dir] of distros) server.config.logger.info(`  distro ${name}: ${dir} at /distro/${name}/`);
            server.middlewares.use((req, res, next) => {
                // The in-app browser kept stale modules with no-cache.
                res.setHeader('Cache-Control', 'no-store');
                const m = /^\/distro\/([^/]+)\/([^/?#]+)/.exec(req.url || '');
                if (!m) return next();
                const dir = distros.get(m[1]);
                const file = decodeURIComponent(m[2]);
                if (!dir || !NAME.test(file)) { res.statusCode = 404; res.end('not found'); return; }
                const path = join(dir, file);
                let st;
                try { st = statSync(path); } catch { st = null; }
                if (!st?.isFile()) { res.statusCode = 404; res.end('not found'); return; }
                // Snapshot fingerprints follow a local distro's files by Last-Modified.
                res.setHeader('Last-Modified', st.mtime.toUTCString());
                res.setHeader('Content-Length', String(st.size));
                res.setHeader('Content-Type', file.endsWith('.cfg') ? 'text/plain; charset=utf-8' : 'application/octet-stream');
                createReadStream(path).pipe(res);
            });
        },
        transformIndexHtml: {
            order: 'post',
            handler(html, ctx) {
                if (ctx.server) return html;
                return html.replace('<meta charset="utf-8">',
                    `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
            },
        },
        generateBundle() {
            const info = {
                source: 'https://github.com/GramThanos/tinyemu-agent',
                ...gitState(ROOT),
                built: new Date().toISOString(),
                engine: pageConstant('ENGINE'),
                distros: pageConstant('DISTROS_PAGES'),
                deps: Object.fromEntries(['jsLab', 'bash.js', 'TinyEMU', 'TinyEMU-distros']
                    .map((n) => [n, existsSync(join(DEPS, n, '.git')) ? gitState(join(DEPS, n)).commit : null])),
            };
            const emit = (fileName, source) => this.emitFile({ type: 'asset', fileName, source });
            emit('build-info.json', `${JSON.stringify(info, null, 2)}\n`);
            emit('README.md', readFileSync(join(ROOT, 'scripts', 'release-README.md'), 'utf8')
                .replaceAll('{{engine}}', info.engine || 'unknown')
                .replaceAll('{{commit}}', info.commit ? `${info.commit.slice(0, 12)}${info.dirty ? ' (with uncommitted changes)' : ''}` : 'unknown'));
            emit('LICENSE', readFileSync(join(ROOT, 'LICENSE')));
            // The parts' own licences: everything here is in the bundle.
            const mod = (name) => join(ROOT, 'node_modules', name, 'LICENSE');
            for (const [name, file] of [
                ['jsLab', join(DEPS, 'jsLab', 'LICENSE')], ['bash.js', join(DEPS, 'bash.js', 'LICENSE')],
                ['react', mod('react')], ['react-dom', mod('react-dom')], ['scheduler', mod('scheduler')],
                ['xterm', mod('@xterm/xterm')], ['xterm-addon-fit', mod('@xterm/addon-fit')], ['showdown', mod('showdown')],
            ]) {
                if (!existsSync(file)) this.error(`no ${file}: run git submodule update --init, and npm install`);
                emit(`LICENSES/${name}.txt`, readFileSync(file));
            }
            emit('.nojekyll', '');
        },
    };
}

export default defineConfig({
    base: './',
    plugins: [react(), tinyemuAgent()],
    // jsLab's VM worker imports modules, so it is built as one.
    worker: { format: 'es' },
    server: { port: 8000, strictPort: false },
    preview: { port: 8000 },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
