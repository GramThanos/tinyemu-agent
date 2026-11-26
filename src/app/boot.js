// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * boot.js — the page's start: the machines' list, the chats saved in this
 * browser, the one to open, the MCP servers, and what a reload cut off; then the
 * page-wide listeners and window.agentDemo, for console poking and for driving
 * the page from tests. agentDemo is in the dev server only (and in a build made
 * with VITE_AGENT_DEMO=1): it hands out the tools, the keys and the chats.
 */

'use strict';

import { Agent } from '../../js/Agent.js';
import { pickChat } from '../../js/chats.js';
import { envKey, DEFAULT_PROJECT } from '../../js/projects.js';
import { pauses } from '../../js/pause.js';
import { emit } from './store.js';
import { anyRunning, chatById, readJSON, S, seconds } from './state.js';
import { settings } from './settings.js';
import { loadDistros } from './machines.js';
import { connections, injectProvider } from './models.js';
import { mcp } from './mcpServers.js';
import { envOf, pool, projectById, projectOf, rt, skills, skillsHost } from './world.js';
import { addMessage, chatStore, flushChats, saveChat, ses, unsaved } from './sessions.js';
import { ensureChatShape } from './stats.js';
import { askUser, delegate, ensureAgent, offerResume, sendPrompt, setChatEnv, setChatModel, changed } from './agents.js';
import { ACTIVE_CHAT, deleteChat, newChatIn, showChat, switchChat } from './chatOps.js';
import { copyFolderIn, files, linkFolder } from './files.js';
import { layout, panelShown } from './layout.js';

/* A chat saved before projects belongs to the default one and keeps the VM it ran in. */
function chatDefaults(c) {
    if (c.kind === 'sub') return c;
    if (!S.projects.some((p) => p.id === c.project)) c.project = S.projects.some((p) => p.id === DEFAULT_PROJECT) ? DEFAULT_PROJECT : S.projects[0].id;
    if (typeof c.env !== 'string' || !/^(bashjs|vm:[\w-][\w.-]*)$/.test(c.env)) c.env = envKey(projectById(c.project).env);
    if (c.pick && (typeof c.pick.provider !== 'string' || typeof c.pick.model !== 'string')) c.pick = null;
    return c;
}

let booted = null;
export function boot() {
    booted ||= start();
    return booted;
}

async function start() {
    mcp.sync();   // connect the MCP servers that are on, in the background
    await loadDistros();
    try {
        S.chats = ((await chatStore.all()) || []).filter((c) => c && c.id && Array.isArray(c.events));
    } catch (e) {
        console.warn('chats: could not load', e);
    }
    S.chats.sort((a, b) => a.created - b.created);
    for (const c of S.chats) chatDefaults(ensureChatShape(c));
    // Every chat is a user of its environment, open or not, so deleting one knows who else uses it.
    for (const c of S.chats) if (c.kind !== 'sub') envOf(c).join(c.id);
    const wanted = readJSON(ACTIVE_CHAT);
    const open = chatById(wanted) || pickChat(S.chats.filter((c) => c.kind !== 'sub'), null);
    if (open) showChat(open);
    else await newChatIn(S.projects[0]);
    S.loaded = true;
    skills.refresh().catch(() => {});
    if (S.providers.length === 0) {
        addMessage('note', 'Welcome. To start, set up a model: Settings → Models (bottom left). Claude, OpenAI, Gemini, OpenRouter, Mistral, Groq, '
            + 'DeepSeek, xAI and more; a server on this computer (Ollama, LM Studio, Open WebUI, llama.cpp, ...); or a model in this browser with WebGPU.');
    }
    // The open chat's VM starts now, so it is ready (or resumed) by the first message.
    envOf(S.chat).warm();
    listen();
    emit('ui');
    offerResume();
}

function listen() {
    // Try to keep the last few seconds of every chat, and the page's volumes, when the page goes.
    addEventListener('pagehide', () => {
        for (const c of S.chats) if (S.sessions.get(c.id)?.agent) unsaved.add(c);
        if (unsaved.size) flushChats();
        pool.flushAll();
        skillsHost.flush()?.catch?.(() => {});
        for (const e of pool.all()) e.vm?.flush?.();
    });
    // A pause long enough to notice, while something runs.
    pauses.on((ms, why) => {
        for (const [, x] of S.sessions) {
            if (!x.running) continue;
            x.chat.figs.breaks.pauses++;
            x.chat.figs.breaks.pauseMs += Math.round(ms);
        }
        if (!anyRunning()) return;
        addMessage('note', `⏸ The browser paused this page for ${seconds(Math.round(ms))}${why === 'frozen' ? ' (it froze the tab)' : ''}; `
            + 'tool timeouts leave that time out.');
    });
    // Coming back to the page, perhaps from editing a linked file elsewhere.
    addEventListener('focus', () => {
        if (!S.chat) return;
        if (layout.tab === 'files' && panelShown()) files.refresh();
        else rt(projectOf(S.chat)).links.sync().catch(() => {});
    });
    // A starting VM's clock, for the badge.
    setInterval(() => {
        let starting = false;
        for (const e of pool.all()) {
            if (e.status === 'starting') { e._startedAt ||= Date.now(); starting = true; } else e._startedAt = 0;
        }
        if (starting) emit('ui');
    }, 1000);
}

if (import.meta.env.DEV || import.meta.env.VITE_AGENT_DEMO === '1') {
    window.agentDemo = {
        get vm() { return envOf(S.chat).vm; },
        get bridge() { return envOf(S.chat).bridge; },
        get tools() { return envOf(S.chat).toolsFor(S.chat.id); },
        env: () => envOf(S.chat), pool, projects: () => S.projects, providers: () => S.providers, connections,
        skills, links: () => rt(projectOf(S.chat)).links, volumes: () => rt(projectOf(S.chat)).volumes, skillsHost,
        linkFolder, copyFolderIn, files, settings,
        chats: () => S.chats, openChat: () => S.chat, switchChat, newChatIn, deleteChat, saveChat, setChatEnv, setChatModel, Agent,
        /* A scripted provider (the provider interface) for the open chat, as if it were a model picked. */
        async useProvider(provider, label = 'scripted') {
            const pick = injectProvider(provider, label);
            S.chat.pick = pick;
            const s = ses();
            s.pick = null;
            await ensureAgent(s);
            changed();
            return s.agent;
        },
        /* Send a message in the open chat, as the message box does. */
        send(text) { ses().draft = text; return sendPrompt(); },
        usage: () => S.chat.usage, exchanges: () => S.chat.exchanges, toolStats: () => S.chat.toolStats,
        mcp, mcpServers: () => S.mcpServers,
        sessions: S.sessions, session: () => ses(), delegate, askUser, pauses, offerResume,
    };
}
