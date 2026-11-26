// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * world.js — what the chats work in: the skills library, the projects with their
 * workspaces and linked folders, and the environments (js/environments.js), every
 * project's bash.js and VMs.
 */

'use strict';

import { engineUrls, SnapshotStore, snapshotFingerprint, VMManager } from '../../deps/jsLab/lib/vm/index.js';
// jsLab's VMManager finds its worker next to itself (new URL(..., import.meta.url)),
// which a bundle doesn't keep: the build makes the worker a chunk of its own, and
// the manager is given its URL.
import vmWorkerUrl from '../../deps/jsLab/lib/vm/vm-worker.js?worker&url';
import { WORKSPACE, WORKSPACE_VOLUME } from '../../js/GuestBridge.js';
import { IdbLinkStore, LinkedFolders } from '../../js/LinkedFolders.js';
import { shQuote } from '../../js/tools.js';
import { SkillLibrary, SKILLS_STORAGE_KEY, SKILLS_VOLUME } from '../../js/skills.js';
import { renderPrompt } from '../../js/Agent.js';
import { VolumeHost } from '../../js/volumes.js';
import { envKey, ProjectLinkStore, ProjectStore, workspaceKey } from '../../js/projects.js';
import { EnvironmentPool } from '../../js/environments.js';
import { emit } from './store.js';
import { chatById, params, readJSON, S } from './state.js';
import { settings } from './settings.js';
import { DEFAULT_DISTRO, distroInfo, engineRelease, recordBoot, vmOptions } from './machines.js';
import { pickName, pickOf } from './models.js';
import { mcpTools } from './mcpServers.js';
import { addMessage } from './sessions.js';
import { askUser, delegate, todos } from './agents.js';
import { modeOf, policyOf, subMode } from './modes.js';

/* ---- skills: one library for every project, held by the page (js/volumes.js);
 * a VM gets a copy (js/environments.js) ---------------------------------------- */

export const skillsHost = new VolumeHost([{ name: SKILLS_VOLUME, storageKey: SKILLS_STORAGE_KEY }]);
export const skills = new SkillLibrary({ isEnabled: (id) => !settings.disabledSkills.includes(id) });
skills.setVM(skillsHost);
skills.onChange(() => emit('skills', 'ui'));

/* ---- projects (js/projects.js) ------------------------------------------------ */

/* The first load makes the default project from what the page kept before
 * projects: the VM tab's machine and its environment variables. */
export const VM_PREFS = 'tinyemu-agent-vm-settings';
export const ENV_VARS = 'tinyemu-agent-env';
export const projectStore = new ProjectStore();
function legacyProject() {
    const vm = readJSON(VM_PREFS, {});
    const vars = readJSON(ENV_VARS, []);
    return {
        env: { kind: 'vm', distro: typeof vm?.distro === 'string' ? vm.distro : DEFAULT_DISTRO, memoryMB: vm?.memoryMB, jit: vm?.jit !== false },
        envVars: Array.isArray(vars) ? vars : [],
    };
}
S.projects = projectStore.load(legacyProject());
export const projectById = (id) => S.projects.find((p) => p.id === id) || S.projects[0];
export function saveProjects() {
    if (!projectStore.save(S.projects)) addMessage('problem', 'This browser has no storage for the projects, so changes last until the page reloads.');
    emit('ui');
}
/* The project a chat belongs to (a sub-agent's chat: its parent's). */
export function projectOf(c) {
    if (!c) return S.projects[0];
    const main = c.kind === 'sub' ? chatById(c.parent) || c : c;
    return projectById(main.project);
}

/* What each project has while the page runs: its workspace's volume host and its
 * linked folders. Made on first use. */
export const runtimes = new Map();
const linkStore = typeof indexedDB === 'undefined' ? null : new IdbLinkStore();
const memoryLinks = { rows: new Map(), async all() { return [...this.rows.values()]; }, async put(l) { this.rows.set(l.id, l); }, async delete(id) { this.rows.delete(id); } };
export function rt(p) {
    let r = runtimes.get(p.id);
    if (r) return r;
    const volumes = new VolumeHost([{ name: WORKSPACE_VOLUME, storageKey: workspaceKey(p.id) }]);
    const links = new LinkedFolders({ volume: WORKSPACE_VOLUME, root: WORKSPACE, store: new ProjectLinkStore(linkStore || memoryLinks, p.id) });
    links.setVM(volumes);
    r = { volumes, links };
    runtimes.set(p.id, r);
    const open = () => projectOf(S.chat)?.id === p.id;
    links.on((type, text, kind) => {
        if (type === 'notice' && open()) addMessage(kind === 'problem' ? 'problem' : 'note', text);
        if (type === 'change') emit('files', 'ui');
    });
    r.loaded = links.load().then(() => {
        if (links.needingPermission.length && open()) {
            addMessage('note', `${links.needingPermission.length === 1 ? 'A linked folder needs' : 'Linked folders need'} `
                + 'your permission again after the reload. Press Reconnect in the Files panel; until then they are not synced.');
        }
        emit('files', 'ui');
    });
    return r;
}

/* ---- environments (js/environments.js) ----------------------------------------- */

/* The VM manager is made on first use, once the engine release is known. */
let vmManager = null;
export const pool = new EnvironmentPool({
    get mgr() {
        return (vmManager ||= new VMManager({ network: { subnet: '10.0.2.0/24' }, engine: engineRelease(), urls: { workerUrl: vmWorkerUrl } }));
    },
    snapshots: SnapshotStore,
    fingerprint: (opts) => (params.has('nosnapshot') ? Promise.resolve(null) : snapshotFingerprint({
        wasmUrl: engineUrls(engineRelease()).wasmBinUrl,
        configUrl: opts.configUrl,
        configOverride: opts.configOverride,
        options: { ...opts, volumes: undefined, configOverride: undefined },
    })),
    vmOptions: (spec, volumes) => ({ ...vmOptions(spec), volumes }),
    distroLabel: (name) => (name === 'custom' ? `the config in the link (${params.get('cfg')})` : distroInfo(name).label || name),
    settings: () => settings,
    skills,
    skillsVolumes: skillsHost,
    skillsVersion: () => skillsHost.version,
    sync: (env) => rt(env.project).links.sync(),
    delegate: (input, ctx) => delegate(input, ctx),
    ask: (questions, ctx) => askUser(questions, ctx),
    isToolEnabled: (name) => !settings.disabledTools.includes(name),
    bashTimeoutMs: () => settings.bashTimeoutMin * 60000,
    bashKeepLines: () => settings.bashKeepLines,
    extraTools: () => mcpTools(),
    todos: { get: (ctx) => todos.get(ctx), set: (ctx, list) => todos.set(ctx, list) },
    writeGuestEnv: (env) => writeGuestEnv(env),
    noteBoot(env) {
        const secs = recordBoot(env);
        if (secs !== null && S.chat && envOf(S.chat) === env) addMessage('note', `${env.label} is ready (${env.how} in ${secs} s).`);
    },
    isOpen: (id) => S.chat?.id === id || S.chat?.parent === id,
}, { idleMs: () => settings.idlePauseMin * 60000 });

/* A chat's environment: its own choice, else its project's default. Sub-agents
 * work in their parent's. */
export function envKeyOf(c) {
    const main = c?.kind === 'sub' ? chatById(c.parent) || c : c;
    return main?.env || envKey(projectOf(main).env);
}
export function envOf(c) {
    const p = projectOf(c);
    return pool.env(p, rt(p).volumes, envKeyOf(c));
}
/* A chat's tools: its environment's, in its own shell, with its mode's choice of tools. */
export const chatTools = (c) => envOf(c).toolsFor(c.id).withPolicy(policyOf(c));

let envTimer = 0;
pool.on((what, env, extra) => {
    if (what === 'note') {
        // A note about an environment goes to the open chat when it uses that one.
        if (S.chat && envOf(S.chat) === env) addMessage('note', extra);
        else console.info('[env]', extra);
        return;
    }
    if (what === 'status' && env.status === 'failed' && S.chat && envOf(S.chat) === env) {
        addMessage('problem', `${env.label} failed: ${env.error}`);
    }
    if (what === 'status' || what === 'users' || what === 'work' || what === 'saved') {
        clearTimeout(envTimer);
        envTimer = setTimeout(() => emit('ui'), 50);
    }
});

/* ---- the system prompt, per chat --------------------------------------------- */

/* The variables, for one chat: {{VAR_ARCH}} / {{VAR_OS_NAME}} from its environment
 * (bash.js has no processor of its own to speak of), {{VAR_MODEL_*}} from its model.
 * The Agent re-reads the prompt at every send, so a change of either applies. */
export function promptVars(c = S.chat) {
    const vars = {};
    if (c) {
        vars.MODE = modeOf(c)?.name || '';
        const key = envKeyOf(c);
        if (key === 'bashjs') Object.assign(vars, { ARCH: 'bash.js (JavaScript, in the browser)', OS_NAME: 'bash.js: bash and its built-in utilities, no VM' });
        else if (key === 'vm:custom') Object.assign(vars, { ARCH: 'see uname -m', OS_NAME: 'Linux' });
        else {
            const d = distroInfo(key.slice(3));
            Object.assign(vars, { ARCH: d.arch, OS_NAME: (d.label || d.name).replace(/\s*\([^)]*\)$/, '') });
        }
        const pick = pickOf(c);
        if (pick) Object.assign(vars, { MODEL_NAME: pickName(pick), MODEL_ID: pick.model });
    }
    return vars;
}
/* The system prompt a chat uses: its mode's, placeholders filled in. */
export const currentSystem = (c = S.chat) => renderPrompt(modeOf(c)?.prompt || '', promptVars(c));
/* A sub-agent's: the sub-agent mode's, with the delegating chat's machine and model. */
export const subSystem = (c) => renderPrompt(subMode()?.prompt || '', { ...promptVars(c), MODE: subMode()?.name || 'Sub-agent' });

/* New login shells in the guest (the console's `sh -l`, `su -`) get the project's
 * variables from /etc/profile.d. Best effort: a guest without it just doesn't. */
export async function writeGuestEnv(env) {
    const vars = env.project.envVars || [];
    const profile = ['# Set by the TinyEMU Agent page (the project\'s environment variables).',
        ...vars.map(([k, v]) => `export ${k}=${shQuote(v)}`), ''].join('\n');
    // The file goes in as an input, so no value can end a here-document early.
    const script = vars.length
        ? 'mkdir -p /etc/profile.d && cp "$AGENT_DIR/profile" /etc/profile.d/tinyemu-agent.sh'
        : 'rm -f /etc/profile.d/tinyemu-agent.sh';
    try { await env.bridge?.exec({ script, inputs: { profile }, timeoutMs: 15000 }); } catch { /* not there yet, or no /etc */ }
}

export { WORKSPACE, WORKSPACE_VOLUME };
