// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * data.js — Settings → Data: what this page keeps in this browser, and deleting
 * it. Only the volume hosts' ops (volumeDelete, volumeFlush), links.unlink(),
 * SnapshotStore.clear() and localStorage, never deleting an IndexedDB database: a
 * worker (or the page) holds the volumes' databases open and would write them
 * back on the next flush. Linked folders are unlinked before a workspace is
 * emptied, as the Files tab does.
 */

'use strict';

import { SnapshotStore } from '../../deps/jsLab/lib/vm/index.js';
import { SKILLS_VOLUME } from '../../js/skills.js';
import { anyRunning, formatSize, plural, S } from './state.js';
import { SETTINGS } from './settings.js';
import { providerStore } from './models.js';
import { MCP_KEY } from './mcpServers.js';
import { ENV_VARS, pool, projectOf, projectStore, rt, runtimes, skills, skillsHost, VM_PREFS, WORKSPACE_VOLUME } from './world.js';
import { cardsOpen, dropSession, addMessage } from './sessions.js';
import { deleteAllChats, newChatIn } from './chatOps.js';
import { files } from './files.js';
import { LAYOUT } from './layout.js';
import { MODES_KEY } from '../../js/modes.js';

/* A whole volume's files and bytes (folders not counted). */
export async function volumeTotals(host, volume) {
    let count = 0, bytes = 0;
    const walk = async (dir) => {
        for (const e of (await host.volumeList(volume, dir)) || []) {
            const path = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
            if (e.dir) await walk(path);
            else { count++; bytes += e.size; }
        }
    };
    await walk('/');
    return { files: count, bytes };
}

/** What the page keeps: [term, value] rows, and whether there are skills and saved states. */
export async function dataStats() {
    const rows = [];
    const p = projectOf(S.chat);
    const r = rt(p);
    const ws = await volumeTotals(r.volumes, WORKSPACE_VOLUME).catch(() => null);
    rows.push(['Projects', plural(S.projects.length, 'project')]);
    if (ws) {
        rows.push([`${p.name}'s workspace`, `${plural(ws.files, 'file')}, ${formatSize(ws.bytes)}`
            + (r.links.links.length ? ` · ${plural(r.links.links.length, 'linked folder')}` : '')]);
    }
    const main = S.chats.filter((c) => c.kind !== 'sub');
    const subs = S.chats.length - main.length;
    rows.push(['Chats', `${plural(main.length, 'chat')}${subs ? ` (and ${plural(subs, 'sub-agent chat')})` : ''}, `
        + `${plural(main.reduce((n, c) => n + c.events.filter((e) => e.k === 'user' && !e.answer).length, 0), 'message')} sent`]);
    rows.push(['Skills', plural(skills.list().length, 'skill')]);
    const own = S.modes.filter((m) => !m.builtin).length;
    rows.push(['Modes', `${plural(S.modes.length, 'mode')}${own ? `, ${own} of yours` : ''}`]);
    const states = await SnapshotStore.list().catch(() => []);
    rows.push(['Saved states', states.length
        ? `${plural(states.length, 'machine')}, ${formatSize(states.reduce((n, s) => n + s.size, 0))}` : 'none']);
    rows.push(['MCP servers', S.mcpServers.length ? `${plural(S.mcpServers.length, 'server')}${S.mcpServers.some((x) => x.headers.length) ? ', with headers' : ''}` : 'none']);
    rows.push(['Providers', S.providers.length ? `${plural(S.providers.length, 'provider')}${S.providers.some((x) => x.apiKey) ? ', with API keys' : ''}` : 'none']);
    try {
        const est = await navigator.storage?.estimate?.();
        if (est?.usage != null) rows.push(['Browser storage', `${formatSize(est.usage)} used by this site${est.quota ? ` of ${formatSize(est.quota)} allowed` : ''}`]);
    } catch { /* no estimate */ }
    return { rows, project: p.name, hasSkills: skills.list().length > 0, hasStates: states.length > 0 };
}

/* The data buttons change what a running turn may be using, so not during one. */
export function dataBusy() {
    if (!anyRunning()) return false;
    alert('An agent is working; stop it first, then manage the data.');
    return true;
}

/* Unlink every linked folder (the folders on the computer stay as they are), then
 * delete everything in the workspace. */
async function emptyWorkspace(p) {
    const r = rt(p);
    for (const l of [...r.links.links]) await r.links.unlink(l.path);
    for (const e of (await r.volumes.volumeList(WORKSPACE_VOLUME, '/')) || []) await r.volumes.volumeDelete(WORKSPACE_VOLUME, `/${e.name}`);
    await r.volumes.volumeFlush(WORKSPACE_VOLUME).catch(() => {});
}
async function deleteSkills() {
    for (const e of (await skillsHost.volumeList(SKILLS_VOLUME, '/')) || []) await skillsHost.volumeDelete(SKILLS_VOLUME, `/${e.name}`);
    await skillsHost.volumeFlush(SKILLS_VOLUME).catch(() => {});
    await skills.refresh().catch(() => {});
}
/* Local storage keys of this page (settings, layout, card state, and the keys from before projects). */
const PAGE_KEYS = [SETTINGS, MODES_KEY, VM_PREFS, cardsOpen.KEY, ENV_VARS, LAYOUT];

/* Stop every VM, saving nothing, before the page reloads. */
async function stopAll() {
    for (const e of pool.all()) if (e.vm) await e._stop().catch(() => {});
    for (const r of runtimes.values()) await r.volumes.flush()?.catch?.(() => {});
    await skillsHost.flush()?.catch?.(() => {});
}

/* Each action: what it asks first, and what it does. confirm() returns false to stop. */
export const DATA_ACTIONS = {
    workspace: {
        ask() {
            const p = projectOf(S.chat);
            const links = rt(p).links.links;
            return `Delete everything in ${p.name}'s /workspace? This can't be undone.`
                + (links.length ? `\n\nIts ${links.length === 1 ? 'linked folder is' : `${links.length} linked folders are`} `
                    + 'unlinked first: the folders on your computer stay as they are.' : '');
        },
        busy: 'Emptying…',
        async run() {
            const p = projectOf(S.chat);
            await emptyWorkspace(p);
            files.open('/');
            addMessage('note', `Emptied ${p.name}'s /workspace.`);
        },
    },
    skills: {
        ask: () => `Delete all ${skills.list().length} skills? This can't be undone.`,
        busy: 'Deleting…',
        async run() { await deleteSkills(); addMessage('note', 'Deleted all skills.'); },
    },
    states: {
        ask: () => 'Delete the saved state of every machine of every project? Running VMs carry on; a paused one boots '
            + 'from scratch when used again, which takes longer.',
        busy: 'Deleting…',
        async run() {
            await SnapshotStore.clear();
            for (const e of pool.all()) e.saved = null;
            addMessage('note', 'Deleted the saved states.');
        },
    },
    chats: {
        ask: () => `Delete all ${S.chats.length} chats, with their messages and logs? The projects, workspaces and files stay. This can't be undone.`,
        busy: 'Deleting…',
        async run() {
            const p = projectOf(S.chat);
            await deleteAllChats();
            const old = [...S.sessions.values()].map((x) => x.chat);
            S.chat = null;
            for (const x of old) dropSession(x);
            await newChatIn(p);
            addMessage('note', 'Deleted all chats.');
        },
    },
    settings: {
        ask: () => 'Put the settings (modes and their prompts, tools, features, context, layout) back to their defaults, and reload the '
            + 'page? The providers, projects, workspaces, skills, saved states and chats are kept.',
        busy: 'Resetting…',
        async run() {
            for (const k of PAGE_KEYS) { try { localStorage.removeItem(k); } catch { /* none */ } }
            await stopAll();
            location.reload();
        },
    },
    everything: {
        ask: () => 'Delete everything this page keeps in this browser: every project with its workspace, the skills, saved '
            + 'states, chats, settings, the providers with their API keys, and the MCP servers with their headers? Then the '
            + 'page reloads. Linked folders are only unlinked: the folders on your computer stay as they are. This can\'t be undone.',
        busy: 'Deleting…',
        async run() {
            for (const e of pool.all()) if (e.vm) await e._stop().catch(() => {});
            for (const p of S.projects) await emptyWorkspace(p).catch(() => {});
            await deleteSkills();
            await SnapshotStore.clear();
            await deleteAllChats();   // nothing to save on the way out
            providerStore.clear();
            try { localStorage.removeItem(MCP_KEY); } catch { /* none */ }
            projectStore.clear();
            for (const k of PAGE_KEYS) { try { localStorage.removeItem(k); } catch { /* none */ } }
            await stopAll();
            location.reload();
        },
    },
};
