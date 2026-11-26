// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Sidebar.jsx — the projects and their chats. A sub-agent's chat shows under its
 * parent while that family is open; one whose parent was deleted stays reachable
 * at the end. At the foot: Settings, and the open chat's environment's status.
 */

import { envKey } from '../../js/projects.js';
import { chatById, S } from '../app/state.js';
import { distroInfo, envLabelOf, STATUS_WORDS } from '../app/machines.js';
import { pickName } from '../app/models.js';
import { envKeyOf, envOf, projectById, projectOf, saveProjects } from '../app/world.js';
import { deleteChat, newChatIn, renameChat, switchChat } from '../app/chatOps.js';
import { openProject, openSettings } from '../app/dialogs.js';
import { hideSidebar } from '../app/layout.js';

function ChatRow({ c }) {
    const s = S.sessions.get(c.id);
    const sub = c.kind === 'sub';
    const subs = S.chats.filter((x) => x.parent === c.id).length;
    const title = sub
        ? `Sub-agent: ${c.title}\n${c.subName || ''}, ${c.status || 'interrupted'}\nStarted ${new Date(c.created).toLocaleString()}\nRead-only: the main agent gave it its task`
        : `${c.title}\nStarted ${new Date(c.created).toLocaleString()}` + (c.model ? `\nModel: ${c.model}` : '')
            + `\nEnvironment: ${envLabelOf(envKeyOf(c))}`
            + (subs ? `\n${subs} sub-agent${subs === 1 ? '' : 's'}` : '') + '\nDouble-click to rename';
    return (
        <div className={`crow${sub ? ' sub' : ''}`} aria-current={c === S.chat}>
            <button type="button" className="cname" title={title} onClick={() => switchChat(c.id)}
                onDoubleClick={sub ? undefined : () => renameChat(c)}>{sub ? `↳ ${c.title}` : c.title}</button>
            {s?.running ? <span className="spinner cbusy" title={sub ? 'working' : 'the agent is working in this chat'} />
                : sub && c.status && c.status !== 'running'
                    ? <span className={`cstate ${c.status === 'done' ? 'done' : 'failed'}`} title={c.status}>{c.status === 'done' ? '✓' : '✗'}</span>
                    : null}
            {s?.asks.length > 0 && <span className="cmark" title="The agent is asking you something here">?</span>}
            <button type="button" className="cclose" title={sub ? 'Delete this sub-agent\'s chat' : 'Delete this chat'}
                aria-label={`Delete the chat ${c.title}`} onClick={() => deleteChat(c)}>×</button>
        </div>
    );
}

function ProjectGroup({ p, current, family }) {
    const toggle = () => { p.collapsed = !p.collapsed; saveProjects(); };
    const mine = S.chats.filter((c) => c.kind !== 'sub' && projectById(c.project) === p).sort((a, b) => b.updated - a.updated);
    const envName = envLabelOf(envKey(p.env));
    return (
        <div className="proj">
            <div className={`proj-row${current ? ' current' : ''}`}>
                <button type="button" className="twist" aria-expanded={!p.collapsed} onClick={toggle}
                    aria-label={p.collapsed ? `Show the chats of ${p.name}` : `Hide the chats of ${p.name}`}>{p.collapsed ? '▸' : '▾'}</button>
                <button type="button" className="pname" onClick={toggle} onDoubleClick={() => openProject(p)}
                    title={`${p.name}\nNew chats: ${envName}${p.model ? `, ${pickName(p.model)}` : ''}\nDouble-click for its settings`}>{p.name}</button>
                <span className="penv" title={`New chats start in ${envName}`}>{p.env.kind === 'vm' ? distroInfo(p.env.distro).arch : 'bash.js'}</span>
                <button type="button" className="pbtn" title={`New chat in ${p.name}`} aria-label={`New chat in ${p.name}`} onClick={() => newChatIn(p)}>+</button>
                <button type="button" className="pbtn" title={`${p.name}: settings, files and folders`} aria-label={`${p.name}: settings, files and folders`}
                    onClick={() => openProject(p)}>⋯</button>
            </div>
            {!p.collapsed && (
                <div className="chats">
                    {!mine.length && <div className="empty">No chats yet</div>}
                    {mine.map((c) => [
                        <ChatRow key={c.id} c={c} />,
                        ...(c.id === family ? S.chats.filter((x) => x.kind === 'sub' && x.parent === c.id).map((x) => <ChatRow key={x.id} c={x} />) : []),
                    ])}
                </div>
            )}
        </div>
    );
}

/* The badge at the foot of the sidebar: the open chat's environment. */
function StatusBadge() {
    const env = envOf(S.chat);
    let text, kind = '';
    if (env.kind === 'bashjs') { text = 'bash.js'; kind = 'ready'; }
    else if (env.status === 'starting') {
        const secs = env._startedAt ? Math.round((Date.now() - env._startedAt) / 1000) : 0;
        text = `${env.stage || 'starting'} · ${secs} s${env.downloading ? ' · downloading' : ''}`;
    } else if (env.status === 'ready') { text = 'VM ready'; kind = 'ready'; }
    else if (env.status === 'failed') { text = `VM failed: ${env.error}`; kind = 'error'; }
    else { text = `VM ${STATUS_WORDS[env.status]}`; kind = 'idle'; }
    return <span id="status" className={`badge ${kind}`} role="status" title={text}>{text}</span>;
}

export default function Sidebar({ ref, children }) {
    const cur = projectOf(S.chat);
    const family = S.chat.kind === 'sub' ? S.chat.parent : S.chat.id;
    const orphans = S.chats.filter((x) => x.kind === 'sub' && !chatById(x.parent));
    return (
        <aside id="sidebar" aria-label="Projects and chats" ref={ref}>
            {children}
            <div className="sb-head">
                <span className="brand">TinyEMU Agent</span>
                <button id="sbHide" className="ghost" title="Hide the sidebar" aria-label="Hide the sidebar" onClick={hideSidebar}>«</button>
            </div>
            <button id="newChatBtn" title="Start a new chat in the open chat's project (others keep working)" onClick={() => newChatIn(cur)}>
                <span className="plus">+</span> New chat
            </button>
            <div className="sb-title">
                <span>Projects</span>
                <button id="newProjectBtn" className="ghost" title="New project" aria-label="New project" onClick={() => openProject(null)}>+</button>
            </div>
            <nav id="projectList" aria-label="Projects">
                {S.projects.map((p) => <ProjectGroup key={p.id} p={p} current={p === cur} family={family} />)}
                {orphans.map((x) => <ChatRow key={x.id} c={x} />)}
            </nav>
            <div className="sb-foot">
                <button id="openSettings" className="ghost" title="Models, tools, the system prompt, and what this page keeps"
                    onClick={() => openSettings(S.providers.length ? 'agent' : 'models')}>⚙ Settings</button>
                <StatusBadge />
            </div>
        </aside>
    );
}
