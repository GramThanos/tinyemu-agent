#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * build.mjs — assemble the agent as a static site, for GitHub Pages or any host.
 *
 *   node scripts/build.mjs --distro <TinyEMU-distros build/<name> dir> [--distro ...] --out <dir> [--name <name>]
 *
 * The output is the deployed site (GitHub Pages; .github/workflows/deploy.yml):
 *   index.html, js/       the page
 *   engine/               the parts of jsLab (deps/jsLab/lib/) the page loads,
 *                         with the engine (deps/jsLab/engine/: run
 *                         deps/jsLab/scripts/fetch-engine.mjs first)
 *   vendor/bash.js        bash.js (deps/bash.js)
 *   distro/<name>/        the distro's kernel, config and disk chunks, plus the
 *                         agent's guest.cfg (scripts/guest-config.mjs); one
 *                         per --distro, the first the page's default
 *   distro/index.json     the distros, for the page's VM tab
 *   README.md, LICENSE, LICENSES/ (the parts' licences), build-info.json, .nojekyll
 *
 * What is copied is the page's import closure (static imports, import() and
 * new URL('…', …)), followed from index.html, so a new module needs no change
 * here. Relative specifiers are rewritten for the new layout, and the closure of
 * the output is checked again. rootfs.ext2 is left out: the chunks hold the disk.
 *
 * --out is emptied first, except .git and CNAME. To guard against a typo, it must
 * be empty, a git checkout, or an earlier build (it has build-info.json). The
 * usual place is _site/ (git-ignored).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distroEntry, guestConfigText } from './guest-config.mjs';

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPS = join(AGENT, 'deps');
const JSLAB = join(DEPS, 'jsLab');
const LIB = join(JSLAB, 'lib');
const ENGINE = join(JSLAB, 'engine');
const BASHJS = join(DEPS, 'bash.js');
const REPO = AGENT;
const inside = (dir, p) => p === dir || p.startsWith(dir + sep);
const KEEP = new Set(['.git', 'CNAME']);

const USAGE = 'usage: node scripts/build.mjs --distro <TinyEMU-distros build/<name> dir> [--distro ...] --out <dir> [--name <name>]';
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const distroDirs = [];
for (let d; (d = option('--distro'));) distroDirs.push(d);
const outArg = option('--out');
const nameArg = option('--name');
if (!distroDirs.length || !outArg || args.length) { console.error(USAGE); process.exit(2); }
const OUT = resolve(outArg);
const die = (msg) => { console.error(`build: ${msg}`); process.exit(1); };
if (nameArg && distroDirs.length > 1) die('--name goes with a single --distro');
const distros = distroDirs.map((dir) => ({ dir, name: nameArg || basename(resolve(dir)) }));
for (const { name } of distros) if (!/^[\w-][\w.-]*$/.test(name)) die(`not a usable distro name: ${name}`);
if (new Set(distros.map((d) => d.name)).size !== distros.length) die('two distros have the same name');
const distroName = distros[0].name;   // the page's default
if (OUT === AGENT || AGENT.startsWith(OUT + sep) || inside(DEPS, OUT)) die(`refusing to build into ${OUT}`);
for (const f of [join(LIB, 'vm', 'index.js'), join(ENGINE, 'x86emu-wasm.wasm'), join(BASHJS, 'bash.js')]) {
    try { await fs.access(f); } catch {
        die(`no ${relative(AGENT, f)}: run git submodule update --init, then node deps/jsLab/scripts/fetch-engine.mjs`);
    }
}

/* ---- where each source file goes ------------------------------------------- */

function target(src) {
    // The deployed layout predates the submodules: jsLab's lib/ and the engine
    // share engine/, bash.js is vendor/. Keeping it keeps saved snapshots valid.
    if (inside(LIB, src)) return join(OUT, 'engine', relative(LIB, src));
    if (inside(ENGINE, src)) return join(OUT, 'engine', relative(ENGINE, src));
    if (inside(BASHJS, src)) return join(OUT, 'vendor', relative(BASHJS, src));
    if (inside(DEPS, src)) return die(`the page loads ${relative(AGENT, src)}, which the build doesn't place`);
    if (inside(AGENT, src)) return join(OUT, relative(AGENT, src));
    return die(`the page loads ${src}, outside this repository`);
}

/* Relative specifiers in code, skipping comment lines (examples and JSDoc types
 * there name files that need not exist). */
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bnew URL\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
function rewrite(text, from, map) {
    return text.split('\n').map((line) => {
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return line;
        return line.replace(SPEC, (all, lead, q, spec) => {
            const dep = resolve(dirname(from), spec);
            const to = map(dep);
            if (to === null) return all;
            let rel = posix.normalize(relative(dirname(map(from)), to).split(sep).join('/'));
            if (!rel.startsWith('.')) rel = `./${rel}`;
            return `${lead}${q}${rel}${q}`;
        });
    }).join('\n');
}
const specsOf = (text, from) => text.split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .flatMap((line) => [...line.matchAll(SPEC)].map((m) => resolve(dirname(from), m[3])));

/* ---- the page's closure ----------------------------------------------------- */

async function closure(entry) {
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
        const f = queue.shift();
        if (!/\.(html|m?js)$/.test(f)) continue;
        for (const dep of specsOf(await fs.readFile(f, 'utf8'), f)) {
            if (seen.has(dep)) continue;
            try { await fs.access(dep); } catch { die(`${relative(REPO, f)} loads ${relative(REPO, dep)}, which doesn't exist`); }
            seen.add(dep);
            queue.push(dep);
        }
    }
    return [...seen].sort();
}

/* ---- out directory ---------------------------------------------------------- */

async function prepareOut() {
    let entries = [];
    try { entries = await fs.readdir(OUT); } catch { await fs.mkdir(OUT, { recursive: true }); }
    const ours = entries.length === 0 || entries.includes('.git') || entries.includes('build-info.json');
    if (!ours) die(`${OUT} is not empty, a git checkout or an earlier build; not touching it`);
    for (const e of entries) if (!KEEP.has(e)) await fs.rm(join(OUT, e), { recursive: true, force: true });
}

async function put(path, data) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, data);
}

function gitState(dir) {
    try {
        const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
        return { commit, dirty };
    } catch {
        return { commit: null, dirty: null };
    }
}
async function engineVersion() {
    try { return (await fs.readFile(join(ENGINE, 'VERSION'), 'utf8')).trim(); } catch { return null; }
}

/* ---- build ------------------------------------------------------------------ */

for (const d of distros) {
    const distroFiles = await fs.readdir(d.dir).catch(() => die(`no such directory: ${d.dir}`));
    for (const need of ['config.cfg', 'kernel.bin', 'blk.txt']) {
        if (!distroFiles.includes(need)) die(`${d.dir} has no ${need}; is it a TinyEMU-distros build directory?`);
    }
    d.firmware = distroFiles.includes('bios.bin') ? ['bios.bin'] : [];   // RISC-V's OpenSBI
    // Raw chunks are blkN.bin; with "compression": "gzip" they are blkN.bin.gz.
    const { n_block: blocks, compression = 'none' } = JSON.parse(await fs.readFile(join(d.dir, 'blk.txt'), 'utf8'));
    if (compression !== 'none' && compression !== 'gzip') die(`${d.dir}/blk.txt: unknown compression ${compression}`);
    const chunkName = compression === 'gzip' ? /^blk\d+\.bin\.gz$/ : /^blk\d+\.bin$/;
    d.compression = compression;
    d.chunks = distroFiles.filter((f) => chunkName.test(f)).sort();
    if (d.chunks.length !== blocks) die(`blk.txt lists ${blocks} ${compression === 'gzip' ? 'gzip ' : ''}chunks, ${d.chunks.length} found in ${d.dir}`);
}

const files = await closure(join(AGENT, 'index.html'));
const outOf = new Map(files.map((f) => [f, target(f)]));
const map = (dep) => outOf.get(dep) ?? null;

await prepareOut();
for (const f of files) {
    if (/\.(html|m?js)$/.test(f)) await put(outOf.get(f), rewrite(await fs.readFile(f, 'utf8'), f, map));
    else await put(outOf.get(f), await fs.readFile(f));
}

const index = [];
for (const d of distros) {
    const distroOut = join(OUT, 'distro', d.name);
    d.bytes = 0;
    for (const f of ['config.cfg', 'kernel.bin', ...d.firmware, 'blk.txt', ...d.chunks]) {
        const data = await fs.readFile(join(d.dir, f));
        d.bytes += data.length;
        await put(join(distroOut, f), data);
    }
    const cfg = await fs.readFile(join(d.dir, 'config.cfg'), 'utf8');
    await put(join(distroOut, 'guest.cfg'), guestConfigText(cfg));
    index.push(distroEntry(d.name, cfg));
}
// The machines the page's VM tab offers.
await put(join(OUT, 'distro', 'index.json'), `${JSON.stringify({ distros: index }, null, 2)}\n`);

// The page boots this distro unless ?distro= says otherwise.
const page = await fs.readFile(join(OUT, 'index.html'), 'utf8');
if (!page.includes(`DEFAULT_DISTRO = '${distroName}'`)) {
    console.warn(`build: note: the page's default distro is not ${distroName}; open it with ?distro=${distroName}`);
}

const wasm = await fs.readFile(join(ENGINE, 'x86emu-wasm.wasm'));
const info = {
    source: 'https://github.com/GramThanos/tinyemu-agent',
    ...gitState(AGENT),
    built: new Date().toISOString(),
    engineSha256: createHash('sha256').update(wasm).digest('hex'),
    engine: await engineVersion(),
    deps: Object.fromEntries(['jsLab', 'bash.js', 'TinyEMU', 'TinyEMU-distros']
        .map((n) => [n, existsSync(join(DEPS, n, '.git')) ? gitState(join(DEPS, n)).commit : null])),  // a submodule has its own .git
    distro: { name: distroName, from: basename(resolve(distros[0].dir)), chunks: distros[0].chunks.length, bytes: distros[0].bytes },
    distros: distros.map((d) => ({ name: d.name, from: basename(resolve(d.dir)), chunks: d.chunks.length, compression: d.compression, bytes: d.bytes })),
};
await put(join(OUT, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
const readme = (await fs.readFile(join(AGENT, 'scripts', 'release-README.md'), 'utf8'))
    .replaceAll('{{distroArgs}}', distros.map((d) => `--distro <TinyEMU-distros build/${d.name} directory>`).join(' '))
    .replaceAll('{{distroRows}}', distros.map((d) => `| \`distro/${d.name}/\` | ${index.find((e) => e.name === d.name).label}: kernel, ${d.firmware.length ? 'OpenSBI firmware, ' : ''}disk (as ${d.compression === 'gzip' ? 'gzipped ' : ''}chunks) and the VM config |`).join('\n'))
    .replaceAll('{{distroNames}}', distros.map((d) => `\`${d.name}\``).join(', '))
    .replaceAll('{{distro}}', distroName)
    .replaceAll('{{commit}}', info.commit ? `${info.commit.slice(0, 12)}${info.dirty ? ' (with uncommitted changes)' : ''}` : 'unknown');
await put(join(OUT, 'README.md'), readme);
await put(join(OUT, 'LICENSE'), await fs.readFile(join(REPO, 'LICENSE')));
// The parts' own licences: the engine is TinyEMU's (MIT), the runtime jsLab's.
for (const [name, file] of [['jsLab', join(JSLAB, 'LICENSE')], ['bash.js', join(BASHJS, 'LICENSE')],
                            ['TinyEMU', join(DEPS, 'TinyEMU', 'LICENSE')]]) {
    try { await put(join(OUT, 'LICENSES', `${name}.txt`), await fs.readFile(file)); }
    catch { if (name !== 'TinyEMU') die(`no ${relative(AGENT, file)}`); }
}
if (!(await fs.readdir(join(OUT, 'LICENSES'))).includes('TinyEMU.txt')) {
    // No TinyEMU checkout (the engine came from its Pages): its licence is MIT.
    await put(join(OUT, 'LICENSES', 'TinyEMU.txt'), 'TinyEMU is released under the MIT licence: https://github.com/GramThanos/TinyEMU/blob/main/LICENSE\n');
}
await put(join(OUT, '.nojekyll'), '');

// The output must hold its own closure: every rewritten path has to land.
const check = await closure(join(OUT, 'index.html')).catch((e) => die(`output check: ${e.message}`));
const outsideOut = check.filter((f) => !inside(OUT, f));
if (outsideOut.length) die(`the built page reaches outside ${OUT}: ${outsideOut.join(', ')}`);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`built ${OUT}
  page and engine: ${files.length} files (${files.filter((f) => inside(DEPS, f)).length} from deps/)
${distros.map((d) => `  distro/${d.name}: ${d.chunks.length} chunks, ${mb(d.bytes)}`).join('\n')}
  source: ${info.commit ? info.commit.slice(0, 12) : 'unknown'}${info.dirty ? ', with uncommitted changes' : ''}
  engine: ${info.engine || 'unknown'}`);
