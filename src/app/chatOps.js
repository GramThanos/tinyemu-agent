// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * chatOps.js — managing chats and projects: opening, making, renaming and
 * deleting chats (with their sub-agents' chats, and asking about an environment
 * no other chat uses), and saving or deleting a project from its dialog.
 */

'use strict';

import { newChat, pickChat } from '../../js/chats.js';
import { envKey, isProjectSnapshot, projectShape, projectStorageKeys } from '../../js/projects.js';
import { deleteVolumeDatabases } from '../../js/volumes.js';
import { SnapshotStore } from '../../deps/jsLab/lib/vm/index.js';
import { ENV_NAME } from '../../js/tools.js';
import { emit } from './store.js';
import { chatById, descendsFrom, formatSize, plural, S, writeJSON } from './state.js';
import { pickOf } from './models.js';
import { envOf, pool, projectById, projectOf, rt, runtimes, saveProjects, writeGuestEnv, WORKSPACE_VOLUME } from './world.js';
import { volumeTotals } from './data.js';
import {
    addMessage, addWelcome, chatStore, drawSession, dropSession, logTopic, saveChat, saveChatSoon, sessionOf, unsaved, cancelSaves,
} from './sessions.js';
import { ensureChatShape } from './stats.js';
import { ensureAgent } from './agents.js';
import { files } from './files.js';
import { view } from './layout.js';
import { choose, closeProject } from './dialogs.js';

export const ACTIVE_CHAT = 'tinyemu-agent-active-chat';

/* Make `c` the open chat: its log, its project's files, and its figures. Other
 * chats' turns keep running meanwhile. */
export function showChat(c) {
    const before = S.chat ? projectOf(S.chat) : null;
    const beforeEnv = S.chat && S.chats.includes(S.chat) ? envOf(S.chat) : null;
    S.chat = c;
    writeJSON(ACTIVE_CHAT, c.id);
    const s = sessionOf(c);
    if (!s.drawn) drawSession(s);
    if (!c.events.length && c.kind !== 'sub') addWelcome(s);
    S.importedLog = null;
    if (projectOf(c) !== before) files.show(projectOf(c));
    // The chat on screen keeps its VM from being paused for idleness.
    if (beforeEnv) beforeEnv.lastActive = Date.now();
    ensureAgent(s);
    view.sideOpen = false;
    emit('ui', 'composer', 'log');
}

export async function switchChat(id) {
    if (S.chat?.id === id) return;
    const next = chatById(id);
    if (!next) return;
    saveChatSoon(S.chat, 0);
    showChat(next);
}

/* A new chat in a project, with its defaults: the project's environment, and its
 * model or else the one the open chat uses. */
export async function newChatIn(p = projectOf(S.chat)) {
    const c = ensureChatShape(newChat());
    c.project = p.id;
    c.env = envKey(p.env);
    c.pick = p.model || (S.chat ? pickOf(S.chat) : null);
    // The mode the open chat works in, so a new chat starts the way you were working.
    c.mode = S.chat && S.chat.kind !== 'sub' && S.chat.mode ? S.chat.mode : undefined;
    if (p.collapsed) { p.collapsed = false; saveProjects(); }
    S.chats.push(c);
    await chatStore.put(c).catch(() => {});
    envOf(c).join(c.id);
    await switchChat(c.id);
    emit('focus-prompt');
}

/* A chat goes with its sub-agents' chats; anything of them still working stops.
 * If no other chat uses its environment, the page asks whether to delete that too. */
export async function deleteChat(c) {
    const family = [c, ...S.chats.filter((x) => descendsFrom(x, c))];
    const busy = family.some((x) => S.sessions.get(x.id)?.running);
    const subs = family.length - 1;
    if ((c.events.length || busy) && !confirm(`Delete the chat "${c.title}"`
        + (subs ? ` and its ${subs} sub-agent chat${subs === 1 ? '' : 's'}` : '') + '? '
        + (busy ? 'Its agent is working, and will be stopped. ' : '')
        + 'Its messages and log go; the workspace and files stay. This can\'t be undone.')) return;
    const env = c.kind === 'sub' ? null : envOf(c);
    for (const x of family) S.sessions.get(x.id)?.running?.abort();
    S.chats = S.chats.filter((x) => !family.includes(x));
    for (const x of family) { unsaved.delete(x); await chatStore.delete(x.id).catch(() => {}); }
    const wasOpen = family.includes(S.chat);
    for (const x of family) if (x !== S.chat) dropSession(x);
    if (env) {
        env.leave(c.id);
        S.sessions.get(c.id)?.env?.leave(c.id);
        const others = S.chats.some((x) => x.kind !== 'sub' && envOf(x) === env);
        if (!others && env.kind === 'vm' && (env.vm || env.saved || env.status !== 'off')) {
            const choice = await choose('Delete its environment too?',
                `No other chat of ${env.project.name} uses ${env.label}. Delete it as well? Its VM stops and its saved state `
                + 'is deleted, freeing memory and storage; the workspace files stay.', [
                    { value: 'delete', label: 'Delete the environment', hint: 'The next chat that picks this machine boots it afresh.' },
                    { value: 'keep', label: 'Keep it', hint: 'It stays as it is (a VM nobody uses is paused after a while).' },
                ]);
            if (choice === 'delete') {
                await env.discard().catch((e) => addMessage('problem', `Could not delete ${env.label}: ${e.message}`));
            }
        }
    }
    if (!wasOpen) { emit('ui'); return; }
    const old = S.chat;
    // The open one: its parent, else the latest other chat of the project, or a new one.
    const p = projectOf(c);
    const next = (c.kind === 'sub' && chatById(c.parent))
        || pickChat(S.chats.filter((x) => x.kind !== 'sub' && projectById(x.project) === p), null)
        || null;
    S.chat = null;
    if (next) showChat(next);
    else {
        const n = ensureChatShape(newChat());
        Object.assign(n, { project: p.id, env: envKey(p.env), pick: pickOf(old) });
        S.chats.push(n);
        await chatStore.put(n).catch(() => {});
        showChat(n);
    }
    dropSession(old);
}

/* A sub-agent's chat that finished its task, deleted without asking when Settings →
 * Agent says so; its figures already count in the chat that delegated. It stays if
 * a chat of its own sub-agents does (one failed or was stopped), so that one keeps
 * its parent. Open, it gives way to the chat that delegated. */
export function removeFinishedSub(c) {
    if (c.kind !== 'sub' || !S.chats.includes(c) || S.chats.some((x) => x.parent === c.id)) return false;
    const parent = chatById(c.parent);
    if (S.chat === c && !parent) return false;
    S.chats = S.chats.filter((x) => x !== c);
    unsaved.delete(c);
    chatStore.delete(c.id).catch(() => {});
    if (S.chat === c) {
        S.chat = null;
        showChat(parent);
    }
    dropSession(c);
    if (parent) emit(logTopic(parent));   // its Delegate card no longer links to it
    emit('ui');
    return true;
}

export function renameChat(c) {
    if (!c || c.kind === 'sub') return;
    const t = prompt('Name this chat:', c.title);
    if (t === null || !t.trim()) return;
    c.title = t.trim().slice(0, 80);
    c.titled = true;
    c.updated = Date.now();
    saveChat(c);
    emit('ui');
}

/* Delete every chat (Settings → Data). */
export async function deleteAllChats() {
    cancelSaves();
    await chatStore.clear().catch(() => {});
    try { localStorage.removeItem(ACTIVE_CHAT); } catch { /* none */ }
    for (const e of pool.all()) for (const id of [...e.users]) e.leave(id);
    S.chats = [];
}

/* ---- projects: the dialog's actions --------------------------------------------- */

/* A project's environment variables, as the dialog's rows give them: the pairs,
 * and what is wrong with them. */
export function checkEnvRows(rows) {
    const pairs = [];
    const problems = [];
    const bad = new Set();   // row indexes with a bad name
    const seen = new Set();
    rows.forEach(([k, v], i) => {
        const name = k.trim();
        if (!name) { if (v) problems.push('a value has no name'); return; }
        if (!ENV_NAME.test(name)) { problems.push(`${name} is not a valid name (letters, digits and _, not starting with a digit)`); bad.add(i); }
        else if (seen.has(name)) { problems.push(`${name} is there twice`); bad.add(i); }
        seen.add(name);
        pairs.push([name, v]);
    });
    return { pairs, problems, bad };
}

/** Save the project dialog: `p` an existing project, or null for a new one. */
export async function saveProject(p, fields) {
    const isNew = !p;
    if (isNew) {
        p = projectShape({ ...fields, created: Date.now() });
        S.projects.push(p);
    } else {
        const varsChanged = JSON.stringify(p.envVars) !== JSON.stringify(fields.envVars);
        Object.assign(p, projectShape({ ...p, ...fields, updated: Date.now() }));
        // New login shells in the project's running VMs get the new variables.
        if (varsChanged) for (const e of pool.project(p, rt(p).volumes).envs.values()) if (e.bridge) writeGuestEnv(e);
    }
    saveProjects();
    closeProject();
    if (isNew) await newChatIn(p);
    emit('ui');
}

/* Ask before deleting a project, saying what goes: its chats, its workspace (with
 * how much is in it), its machines' saved states. Linked folders are only unlinked. */
async function confirmDeleteProject(p, mine) {
    const r = rt(p);
    const ws = await volumeTotals(r.volumes, WORKSPACE_VOLUME).catch(() => null);
    const states = (await SnapshotStore.list().catch(() => [])).filter((s) => isProjectSnapshot(s.key, p.id));
    const main = mine.filter((c) => c.kind !== 'sub').length;
    const links = r.links.links.length;
    const running = [...pool.project(p, r.volumes).envs.values()].filter((e) => e.vm).length;
    const lines = [
        `• ${plural(main, 'chat')}${mine.length > main ? ` (and ${plural(mine.length - main, 'sub-agent chat')})` : ''}, with ${mine.length === 1 ? 'its' : 'their'} messages and logs`,
        `• its /workspace${ws ? `: ${plural(ws.files, 'file')}, ${formatSize(ws.bytes)}` : ''}`,
        `• ${states.length ? `the saved state${states.length === 1 ? '' : 's'} of ${plural(states.length, 'machine')} (${formatSize(states.reduce((n, s) => n + s.size, 0))})` : 'its machines\' saved states (none now)'}`
            + (running ? `; ${plural(running, 'running VM')} stops` : ''),
    ];
    const text = `This deletes from this browser:\n${lines.join('\n')}\n\n`
        + (links ? `Its ${plural(links, 'linked folder')} ${links === 1 ? 'is' : 'are'} only unlinked: the folders on your computer stay as they are.\n\n` : '')
        + 'This can\'t be undone. To keep any files, download them from the Files panel first.';
    return await choose(`Delete the project "${p.name}"?`, text, [
        { value: 'delete', label: 'Delete the project and its data', hint: 'Everything listed above goes.' },
    ]) === 'delete';
}

export async function deleteProject(p) {
    if (!p || S.projects.length < 2) return;
    const mine = S.chats.filter((c) => projectOf(c) === p);
    if (mine.some((c) => S.sessions.get(c.id)?.running)) { alert('An agent is working in this project; stop it first.'); return; }
    if (!await confirmDeleteProject(p, mine)) return;
    closeProject();
    const r = rt(p);
    const envs = pool.project(p, r.volumes);
    for (const e of [...envs.envs.values()]) await e.discard().catch(() => {});
    // Linked folders first, so nothing reaches the disk while the workspace empties.
    for (const l of [...r.links.links]) await r.links.unlink(l.path).catch(() => {});
    for (const e of (await r.volumes.volumeList(WORKSPACE_VOLUME, '/')) || []) await r.volumes.volumeDelete(WORKSPACE_VOLUME, `/${e.name}`);
    // Saved states of machines this page hasn't touched since it loaded, too.
    for (const s of await SnapshotStore.list().catch(() => [])) if (isProjectSnapshot(s.key, p.id)) await SnapshotStore.delete(s.key);
    for (const c of mine) { unsaved.delete(c); await chatStore.delete(c.id).catch(() => {}); }
    S.chats = S.chats.filter((c) => !mine.includes(c));
    S.projects = S.projects.filter((x) => x !== p);
    saveProjects();
    const wasOpen = mine.includes(S.chat);
    for (const c of mine) if (c !== S.chat) dropSession(c);
    if (wasOpen) {
        const old = S.chat;
        const next = pickChat(S.chats.filter((c) => c.kind !== 'sub'), null);
        S.chat = null;
        if (next) showChat(next); else await newChatIn(S.projects[0]);
        dropSession(old);
    } else {
        emit('ui');
    }
    // Its volumes' databases last: no VM runs with them now, and the page lets go first.
    try {
        await r.volumes.close();
        runtimes.delete(p.id);
        pool.projects.delete(p.id);
        await deleteVolumeDatabases(projectStorageKeys(p.id));
    } catch (e) {
        console.warn('projects: could not delete the volumes of', p.id, e);
    }
}

/* The latest chat of a project, made if it has none, opened. */
export async function openProjectChat(p) {
    if (projectOf(S.chat) === p) return;
    const latest = S.chats.filter((c) => c.kind !== 'sub' && c.project === p.id).sort((a, b) => b.updated - a.updated)[0];
    if (latest) await switchChat(latest.id); else await newChatIn(p);
}
