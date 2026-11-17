/*
 * bashjs.js — the Bash tool without the VM: commands run in bash.js, a bash
 * interpreter written in JavaScript (../vendor/bash.js), inside the page.
 *
 * Off by default (Settings → Features). What the commands see is not the guest's
 * filesystem but the page's own volumes, the same stores the guest mounts over 9p:
 *   /workspace       the workspace volume
 *   /agent/skills    the skills volume
 *   /tmp             an in-memory folder, kept until the page reloads
 * Nothing else exists, and only bash.js's builtins and its own utilities run (cat,
 * ls, grep, sed, awk, find, diff, ...): no programs from the guest. Files are text
 * to bash.js (UTF-8); a binary file read and written back is not kept byte for byte.
 *
 * One bash.js session per tools shell, so a shell keeps its directory, variables
 * and functions between calls, as a shell in the VM keeps its directory and
 * exported variables.
 */

'use strict';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/* bash.js is loaded on first use: it is ~420 KB and off by default. It is a UMD
 * script, which in a module sets globalThis.BashJS. */
let loading = null;
export function loadBashJS() {
    loading ||= import('../vendor/bash.js').then((m) => m?.default?.exec ? m.default : globalThis.BashJS);
    return loading;
}

/**
 * @param {object} o
 * @param {() => object|null} o.vm      the running VM (volume ops), or null
 * @param {[string, string][]} o.mounts  [path, volume name] pairs
 * @param {object} [o.BashJS]           the library, if already loaded (tests)
 */
export function createJsBash({ vm, mounts, BashJS = null }) {
    let lib = BashJS;
    let tmp = null;           // bash.js's own memfs, for /tmp
    const sessions = new Map();   // tools shell name -> bash.js session

    /* The volume a path is on: { volume, path } or null. */
    const onVolume = (p) => {
        for (const [dir, volume] of mounts) {
            if (p === dir || p.startsWith(`${dir}/`)) return { volume, path: p.slice(dir.length) || '/' };
        }
        return null;
    };
    const isTmp = (p) => p === '/tmp' || p.startsWith('/tmp/');
    /* Directories above the mounts: `/` holds workspace, agent and tmp; `/agent` holds skills. */
    const parents = () => {
        const tree = new Map([['/', new Set(['tmp'])]]);
        for (const [dir] of mounts) {
            const parts = dir.split('/').filter(Boolean);
            for (let i = 0; i < parts.length; i++) {
                const at = `/${parts.slice(0, i).join('/')}`;
                if (!tree.has(at)) tree.set(at, new Set());
                tree.get(at).add(parts[i]);
            }
        }
        return tree;
    };
    const live = () => {
        const v = vm();
        if (!v) throw new Error('the VM is not running yet, and its volumes hold the files');
        return v;
    };
    /* The volume entry at a path: { dir, size, mtime } or null. */
    const entry = async (r) => {
        if (r.path === '/') return { dir: true, size: 0, mtime: 0 };
        const cut = r.path.lastIndexOf('/');
        const list = await live().volumeList(r.volume, r.path.slice(0, cut) || '/');
        return list?.find((e) => e.name === r.path.slice(cut + 1)) || null;
    };
    const fail = (code, p) => Object.assign(new Error(`${code === 'ENOENT' ? 'No such file or directory' : 'Read-only file system'}`), { code, path: p });

    const fs = {
        async stat(p) {
            if (isTmp(p)) return tmp.stat ? tmp.stat(p) : null;
            const r = onVolume(p);
            if (!r) return parents().has(p) ? { type: 'dir', size: 0, mtime: new Date(0), mode: 0o755 } : null;
            const e = await entry(r);
            if (!e) return null;
            return { type: e.dir ? 'dir' : 'file', size: e.size || 0, mtime: new Date((e.mtime || 0) * 1000), mode: e.dir ? 0o755 : 0o644 };
        },
        async read(p) {
            if (isTmp(p)) return tmp.read(p);
            const r = onVolume(p);
            if (!r) {
                const kids = parents().get(p);
                return kids ? { type: 'dir', entries: [...kids].map((name) => ({ name, type: 'dir' })) } : null;
            }
            const e = await entry(r);
            if (!e) return null;
            if (e.dir) {
                const list = await live().volumeList(r.volume, r.path);
                return { type: 'dir', entries: (list || []).map((x) => ({ name: x.name, type: x.dir ? 'dir' : 'file' })) };
            }
            const bytes = await live().volumeGetFile(r.volume, r.path);
            if (!bytes) return null;
            return { type: 'file', content: DEC.decode(bytes), size: e.size, mtime: new Date((e.mtime || 0) * 1000) };
        },
        async write(p, content, opts = {}) {
            if (isTmp(p)) return tmp.write(p, content, opts);
            const r = onVolume(p);
            if (!r) throw fail('EROFS', p);
            if (opts.type === 'dir') { await live().volumeMkdir(r.volume, r.path); return; }
            let bytes = ENC.encode(String(content ?? ''));
            if (opts.append) {
                const before = await live().volumeGetFile(r.volume, r.path);
                if (before) {
                    const both = new Uint8Array(before.length + bytes.length);
                    both.set(before);
                    both.set(bytes, before.length);
                    bytes = both;
                }
            }
            const rc = await live().volumePutFile(r.volume, r.path, bytes);
            if (typeof rc === 'number' && rc < 0) throw fail('ENOENT', p);
        },
        async delete(p, opts = {}) {
            if (isTmp(p)) return tmp.delete(p, opts);
            const r = onVolume(p);
            if (!r || r.path === '/') throw fail('EROFS', p);
            const rc = await live().volumeDelete(r.volume, r.path);
            if (typeof rc === 'number' && rc < 0) throw fail('ENOENT', p);
        },
        async move(src, dst) {
            const a = isTmp(src) ? null : onVolume(src);
            const b = isTmp(dst) ? null : onVolume(dst);
            if (isTmp(src) && isTmp(dst)) return tmp.move(src, dst);
            if (a && b && a.volume === b.volume && live().volumeRename) {
                const rc = await live().volumeRename(a.volume, a.path, b.path);
                if (typeof rc === 'number' && rc < 0) throw fail('ENOENT', src);
                return;
            }
            // Across volumes (or /tmp): copy, then delete.
            await copyTree(src, dst);
            await fs.delete(src, { recursive: true });
        },
    };
    async function copyTree(src, dst) {
        const node = await fs.read(src);
        if (!node) throw fail('ENOENT', src);
        if (typeof node === 'string' || node.type === 'file') {
            await fs.write(dst, typeof node === 'string' ? node : node.content);
            return;
        }
        await fs.write(dst, null, { type: 'dir' });
        for (const e of node.entries || []) {
            const name = typeof e === 'string' ? e : e.name;
            await copyTree(`${src}/${name}`, `${dst}/${name}`);
        }
    }

    return {
        /**
         * Run a command in the named shell. Output is stdout and stderr merged, in
         * the order written. Resolves to { rc, out, cwd, timedOut, aborted }.
         */
        async run({ command, shell, cwd, env = {}, timeoutMs, signal, onOutput }) {
            lib ||= await loadBashJS();
            tmp ||= lib.memfs({ '/tmp': [] });
            let entry = sessions.get(shell);
            if (!entry) {
                // A session's streams are fixed when it is made: they write to
                // whichever call is current.
                entry = { emit: null, busy: Promise.resolve() };
                entry.sh = lib.create({
                    cwd: cwd || '/workspace', ...fs,
                    stdout: (c) => entry.emit?.(c), stderr: (c) => entry.emit?.(c),
                    env: { HOME: '/workspace', PATH: '/bin', ...env },
                });
                sessions.set(shell, entry);
            }
            // One call at a time per session: they share its streams and state.
            const turn = entry.busy.then(async () => {
                let out = '';
                entry.emit = (chunk) => { const t = String(chunk); out += t; onOutput?.(t); };
                const { sh } = entry;
                for (const [k, v] of Object.entries(env)) sh.setEnv(k, v);
                // The tools' shell may have moved (a Bash call's cd, or a sub-agent's copy).
                if (cwd && sh.getCwd() !== cwd) await sh.exec(`cd -- '${cwd.replace(/'/g, "'\\''")}'`);
                out = '';
                const r = await sh.exec(command);
                entry.emit = null;
                return { rc: r.exitCode, out, cwd: r.cwd ?? sh.getCwd() };
            });
            entry.busy = turn.catch(() => {});
            // bash.js can't be interrupted: on a stop or a timeout the call answers
            // now, and the command finishes on its own (its loops are bounded).
            let timer;
            const cut = new Promise((resolve) => {
                timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
                if (signal?.aborted) resolve({ aborted: true });
                signal?.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
            });
            try {
                const r = await Promise.race([turn, cut]);
                if (r.timedOut || r.aborted) return { rc: 124, out: '', cwd: null, timedOut: !!r.timedOut, aborted: !!r.aborted };
                return { ...r, timedOut: false, aborted: false };
            } finally {
                clearTimeout(timer);
            }
        },
        /** The shells' sessions, for tests. */
        sessions,
    };
}
