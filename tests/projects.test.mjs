// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Tests of projects, providers, volume hand-over and environments, without a
 * VM or a model: volumes are in-memory stores, a "VM" is a stand-in with the
 * volume calls.
 * Run: node tests/projects.test.mjs
 */

import assert from 'node:assert/strict';

import { Fs9pStore } from '../deps/jsLab/lib/volumes/Fs9pStore.js';
import { VolumeHost, volumeDbName } from '../js/volumes.js';
import {
    DEFAULT_PROJECT, envFromKey, envKey, isProjectSnapshot, ProjectLinkStore, ProjectStore, projectShape, projectStorageKeys,
    snapshotKey, workspaceKey,
} from '../js/projects.js';
import { offeredModels, ProviderStore, providerShape, baseURLOf } from '../js/providerStore.js';
import { combinedVolumes, createJsBridge, EnvironmentPool } from '../js/environments.js';
import { createJsBash } from '../js/bashjs.js';
import { createTools } from '../js/tools.js';

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; } catch (e) {
        console.error(`FAIL ${name}\n`, e);
        process.exitCode = 1;
    }
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

class MemoryStorage {
    constructor() { this.m = new Map(); }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
}

/* Volumes "in IndexedDB": a store per storage key that survives being closed and opened again. */
function memoryDisk() {
    const saved = new Map();   // storageKey -> Fs9pStore (stands in for what IndexedDB holds)
    return {
        saved,
        open: async (spec) => {
            let s = saved.get(spec.storageKey);
            if (!s) {
                s = new Fs9pStore(spec.name, null);
                s.flush = async () => {};   // nothing under it to save to
                saved.set(spec.storageKey, s);
            }
            return s;
        },
    };
}

/* A VM's volume calls over the same stores, as its worker would serve them. */
function fakeVM(disk, specs) {
    const byName = new Map(specs.map((s) => [s.name, s.storageKey]));
    const st = (n) => disk.saved.get(byName.get(n));
    return {
        calls: 0,
        volumeList: async function (n, p) { this.calls++; return st(n).listDir(p); },
        volumeGetFile: async (n, p) => st(n).getFile(p),
        volumePutFile: async function (n, p, b) { this.calls++; return st(n).putFile(p, b); },
        volumeDelete: async (n, p) => st(n).removePath(p),
        volumeMkdir: async (n, p) => { st(n)._mkdirp(p); return 0; },
        volumeRename: async (n, a, b) => st(n).rename(a, b),
        volumeFlush: async () => 0,
    };
}

/* ---- projects ------------------------------------------------------------ */

await test('the first load makes the default project from the old VM choice', () => {
    const store = new ProjectStore({ storage: new MemoryStorage() });
    const list = store.load({ env: { kind: 'vm', distro: 'alpine-3.20-x86', memoryMB: 512, jit: false }, envVars: [['A', '1'], ['bad name', 'x']] });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, DEFAULT_PROJECT);
    assert.deepEqual(list[0].env, { kind: 'vm', distro: 'alpine-3.20-x86', memoryMB: 512, jit: false });
    assert.deepEqual(list[0].envVars, [['A', '1']]);
});

await test('projects are saved and come back whole', () => {
    const storage = new MemoryStorage();
    const store = new ProjectStore({ storage });
    const list = store.load();
    list.push(projectShape({ name: '  Site  ', env: { kind: 'vm', distro: '../etc' } }));
    store.save(list);
    const again = new ProjectStore({ storage }).load();
    assert.equal(again.length, 2);
    assert.equal(again[1].name, 'Site');
    assert.deepEqual(again[1].env, { kind: 'bashjs' }, 'a distro that is not a plain name is dropped');
});

await test('the default project keeps the storage keys of before; others get their own', () => {
    assert.equal(workspaceKey(DEFAULT_PROJECT), 'tinyemu-agent-workspace');
    assert.equal(workspaceKey('p1'), 'tinyemu-agent-workspace:p1');
    assert.equal(snapshotKey(DEFAULT_PROJECT, 'alpine-3.20-x86'), 'tinyemu-agent-vm');
    assert.equal(snapshotKey(DEFAULT_PROJECT, 'debian-13-riscv64-lite'), 'tinyemu-agent-vm:debian-13-riscv64-lite');
    assert.equal(snapshotKey('p1', 'debian-13-riscv64-lite'), 'tinyemu-agent-vm:p1:debian-13-riscv64-lite');
});

await test('environment keys round-trip, taking VM settings from the project', () => {
    const p = projectShape({ env: { kind: 'vm', distro: 'x', memoryMB: 512, jit: false } });
    assert.equal(envKey(p.env), 'vm:x');
    assert.equal(envKey({ kind: 'bashjs' }), 'bashjs');
    assert.deepEqual(envFromKey('vm:x', p), { kind: 'vm', distro: 'x', memoryMB: 512, jit: false });
    assert.deepEqual(envFromKey('vm:y', p), { kind: 'vm', distro: 'y', memoryMB: 256, jit: true });
    assert.deepEqual(envFromKey('bashjs', p), { kind: 'bashjs' });
});

await test('each project sees only its own linked folders; old links are the default project\'s', async () => {
    const rows = new Map([['a', { id: 'a', path: '/x' }], ['b', { id: 'b', path: '/y', project: 'p1' }]]);
    const base = { all: async () => [...rows.values()], put: async (l) => rows.set(l.id, l), delete: async (id) => rows.delete(id) };
    const def = new ProjectLinkStore(base, DEFAULT_PROJECT);
    const p1 = new ProjectLinkStore(base, 'p1');
    assert.deepEqual((await def.all()).map((l) => l.id), ['a']);
    assert.deepEqual((await p1.all()).map((l) => l.id), ['b']);
    await p1.put({ id: 'c', path: '/z' });
    assert.equal(rows.get('c').project, 'p1');
});

/* ---- providers ------------------------------------------------------------ */

await test('the old saved connection becomes a provider with its model enabled', () => {
    const storage = new MemoryStorage();
    storage.setItem('tinyemu-agent-connection', JSON.stringify({ provider: 'claude', apiKey: 'k', model: 'claude-x' }));
    const { providers, migrated } = new ProviderStore({ storage }).load();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].type, 'claude');
    assert.equal(providers[0].apiKey, 'k');
    assert.deepEqual(providers[0].enabled, ['claude-x']);
    assert.deepEqual(migrated, { provider: 'claude', model: 'claude-x' });
});

await test('offered models are the enabled ones, with the names the provider listed', () => {
    const a = providerShape({ id: 'a', type: 'openai', apiKey: 'k', models: [{ id: 'm1', label: 'Model One (m1)' }, { id: 'm2' }], enabled: ['m1'] });
    const b = providerShape({ id: 'b', type: 'custom', baseURL: 'http://localhost:1/v1/', enabled: ['local'] });
    const list = offeredModels([a, b]);
    assert.deepEqual(list.map((m) => [m.provider, m.model, m.label]), [['a', 'm1', 'Model One'], ['b', 'local', 'local']]);
    assert.equal(baseURLOf(b), 'http://localhost:1/v1');
    assert.equal(providerShape({ type: 'nope' }), null);
});

/* ---- volumes -------------------------------------------------------------- */

await test('the page holds a volume until a VM takes it, and gets it back after', async () => {
    const disk = memoryDisk();
    const host = new VolumeHost([{ name: 'workspace', storageKey: 'ws' }], { open: disk.open });
    await host.volumePutFile('workspace', '/a.txt', ENC.encode('page'));
    assert.equal(host.holder, 'page');
    const vm = fakeVM(disk, host.volumeSpecs());
    await host.handTo(vm);
    assert.equal(host.holder, 'vm');
    // Calls wait until the VM has started.
    let listed = null;
    const p = host.volumeList('workspace', '/').then((l) => { listed = l; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(listed, null);
    host.vmStarted();
    await p;
    assert.deepEqual(listed.map((e) => e.name), ['a.txt']);
    assert.ok(vm.calls > 0, 'went to the VM');
    await host.volumePutFile('workspace', '/b.txt', ENC.encode('vm'));
    await host.takeBack(vm);
    assert.equal(host.holder, 'page');
    assert.equal(DEC.decode(await host.volumeGetFile('workspace', '/b.txt')), 'vm');
    clearInterval(host._timer);
});

/* ---- environments ----------------------------------------------------------- */

function poolHost(disk, extra = {}) {
    const skills = new VolumeHost([{ name: 'skills', storageKey: 'skills' }], { open: disk.open });
    return {
        settings: () => ({ pageFiles: true }),
        skills: null,
        skillsVolumes: skills,
        skillsVersion: () => skills.version,
        sync: async () => {},
        delegate: null,
        ask: null,
        isToolEnabled: () => true,
        bashTimeoutMs: () => 60000,
        distroLabel: (d) => d,
        isOpen: () => false,
        ...extra,
    };
}

await test('a bash.js environment runs every tool on the project\'s workspace', async () => {
    const disk = memoryDisk();
    const host = poolHost(disk);
    const pool = new EnvironmentPool(host);
    clearInterval(pool._timer);
    const p = projectShape({ id: 'p1', name: 'P' });
    const ws = new VolumeHost([{ name: 'workspace', storageKey: 'ws1' }], { open: disk.open });
    const env = pool.env(p, ws, 'bashjs');
    assert.equal(env.status, 'ready');
    const t = env.toolsFor('c1');
    let r = await t.run('write', { path: 'src/app.js', content: 'const x = 1;\nhello();\n' });
    assert.equal(r.isError, false, r.content);
    r = await t.run('bash', { command: 'cat src/app.js | wc -l' });
    assert.equal(r.content.trim(), '2');
    r = await t.run('glob', { pattern: '**/*.js' });
    assert.equal(r.content, '/workspace/src/app.js');
    r = await t.run('grep', { pattern: 'hel+o', include: '*.js' });
    assert.equal(r.content, '/workspace/src/app.js:2:hello();');
    // The same environment from another chat shares the files, not the shell.
    await t.run('bash', { command: 'cd src' });
    const t2 = env.toolsFor('c2');
    r = await t2.run('bash', { command: 'pwd; ls src' });
    assert.equal(r.content, '/workspace\napp.js\n');
    assert.equal(DEC.decode(disk.saved.get('ws1').getFile('/src/app.js')).split('\n')[1], 'hello();');
    clearInterval(ws._timer);
    clearInterval(host.skillsVolumes._timer);
});

await test('the bash.js bridge refuses scripts that need the guest\'s files', async () => {
    const js = createJsBash({ vm: () => combinedVolumes(
        new VolumeHost([{ name: 'workspace', storageKey: 'w' }], { open: memoryDisk().open }),
        new VolumeHost([{ name: 'skills', storageKey: 's' }], { open: memoryDisk().open }),
    ), mounts: [['/workspace', 'workspace'], ['/agent/skills', 'skills']] });
    const b = createJsBridge(js);
    const r = await b.exec({ script: 'cat "$AGENT_DIR/data"', outputs: ['data'] });
    assert.equal(r.rc, 1);
    assert.match(DEC.decode(r.out), /needs the VM/);
    const t = createTools(b, { jsBash: () => js });
    const w = await t.run('read', { path: '/tmp/nothing' });
    assert.equal(w.isError, true);
});

await test('an idle VM nobody has open is paused; a working or open one is not', async () => {
    const disk = memoryDisk();
    let open = null;
    const host = poolHost(disk, { isOpen: (id) => id === open });
    const pool = new EnvironmentPool(host, { idleMs: () => 1000 });
    clearInterval(pool._timer);
    const p = projectShape({ id: 'p2', name: 'P2' });
    const ws = new VolumeHost([{ name: 'workspace', storageKey: 'ws2' }], { open: disk.open });
    const env = pool.env(p, ws, 'vm:x');
    // Pretend it runs.
    let paused = 0;
    env.status = 'ready';
    env.vm = {};
    env._pause = async () => { paused++; env.status = 'paused'; };
    env.join('c1');
    env.lastActive = 0;
    open = 'c1';
    pool.sweep(10000);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(paused, 0, 'its chat is on screen');
    open = null;
    env.workStart('c1');
    env.lastActive = 0;
    pool.sweep(10000);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(paused, 0, 'a turn runs in it');
    env.workEnd('c1');
    env.lastActive = 0;
    pool.sweep(10000);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(paused, 1);
    clearInterval(ws._timer);
    clearInterval(host.skillsVolumes._timer);
});

await test('a project\'s saved states and volumes, for deleting it', async () => {
    assert.ok(isProjectSnapshot(snapshotKey('p1', 'alpine-3.20-x86'), 'p1'));
    assert.ok(!isProjectSnapshot(snapshotKey('p12', 'alpine-3.20-x86'), 'p1'));
    assert.ok(!isProjectSnapshot(snapshotKey('p1', 'x'), 'p2'));
    assert.ok(isProjectSnapshot(snapshotKey(DEFAULT_PROJECT, 'alpine-3.20-x86'), DEFAULT_PROJECT));
    assert.ok(isProjectSnapshot(snapshotKey(DEFAULT_PROJECT, 'debian-13-riscv64-lite'), DEFAULT_PROJECT));
    assert.ok(!isProjectSnapshot(snapshotKey('p1', 'debian-13-riscv64-lite'), DEFAULT_PROJECT));
    assert.deepEqual(projectStorageKeys('p1'), [workspaceKey('p1'), 'tinyemu-agent-bridge:p1', 'tinyemu-agent-skills-mirror:p1']);
    assert.equal(volumeDbName('ws'), 'tinyemu-vol-ws');
    // A closed host lets its stores go and opens nothing again.
    const disk = memoryDisk();
    const host = new VolumeHost([{ name: 'workspace', storageKey: 'wsx' }], { open: disk.open });
    await host.volumePutFile('workspace', '/a.txt', new TextEncoder().encode('x'));
    await host.close();
    assert.equal(host.stores.size, 0);
    assert.equal(await host.volumeGetFile('workspace', '/a.txt'), null);
    assert.equal(host.stores.size, 0);
});

await test('a VM that failed after it started is stopped before it starts again', async () => {
    const disk = memoryDisk();
    const destroyed = [];
    const host = poolHost(disk, {
        mgr: { destroy: async (id) => { destroyed.push(id); } },
        vmOptions: () => ({}),
        fingerprint: async () => null,
        snapshots: { load: async () => null, delete: async () => {} },
    });
    const pool = new EnvironmentPool(host);
    clearInterval(pool._timer);
    const p = projectShape({ id: 'p3', name: 'P3' });
    const ws = new VolumeHost([{ name: 'workspace', storageKey: 'ws3' }], { open: disk.open });
    const env = pool.env(p, ws, 'vm:x');
    // It crashed after booting: still there, its id taken.
    env.vm = { flush: async () => {}, volumeList: async () => [] };
    env.bridge = {};
    env.owner.liveVM = env;
    env.status = 'failed';
    let vmAtCreate;
    env._run = async () => {
        vmAtCreate = env.vm;
        env.vm = { volumeList: async () => [] };
        env.bridge = { exec: async () => ({ out: ENC.encode('') }) };
        return { vm: env.vm, bridge: env.bridge };
    };
    await env.ready();
    assert.deepEqual(destroyed, [env.vmId], 'the old one was destroyed first');
    assert.equal(vmAtCreate, null);
    assert.equal(env.status, 'ready');
    clearInterval(ws._timer);
    clearInterval(host.skillsVolumes._timer);
});

await test('parallel calls share one copy of the skills into the VM', async () => {
    const disk = memoryDisk();
    const host = poolHost(disk);
    const pool = new EnvironmentPool(host);
    clearInterval(pool._timer);
    await host.skillsVolumes.volumePutFile('skills', '/a.md', ENC.encode('skill a'));
    const p = projectShape({ id: 'p4', name: 'P4' });
    const ws = new VolumeHost([{ name: 'workspace', storageKey: 'ws4' }], { open: disk.open });
    const env = pool.env(p, ws, 'vm:x');
    const files = new Map();
    let deletes = 0;
    const later = () => new Promise((r) => setTimeout(r, 5));
    env.vm = {
        volumeList: async () => { await later(); return [...files.keys()].map((k) => ({ name: k.slice(1) })); },
        volumeDelete: async (_, path) => { await later(); deletes++; files.delete(path); },
        volumeMkdir: async () => {},
        volumePutFile: async (_, path, bytes) => { await later(); files.set(path, bytes); },
    };
    env.skillsVersion = -1;
    await Promise.all([env._syncSkills(), env._syncSkills(), env._syncSkills()]);
    assert.deepEqual([...files.keys()], ['/a.md']);
    assert.equal(env.skillsVersion, host.skillsVersion());
    assert.equal(deletes, 0, 'one copy, into an empty folder');
    // Up to date: nothing is copied again.
    await env._syncSkills();
    assert.equal(deletes, 0);
    clearInterval(ws._timer);
    clearInterval(host.skillsVolumes._timer);
});

await test('the stores start without storage when reading localStorage throws', async () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
        const { ModeStore } = await import('../js/modes.js');
        assert.ok(new ModeStore().load().modes.length > 0);
        assert.ok(Array.isArray(new ProviderStore().load().providers));
        assert.equal(new ProjectStore().storage, null);
    } finally {
        if (had) Object.defineProperty(globalThis, 'localStorage', had);
        else delete globalThis.localStorage;
    }
});

console.log(process.exitCode ? `some tests FAILED (${passed} passed)` : `all ${passed} tests passed`);
