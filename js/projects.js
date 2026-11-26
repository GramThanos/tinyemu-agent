// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * projects.js — projects: what the sidebar groups chats into.
 *
 * A project owns a workspace (a JS volume of its own, mounted at /workspace in
 * every environment its chats use, with its linked folders and uploads), and the
 * defaults a new chat in it starts with: the environment it runs in and the model.
 * A chat can change either for itself afterwards.
 *
 *   { id, name, created, updated,
 *     env:    { kind: 'bashjs' } | { kind: 'vm', distro, memoryMB, jit },
 *     model:  { provider, model } | null,   a configured provider's id and a model id
 *     envVars: [[name, value], ...],         set in every shell of the project's chats
 *     collapsed }                             the sidebar shows its chats or not
 *
 * The first project, `default`, keeps the storage keys the page used before
 * projects existed (its workspace, bridge volume and saved VM states), so an
 * existing workspace and saved state carry on in it.
 *
 * Kept in localStorage: a handful of small records. Without storage there is
 * the default project for the page's life.
 */

'use strict';

export const DEFAULT_PROJECT = 'default';
const PROJECTS_KEY = 'tinyemu-agent-projects';

/** An environment key, as chats and the environment pool name them. */
export const envKey = (env) => (env?.kind === 'vm' ? `vm:${env.distro}` : 'bashjs');

/** The environment a key names (VM settings from the project, when it is one of its machine). */
export function envFromKey(key, project = null) {
    if (key === 'bashjs' || !key) return { kind: 'bashjs' };
    const distro = key.slice(3);
    const p = project?.env?.kind === 'vm' && project.env.distro === distro ? project.env : null;
    return { kind: 'vm', distro, memoryMB: p?.memoryMB ?? 256, jit: p?.jit ?? true };
}

/* Storage keys: the default project keeps the old ones. */
export const workspaceKey = (pid) => (pid === DEFAULT_PROJECT ? 'tinyemu-agent-workspace' : `tinyemu-agent-workspace:${pid}`);
export const bridgeKey = (pid) => (pid === DEFAULT_PROJECT ? 'tinyemu-agent-bridge' : `tinyemu-agent-bridge:${pid}`);
export const skillsMirrorKey = (pid) => `tinyemu-agent-skills-mirror:${pid}`;
/* One saved state per project and machine. alpine-3.20-x86, the very first
 * default, keeps the key it always had. */
export function snapshotKey(pid, distro) {
    if (pid === DEFAULT_PROJECT) return distro === 'alpine-3.20-x86' ? 'tinyemu-agent-vm' : `tinyemu-agent-vm:${distro}`;
    return `tinyemu-agent-vm:${pid}:${distro}`;
}

/** Whether a saved state's key is one of project `pid`'s (any machine): see snapshotKey. */
export function isProjectSnapshot(key, pid) {
    if (pid === DEFAULT_PROJECT) return key === 'tinyemu-agent-vm' || /^tinyemu-agent-vm:[^:]+$/.test(key);
    return key.startsWith(`tinyemu-agent-vm:${pid}:`);
}

/** Every volume a project keeps in this browser, by storage key: its workspace, the
 * tools' channel (`agent`) and its VMs' copy of the skills. */
export const projectStorageKeys = (pid) => [workspaceKey(pid), bridgeKey(pid), skillsMirrorKey(pid)];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A record as saved, made whole: anything missing or wrong gets its default. */
export function projectShape(p, defaults = {}) {
    const now = Date.now();
    const out = {
        id: typeof p?.id === 'string' && /^[\w-]{1,40}$/.test(p.id) ? p.id : newProjectId(),
        name: typeof p?.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : 'Project',
        created: Number.isFinite(p?.created) ? p.created : now,
        updated: Number.isFinite(p?.updated) ? p.updated : now,
        env: { kind: 'bashjs' },
        model: p?.model && typeof p.model.provider === 'string' && typeof p.model.model === 'string'
            ? { provider: p.model.provider, model: p.model.model } : null,
        envVars: Array.isArray(p?.envVars)
            ? p.envVars.filter((e) => Array.isArray(e) && ENV_NAME.test(e[0]) && typeof e[1] === 'string') : [],
        collapsed: !!p?.collapsed,
    };
    const env = p?.env ?? defaults.env;
    if (env?.kind === 'vm' && typeof env.distro === 'string' && /^[\w-][\w.-]*$/.test(env.distro)) {
        out.env = {
            kind: 'vm', distro: env.distro,
            memoryMB: Number.isInteger(env.memoryMB) && env.memoryMB > 0 ? env.memoryMB : 256,
            jit: env.jit !== false,
        };
    }
    return out;
}

export function newProjectId(now = Date.now()) {
    return `p${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* The page's localStorage, or null: with storage blocked (all cookies blocked, some
 * private modes), merely reading `localStorage` throws. */
function pageStorage() {
    try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class ProjectStore {
    /** @param {{storage?: Storage|null}} [o] */
    constructor({ storage = pageStorage() } = {}) {
        this.storage = storage;
    }

    /**
     * The saved projects; the first time, one default project made from what the
     * page kept before projects (`legacy`: { env, envVars, model }).
     */
    load(legacy = {}) {
        let list = null;
        try { list = JSON.parse(this.storage?.getItem(PROJECTS_KEY)); } catch { /* none */ }
        const out = Array.isArray(list) ? list.map((p) => projectShape(p)) : [];
        if (!out.some((p) => p.id === DEFAULT_PROJECT)) {
            out.unshift(projectShape({ id: DEFAULT_PROJECT, name: 'My project', created: 0, ...legacy }, legacy));
        }
        return out;
    }

    save(list) {
        try { this.storage?.setItem(PROJECTS_KEY, JSON.stringify(list)); return true; } catch { return false; }
    }

    clear() {
        try { this.storage?.removeItem(PROJECTS_KEY); } catch { /* nothing saved */ }
    }
}

/**
 * Links saved for one project. LinkedFolders keeps every link in one IndexedDB
 * store; this view gives each project its own: a link saved before projects
 * belongs to the default one.
 */
export class ProjectLinkStore {
    constructor(store, pid) { this.store = store; this.pid = pid; }
    async all() {
        const list = (await this.store.all()) || [];
        return list.filter((l) => (l.project ?? DEFAULT_PROJECT) === this.pid);
    }
    put(link) { return this.store.put({ ...link, project: this.pid }); }
    delete(id) { return this.store.delete(id); }
}
