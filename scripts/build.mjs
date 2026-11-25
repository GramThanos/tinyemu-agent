#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * build.mjs — assemble the agent as a static site, for GitHub Pages or any host.
 *
 *   node scripts/build.mjs --out <dir>
 *
 * The output is the deployed site (GitHub Pages; .github/workflows/deploy.yml):
 *   index.html, js/       the page
 *   engine/               the parts of jsLab (deps/jsLab/lib/) the page loads
 *   vendor/bash.js        bash.js (deps/bash.js)
 *   README.md, LICENSE, LICENSES/ (the parts' licences), build-info.json, .nojekyll
 * The engine and the guest images are not in it: the page loads them from
 * TinyEMU's and TinyEMU-distros' GitHub Pages (js/distros.js).
 *
 * What is copied is the page's import closure (static imports, import() and
 * new URL('…', …)), followed from index.html, so a new module needs no change
 * here. Relative specifiers are rewritten for the new layout, and the closure of
 * the output is checked again.
 *
 * --out is emptied first, except .git and CNAME. To guard against a typo, it must
 * be empty, a git checkout, or an earlier build (it has build-info.json). The
 * usual place is _site/ (git-ignored).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPS = join(AGENT, 'deps');
const JSLAB = join(DEPS, 'jsLab');
const LIB = join(JSLAB, 'lib');
const BASHJS = join(DEPS, 'bash.js');
const REPO = AGENT;
const inside = (dir, p) => p === dir || p.startsWith(dir + sep);
const KEEP = new Set(['.git', 'CNAME']);

const USAGE = 'usage: node scripts/build.mjs --out <dir>';
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const outArg = option('--out');
if (!outArg || args.length) { console.error(USAGE); process.exit(2); }
const OUT = resolve(outArg);
const die = (msg) => { console.error(`build: ${msg}`); process.exit(1); };
if (OUT === AGENT || AGENT.startsWith(OUT + sep) || inside(DEPS, OUT)) die(`refusing to build into ${OUT}`);
for (const f of [join(LIB, 'vm', 'index.js'), join(BASHJS, 'bash.js')]) {
    try { await fs.access(f); } catch {
        die(`no ${relative(AGENT, f)}: run git submodule update --init`);
    }
}

/* ---- where each source file goes ------------------------------------------- */

function target(src) {
    // The deployed layout predates the submodules: jsLab's lib/ is engine/
    // (where the engine was too, before it came from TinyEMU's Pages), bash.js
    // is vendor/.
    if (inside(LIB, src)) return join(OUT, 'engine', relative(LIB, src));
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
/* A constant the page's js/distros.js sets: the engine release and the distros' Pages. */
async function pageConstant(name) {
    const text = await fs.readFile(join(AGENT, 'js', 'distros.js'), 'utf8');
    return text.match(new RegExp(`export const ${name} = '([^']*)'`))?.[1] ?? null;
}

/* ---- build ------------------------------------------------------------------ */

const files = await closure(join(AGENT, 'index.html'));
const outOf = new Map(files.map((f) => [f, target(f)]));
const map = (dep) => outOf.get(dep) ?? null;

await prepareOut();
for (const f of files) {
    if (/\.(html|m?js)$/.test(f)) await put(outOf.get(f), rewrite(await fs.readFile(f, 'utf8'), f, map));
    else await put(outOf.get(f), await fs.readFile(f));
}

const info = {
    source: 'https://github.com/GramThanos/tinyemu-agent',
    ...gitState(AGENT),
    built: new Date().toISOString(),
    engine: await pageConstant('ENGINE'),
    distros: await pageConstant('DISTROS_PAGES'),
    deps: Object.fromEntries(['jsLab', 'bash.js', 'TinyEMU', 'TinyEMU-distros']
        .map((n) => [n, existsSync(join(DEPS, n, '.git')) ? gitState(join(DEPS, n)).commit : null])),  // a submodule has its own .git
};
await put(join(OUT, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
const readme = (await fs.readFile(join(AGENT, 'scripts', 'release-README.md'), 'utf8'))
    .replaceAll('{{engine}}', info.engine || 'unknown')
    .replaceAll('{{commit}}', info.commit ? `${info.commit.slice(0, 12)}${info.dirty ? ' (with uncommitted changes)' : ''}` : 'unknown');
await put(join(OUT, 'README.md'), readme);
await put(join(OUT, 'LICENSE'), await fs.readFile(join(REPO, 'LICENSE')));
// The parts' own licences: jsLab's runtime and bash.js are copied here.
for (const [name, file] of [['jsLab', join(JSLAB, 'LICENSE')], ['bash.js', join(BASHJS, 'LICENSE')]]) {
    try { await put(join(OUT, 'LICENSES', `${name}.txt`), await fs.readFile(file)); }
    catch { die(`no ${relative(AGENT, file)}`); }
}
await put(join(OUT, '.nojekyll'), '');

// The output must hold its own closure: every rewritten path has to land.
const check = await closure(join(OUT, 'index.html')).catch((e) => die(`output check: ${e.message}`));
const outsideOut = check.filter((f) => !inside(OUT, f));
if (outsideOut.length) die(`the built page reaches outside ${OUT}: ${outsideOut.join(', ')}`);

console.log(`built ${OUT}
  page: ${files.length} files (${files.filter((f) => inside(DEPS, f)).length} from deps/)
  source: ${info.commit ? info.commit.slice(0, 12) : 'unknown'}${info.dirty ? ', with uncommitted changes' : ''}
  engine: TinyEMU ${info.engine || 'unknown'}, from its Pages; distros from ${info.distros}`);
