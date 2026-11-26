// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * environments.js — where a chat's tools run: bash.js in the page, or a TinyEMU
 * VM with one of TinyEMU-distros' machines.
 *
 * Each project has a pool of environments, at most one per kind: one `bashjs`,
 * and one `vm:<distro>` per machine. Chats of the project that pick the same kind
 * share it (each in its own shell); a chat that switches kind joins that one,
 * starting it if no chat had it yet. So: a first chat on bash.js, a second one
 * joins it; the second switches to a RISC-V machine, which starts; a third picks
 * the same machine and shares that VM; switching back to bash.js joins the
 * project's bash.js again.
 *
 * All of a project's environments work on the project's workspace (VolumeHost,
 * js/volumes.js), which has one writer at a time: the page, or one VM. So a
 * project runs one VM at a time. Starting another machine pauses the running
 * one once no chat is working in it (`acquire`); a chat that then uses the
 * paused one gets it back the same way. Pausing saves the VM's state
 * (SnapshotStore), stops it and gives the volumes back to the page; using it
 * again resumes that state in seconds.
 *
 * A VM nobody works in, whose chats aren't the one open, is paused by itself
 * after `idleMs` (`sweep`). bash.js costs nothing idle and is never paused.
 *
 * The skills are the page's (one library for every project). A VM gets a copy
 * of them in a volume of its own (`skills`, per project), brought up to date
 * when it starts and whenever the library changed before a call: the guest's
 * own changes to /agent/skills are not kept.
 */

'use strict';

import { GuestBridge, VOLUME, WORKSPACE, WORKSPACE_VOLUME } from './GuestBridge.js';
import { createTools } from './tools.js';
import { createJsBash } from './bashjs.js';
import { SKILLS_DIR, SKILLS_VOLUME } from './skills.js';
import { bridgeKey, envFromKey, skillsMirrorKey, snapshotKey } from './projects.js';
import { pauses } from './pause.js';

const ENC = new TextEncoder();
export const IDLE_PAUSE_MS = 10 * 60 * 1000;
/* How long stopping a failed VM waits for it to flush the volumes. */
const FAILED_FLUSH_MS = 5000;
export const MOUNTS = [[WORKSPACE, WORKSPACE_VOLUME], [SKILLS_DIR, SKILLS_VOLUME]];
const TERM_KEEP = 200000;

/* Boot progress recognized in the kernel log, after the page's own stages. */
const BOOT_STAGES = [
    [/Decompressing Linux/, 'decompressing the kernel'],
    [/\[ *\d+\.\d+\] /, 'starting the kernel'],
    [/virtio_blk|EXT[24]-fs|VFS: Mounted root/, 'mounting the disk'],
    [/Run \/\S+ as init/, 'starting the shell'],
];

function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '')
        .replace(/\x1b[=>]/g, '').replace(/[\x00\x07\r]/g, '');
}

/**
 * One volume host for both of a project's volumes: the workspace (the project's
 * VolumeHost) and the skills (the page's library), as bash.js and the page's
 * file serving see them.
 */
export function combinedVolumes(workspace, skills) {
    const pick = (name) => (name === SKILLS_VOLUME ? skills : workspace);
    const out = {};
    for (const op of ['volumeList', 'volumeGetFile', 'volumePutFile', 'volumeDelete', 'volumeMkdir', 'volumeRename', 'volumeFlush']) {
        out[op] = (name, ...args) => pick(name)[op](name, ...args);
    }
    return out;
}

/**
 * GuestBridge's exec() for bash.js: the scripts the file tools send (Glob, Grep)
 * run in a bash.js session of their own. Inputs and outputs (the guest's
 * $AGENT_DIR) don't exist there; such a script fails and says so.
 */
export function createJsBridge(runner, { shell = '__tools' } = {}) {
    return {
        ready: true,
        async exec({ script, cwd = WORKSPACE, timeoutMs = 120000, signal, inputs = {}, outputs = [] }) {
            if (Object.keys(inputs).length || outputs.length) {
                return { rc: 1, out: ENC.encode('This needs the VM: bash.js has no $AGENT_DIR.\n'), files: {}, cwd };
            }
            // bash.js drops the backslash of \( and \) (find's grouping); quoted, they get through.
            const command = script.replace(/\\([()])/g, '\'$1\'');
            const r = await runner.run({ command, shell, cwd, env: {}, timeoutMs, signal });
            return { rc: r.rc, out: ENC.encode(r.out || ''), files: {}, cwd: r.cwd || cwd, timedOut: !!r.timedOut, aborted: !!r.aborted };
        },
        syncClock: async () => {},
    };
}

/** A project's environments, and its one VM slot. */
export class ProjectEnvs {
    constructor(pool, project, volumes) {
        this.pool = pool;
        this.project = project;      // the project record (its id and defaults)
        this.volumes = volumes;      // its VolumeHost (the workspace)
        this.envs = new Map();       // key -> Environment
        this.liveVM = null;          // the Environment whose VM holds the volumes now
        this._slot = Promise.resolve();
    }

    get(key) {
        let e = this.envs.get(key);
        if (!e) {
            e = new Environment(this, key);
            this.envs.set(key, e);
        }
        return e;
    }

    /** Run `fn` holding the project's VM slot: one VM at a time, started or stopped in turn. */
    slot(fn) {
        const r = this._slot.then(fn);
        this._slot = r.catch(() => {});
        return r;
    }
}

export class Environment {
    constructor(owner, key) {
        this.owner = owner;
        this.key = key;
        this.spec = envFromKey(key, owner.project);
        this.kind = this.spec.kind;
        this.status = this.kind === 'bashjs' ? 'ready' : 'off';   // off, starting, ready, pausing, paused, failed
        this.stage = '';            // what a start is doing
        this.error = null;
        this.users = new Set();     // chat ids using it
        this.working = new Set();   // chat ids with a turn running in it
        this.lastActive = Date.now();
        this.vm = null;
        this.bridge = null;
        this.how = null;            // 'booted' | 'resumed'
        this.bootMs = null;
        this.saved = null;          // { at, size } of its saved state
        this.fingerprint = null;
        this.mounted = true;        // the guest has both 9p volumes where the paths say
        this.skillsVersion = -1;    // the library's version the guest's copy has
        this.console = '';          // the console's output as written (escape codes kept), the last TERM_KEEP
        this._tail = '';
        this._starting = null;
        this._listeners = new Set();
        this.tools = this._makeTools();
    }

    get project() { return this.owner.project; }
    get pool() { return this.owner.pool; }
    get label() { return this.kind === 'bashjs' ? 'bash.js' : this.pool.host.distroLabel(this.spec.distro); }

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emit(what) {
        for (const fn of this._listeners) { try { fn(what, this); } catch { /* a listener's problem */ } }
        this.pool._emit(what, this);
    }
    _set(status, stage = '') {
        this.status = status;
        this.stage = stage;
        this._emit('status');
    }

    /* ---- the tools ---------------------------------------------------- */

    _makeTools() {
        const host = this.pool.host;
        const vols = combinedVolumes(this.owner.volumes, host.skillsVolumes);
        const files = {
            mounted: () => this.kind === 'bashjs' || this.mounted,
            route(path) {
                if (!this.mounted() || !host.settings().pageFiles) return null;
                for (const [dir, volume] of MOUNTS) {
                    if (path === dir || path.startsWith(`${dir}/`)) return { volume, path: path.slice(dir.length) || '/' };
                }
                return null;
            },
            list: (volume, dir) => vols.volumeList(volume, dir),
            get: (volume, path) => vols.volumeGetFile(volume, path),
            put: (volume, path, bytes) => vols.volumePutFile(volume, path, bytes),
        };
        const common = {
            skills: host.skills,
            env: () => Object.fromEntries(this.project.envVars || []),
            delegate: host.delegate,
            ask: host.ask,
            isEnabled: host.isToolEnabled,
            bashTimeoutMs: host.bashTimeoutMs,
            bashKeepLines: host.bashKeepLines || (() => 0),
            // MCP servers' tools (js/mcp.js): the same in every environment.
            extraTools: host.extraTools || (() => []),
            // Each agent's to-do list, kept by the page (TodoWrite, TodoRead).
            todos: host.todos || null,
            files,
        };
        if (this.kind === 'bashjs') {
            const runner = createJsBash({ vm: () => vols, mounts: MOUNTS });
            this.jsBash = runner;
            // bash.js always serves /workspace and /agent/skills from the page.
            files.route = (path) => {
                for (const [dir, volume] of MOUNTS) {
                    if (path === dir || path.startsWith(`${dir}/`)) return { volume, path: path.slice(dir.length) || '/' };
                }
                return null;
            };
            return createTools(createJsBridge(runner), { ...common, jsBash: () => runner, sync: () => host.sync(this) });
        }
        // The VM starts (or resumes) when a call first needs it.
        const bridge = {
            exec: async (req) => {
                if (req.signal?.aborted) return { rc: -1, aborted: true, out: new Uint8Array(0), files: {}, cwd: null };
                if (!this.bridge) req.onOutput?.(ENC.encode(`[starting ${this.label}]\n`));
                const b = await this.ready(req.signal);
                if (!b) return { rc: -1, aborted: true, out: new Uint8Array(0), files: {}, cwd: null };
                await this._syncSkills();
                return b.exec(req);
            },
        };
        return createTools(bridge, { ...common, sync: () => host.sync(this) });
    }

    /** Tools for one chat: its own shell. */
    toolsFor(chatId) { return this.tools.forShell(`chat-${chatId}`.slice(0, 40)); }

    /* ---- who uses it -------------------------------------------------- */

    join(chatId) { this.users.add(chatId); this.lastActive = Date.now(); this._emit('users'); }
    leave(chatId) { this.users.delete(chatId); this.working.delete(chatId); this.lastActive = Date.now(); this._emit('users'); }
    workStart(chatId) { this.working.add(chatId); this.lastActive = Date.now(); this._emit('work'); }
    workEnd(chatId) { this.working.delete(chatId); this.lastActive = Date.now(); this._emit('work'); }
    get busy() { return this.working.size > 0; }

    /* ---- the VM ------------------------------------------------------- */

    /** The guest bridge, starting or resuming the VM first. Null if the signal stopped the wait. */
    async ready(signal = null) {
        if (this.kind === 'bashjs') return null;
        if (this.bridge && this.status === 'ready') return this.bridge;
        this._starting ||= this.owner.slot(() => this._start()).finally(() => { this._starting = null; });
        if (!signal) return this._starting;
        return Promise.race([
            this._starting,
            new Promise((resolve) => {
                if (signal.aborted) resolve(null);
                else signal.addEventListener('abort', () => resolve(null), { once: true });
            }),
        ]);
    }

    /** Start in the background (the chat switched to it). Failures show as the status. */
    warm() { if (this.kind === 'vm' && this.status !== 'ready') this.ready().catch(() => {}); }

    async _start() {
        if (this.bridge && this.status === 'ready') return this.bridge;
        const owner = this.owner;
        const host = this.pool.host;
        // Another machine of the project holds the volumes: pause it once nobody works in it.
        if (owner.liveVM && owner.liveVM !== this) {
            const other = owner.liveVM;
            this._set('starting', `waiting for ${other.label} to be idle`);
            await other._whenIdle();
            await other._pause({ reason: 'swap' });
        }
        // A VM that failed after it started is still there (its id taken, the volumes
        // its): stop it first, or creating the new one fails with "already exists".
        if (this.vm) {
            this._set('starting', 'stopping the failed machine');
            await this._stop({ failed: true });
        }
        const t0 = performance.now();
        this.error = null;
        this._set('starting', 'loading the emulator');
        const opts = host.vmOptions(this.spec, this.volumeSpecs());
        this.fingerprint = await host.fingerprint(opts).catch(() => null);
        const saved = this.fingerprint ? await host.snapshots.load(this.snapshotKey, this.fingerprint).catch(() => null) : null;
        if (saved) this.saved = { at: saved.savedAt, size: saved.blob.size };
        let result = null;
        if (saved) {
            this._set('starting', 'restoring the saved state');
            try {
                result = await this._run(opts, saved.blob, (vm) => this._attach(vm));
                this.how = 'resumed';
            } catch (e) {
                this._log(`Could not resume the saved state (${e.message}), so booting from scratch.`);
                await host.snapshots.delete(this.snapshotKey).catch(() => {});
                this.saved = null;
            }
        }
        if (!result) {
            result = await this._run(opts, undefined, (vm) => this._boot(vm));
            this.how = 'booted';
        }
        this.bootMs = Math.round(performance.now() - t0);
        await this._checkMounts();
        this.skillsVersion = -1;
        await this._syncSkills();
        host.writeGuestEnv?.(this);
        this._set('ready');
        // A new boot (or resumed state) has its own tty size: set the console's again.
        this._sizeSet = null;
        if (this.consoleSize) this.resizeConsole(this.consoleSize.cols, this.consoleSize.rows);
        host.noteBoot?.(this);
        if (this.how === 'booted' && this.fingerprint) this.save({ auto: true }).catch(() => {});
        return this.bridge;
    }

    get snapshotKey() { return snapshotKey(this.project.id, this.spec.distro); }
    get vmId() { return `vm-${this.project.id}-${this.spec.distro}`; }

    volumeSpecs() {
        const pid = this.project.id;
        return [
            { name: VOLUME, backend: 'indexeddb', type: 'files', storageKey: bridgeKey(pid) },
            ...this.owner.volumes.volumeSpecs([WORKSPACE_VOLUME]),
            { name: SKILLS_VOLUME, backend: 'indexeddb', type: 'files', storageKey: skillsMirrorKey(pid) },
        ];
    }

    /* Create the VM and race `work(vm)` against its failing to start: the engine
     * logs a failed start without rejecting vm.start(). */
    async _run(opts, snapshot, work) {
        const host = this.pool.host;
        const vm = await host.mgr.create(this.vmId, { ...opts, snapshot });
        let fail;
        const failed = new Promise((_, reject) => { fail = reject; });
        failed.catch(() => {});
        let started = false;
        const onFailure = (message) => {
            if (!started) { fail(new Error(message)); return; }
            this.error = message;
            this._set('failed', message);
        };
        vm.onConsole((bytes) => this._write(bytes));
        vm.on('downloading', (flag) => { this.downloading = flag; this._emit('status'); });
        vm.onError((e) => onFailure(e.message));
        vm.onLog(({ level, text }) => {
            if (level !== 'err') return;
            console.warn(`[${this.vmId}]`, text);
            if (text.startsWith('vm_start failed')) onFailure(text);
        });
        // The worker loads the volumes when the VM starts: the page lets go of them first.
        await this.owner.volumes.handTo(vm);
        this.owner.liveVM = this;
        try {
            this._bootNext = 0;
            const bridge = await Promise.race([work(vm), failed]);
            started = true;
            this.owner.volumes.vmStarted();
            this.vm = vm;
            this.bridge = bridge;
            return { vm, bridge };
        } catch (e) {
            await host.mgr.destroy(this.vmId).catch(() => {});
            this.owner.liveVM = null;
            await this.owner.volumes.takeBack(vm);
            this.error = e.message;
            this._set('failed', e.message);
            throw e;
        }
    }

    async _boot(vm) {
        this._set('starting', 'loading the kernel');
        await vm.start();
        const bridge = new GuestBridge(vm);
        await bridge.start(() => this._tail, { onStatus: (s) => this._set('starting', s) });
        return bridge;
    }

    async _attach(vm) {
        await vm.start();
        this._set('starting', 'reconnecting to the guest');
        const bridge = new GuestBridge(vm);
        if (!await bridge.attach()) throw new Error('the guest agent did not answer');
        return bridge;
    }

    _write(bytes) {
        this._dec ||= new TextDecoder();
        const raw = this._dec.decode(bytes, { stream: true });
        // Boot stages and the bridge's prompt check read plain text; the console
        // (a terminal emulator) gets the output as the guest wrote it.
        const text = stripAnsi(raw);
        this._tail = (this._tail + text).slice(-200);
        if (this.status === 'starting') {
            while (this._bootNext < BOOT_STAGES.length) {
                const i = BOOT_STAGES.findIndex(([re], n) => n >= this._bootNext && re.test(this._tail));
                if (i < 0) break;
                this._bootNext = i + 1;
                this._set('starting', BOOT_STAGES[i][1]);
            }
        }
        this.console = (this.console + raw).slice(-TERM_KEEP);
        for (const fn of this._listeners) { try { fn('console', this, raw); } catch { /* ignore */ } }
    }

    _log(text) { this.pool._emit('note', this, text); }

    /** Type on the VM's console. */
    sendInput(text) { this.vm?.sendInput(text); }

    /**
     * The console's size changed (the page's terminal was fitted): the guest's tty
     * is told. The engine has no live resize (jsLab's `resize` only records it, and
     * TinyEMU sends the size once, at boot; an x86 serial console has none at all),
     * so the bridge sets it with stty on /dev/console, which also sends the
     * foreground program SIGWINCH. Debounced: a drag resizes many times.
     */
    resizeConsole(cols, rows) {
        if (!(cols > 0 && rows > 0)) return;
        this.consoleSize = { cols, rows };
        try { this.vm?.resize(cols, rows); } catch { /* not running */ }
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => {
            const want = `${cols}x${rows}`;
            if (!this.bridge || this.status !== 'ready' || this._sizeSet === want) return;
            this._sizeSet = want;
            this.bridge.exec({ script: `stty -F /dev/console cols ${cols | 0} rows ${rows | 0} 2>/dev/null; true`, timeoutMs: 10000, graceMs: 2000 })
                .catch(() => { this._sizeSet = null; });
        }, 400);
    }

    /* The page serves Read, Edit and Write of /workspace and /agent/skills only
     * while the guest has those volumes mounted there. */
    async _checkMounts() {
        try {
            const r = await this.bridge.exec({ script: 'cat /proc/mounts', timeoutMs: 20000, graceMs: 5000 });
            const mounts = new TextDecoder().decode(r.out).split('\n').map((l) => l.split(' '));
            this.mounted = MOUNTS.every(([dir]) => mounts.some((m) => m[1] === dir && m[2] === '9p'));
        } catch {
            this.mounted = false;
        }
    }

    /* Bring the guest's copy of the skills up to the library's version. Calls run in
     * parallel, and the copy deletes before it writes: they all share the one in
     * flight (for this VM), which goes again if the library moved meanwhile. */
    _syncSkills() {
        const host = this.pool.host;
        const vm = this.vm;
        if (!vm || !host.skillsVolumes) return Promise.resolve();
        if (this._skillsCopy?.vm === vm) return this._skillsCopy.done;
        if (this.skillsVersion === host.skillsVersion()) return Promise.resolve();
        const copy = { vm, done: null };
        copy.done = (async () => {
            for (let i = 0; i < 3 && this.vm === vm && this.skillsVersion !== host.skillsVersion(); i++) {
                if (!await this._copySkills(vm)) break;
            }
        })().finally(() => { if (this._skillsCopy === copy) this._skillsCopy = null; });
        this._skillsCopy = copy;
        return copy.done;
    }

    async _copySkills(vm) {
        const host = this.pool.host;
        const lib = host.skillsVolumes;
        const version = host.skillsVersion();
        try {
            for (const e of (await vm.volumeList(SKILLS_VOLUME, '/')) || []) await vm.volumeDelete(SKILLS_VOLUME, `/${e.name}`);
            const copy = async (dir) => {
                for (const e of (await lib.volumeList(SKILLS_VOLUME, dir)) || []) {
                    const p = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
                    if (e.dir) { await vm.volumeMkdir(SKILLS_VOLUME, p); await copy(p); }
                    else await vm.volumePutFile(SKILLS_VOLUME, p, (await lib.volumeGetFile(SKILLS_VOLUME, p)) || new Uint8Array(0));
                }
            };
            await copy('/');
            if (this.vm === vm) this.skillsVersion = version;
        } catch (e) {
            console.warn('skills: could not copy them into the VM', e);
            return false;   // the call goes on without them; the next one tries again
        }
        return true;
    }

    _whenIdle() {
        if (!this.busy) return Promise.resolve();
        return new Promise((resolve) => {
            const off = this.on((what) => { if (what === 'work' && !this.busy) { off(); resolve(); } });
        });
    }

    /** Save the running VM's state, so that using it again resumes it from here. */
    async save({ auto = false } = {}) {
        if (!this.vm || !this.fingerprint) return null;
        const { blob, info } = await this.vm.saveSnapshot();
        await this.pool.host.snapshots.save(this.snapshotKey, this.fingerprint, { blob, info });
        this.saved = { at: Date.now(), size: blob.size };
        this._emit('saved');
        this.pool._emit('note', this, `${auto ? 'Saved the booted' : 'Saved the'} ${this.label} (${Math.round(blob.size / 1048576)} MB, `
            + `paused for ${info.pausedMs} ms).`);
        return this.saved;
    }

    /** Pause: save the state, stop the VM, give the volumes back. The next call resumes it. */
    pause() { return this.owner.slot(() => this._pause({ reason: 'user' })); }

    async _pause({ reason }) {
        if (!this.vm) return;
        this._set('pausing', 'saving the state');
        try { if (this.fingerprint) await this.save({ auto: true }); } catch (e) { console.warn('could not save before pausing', e); }
        await this._stop();
        this._set('paused', reason);
    }

    async _stop({ failed = this.status === 'failed' } = {}) {
        const vm = this.vm;
        if (!vm) return;
        // A failed machine may never answer: don't wait on it for long.
        const flush = vm.flush().catch(() => {});
        let timer;
        await (failed ? Promise.race([flush, new Promise((r) => { timer = setTimeout(r, FAILED_FLUSH_MS); })]) : flush);
        clearTimeout(timer);
        await this.pool.host.mgr.destroy(this.vmId).catch(() => {});
        this.vm = null;
        this.bridge = null;
        if (this.owner.liveVM === this) this.owner.liveVM = null;
        await this.owner.volumes.takeBack(vm);
    }

    /** Stop without saving, and forget the saved state: the next use boots afresh. */
    discard() {
        return this.owner.slot(async () => {
            if (this.kind === 'vm') {
                await this._stop();
                await this.pool.host.snapshots.delete(this.snapshotKey).catch(() => {});
                this.saved = null;
            }
            this.tools = this._makeTools();   // new shells
            this._set(this.kind === 'bashjs' ? 'ready' : 'off');
        });
    }

    /** The guest's clock after the browser paused the page. */
    syncClock() { return this.bridge?.syncClock?.().catch(() => {}); }
}

/**
 * Every project's environments.
 * `host` is what the page provides:
 *   mgr (a VMManager), snapshots (SnapshotStore), fingerprint(opts),
 *   vmOptions(spec, volumes), distroLabel(name), settings(), skills (SkillLibrary),
 *   skillsVolumes (the library's VolumeHost), skillsVersion(), sync(env),
 *   delegate, ask, isToolEnabled, bashTimeoutMs, bashKeepLines?, extraTools?, writeGuestEnv?, noteBoot?,
 *   isOpen(chatId) (the chat on screen)
 */
export class EnvironmentPool {
    constructor(host, { idleMs = () => IDLE_PAUSE_MS } = {}) {
        this.host = host;
        this.idleMs = idleMs;
        this.projects = new Map();   // project id -> ProjectEnvs
        this._listeners = new Set();
        this._timer = setInterval(() => this.sweep(), 30000);
        pauses.on?.(() => { for (const e of this.all()) e.syncClock(); });
    }

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emit(what, env, extra) { for (const fn of this._listeners) { try { fn(what, env, extra); } catch { /* ignore */ } } }

    /** A project's pool, made with its volume host on first use. */
    project(p, volumes) {
        let x = this.projects.get(p.id);
        if (!x) {
            x = new ProjectEnvs(this, p, volumes);
            this.projects.set(p.id, x);
        }
        x.project = p;
        return x;
    }

    env(p, volumes, key) { return this.project(p, volumes).get(key); }

    all() { return [...this.projects.values()].flatMap((x) => [...x.envs.values()]); }

    /** Pause VMs nobody works in, none of whose chats is on screen, idle for idleMs. */
    sweep(now = Date.now()) {
        const limit = this.idleMs();
        if (!(limit > 0)) return;
        for (const e of this.all()) {
            if (e.kind !== 'vm' || e.status !== 'ready' || e.busy) continue;
            if ([...e.users].some((id) => this.host.isOpen(id))) continue;
            if (now - e.lastActive < limit) continue;
            e.owner.slot(() => (e.status === 'ready' && !e.busy ? e._pause({ reason: 'idle' }) : null))
                .then(() => this._emit('note', e, `Paused ${e.label} of ${e.project.name}: nobody used it for a while. It resumes when a chat needs it.`))
                .catch(() => {});
        }
    }

    /** Before the page goes: save every page-held volume. */
    flushAll() { for (const x of this.projects.values()) x.volumes.flush()?.catch?.(() => {}); }
}
