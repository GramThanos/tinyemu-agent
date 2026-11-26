// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ChatColumn.jsx — the open chat: its header (project / title, usage, the
 * context meter, Compact, ⓘ, the panel toggle), its log, and the message box.
 * Every chat drawn so far keeps its log mounted, hidden unless open, so each
 * keeps its place.
 */

import { S, short, UI, fmt } from '../app/state.js';
import { settings } from '../app/settings.js';
import { narrow, panelShown, showSidebar, sideHidden, togglePanel } from '../app/layout.js';
import { projectOf } from '../app/world.js';
import { renameChat } from '../app/chatOps.js';
import { ses } from '../app/sessions.js';
import { usageTotal } from '../app/stats.js';
import { compactNow } from '../app/agents.js';
import { toggleChatInfo, toggleContextPanel } from '../app/dialogs.js';
import ChatLog from './ChatLog.jsx';
import Composer from './Composer.jsx';
import ChatInfo from './ChatInfo.jsx';
import ContextPanel from './ContextPanel.jsx';

function ContextMeter() {
    const a = ses().agent;
    const info = a?.contextInfo();
    if (!info) return null;
    const c = S.chat.compactions;
    const pct = info.limit ? Math.min(100, Math.round((info.used / info.limit) * 100)) : 0;
    const triggerPct = Math.round((info.trigger / info.limit) * 100);
    const fill = info.used >= info.trigger ? 'over' : info.used >= info.trigger * 0.85 ? 'near' : '';
    const total = c.main + c.sub;
    const title = `Context: ${fmt(info.used)} of ${fmt(info.limit)} tokens (${pct}%)`
        + `${info.estimated ? ', estimated since the last compaction' : ', at the last response'}. `
        + (settings.compactAuto ? `Compacts by itself at ${fmt(info.trigger)}. ` : 'Automatic compaction is off. ')
        + `Compactions: ${c.main} main, ${c.sub} by sub-agents. Click for the breakdown.`;
    return (
        <button id="contextMeter" type="button" aria-expanded={UI.contextPanel} aria-controls="contextPanel" title={title}
            onClick={() => toggleContextPanel()}>
            <span className="cbar" aria-hidden="true">
                <span id="contextFill" className={fill} style={{ width: `${pct}%` }} />
                <span id="contextMark" style={{ left: `${triggerPct}%` }} hidden={!settings.compactAuto} />
            </span>
            <span id="contextText">{`${info.estimated ? '~' : ''}${short(info.used)} / ${short(info.limit)}${total ? ` · ⟲${total}` : ''}`}</span>
        </button>
    );
}

function Header() {
    const c = S.chat;
    const s = ses();
    const sub = c.kind === 'sub';
    const total = usageTotal(c);
    const brief = total.requests
        ? `in ${short(total.input + total.cacheWrite)} · cached ${short(total.cacheRead)} · out ${short(total.output)}`
            + (total.thinkingKnown ? ` (thinking ${short(total.thinking)})` : '')
        : '';
    return (
        <header id="chatHeader">
            <button id="sbShow" className="ghost" title="Show the sidebar" aria-label="Show the sidebar"
                hidden={!narrow() && !sideHidden()} onClick={showSidebar}>☰</button>
            <div className="crumbs">
                <span id="hdrProject">{projectOf(c).name}</span><span aria-hidden="true">/</span>
                <span id="hdrTitle" title="Double-click to rename" onDoubleClick={() => renameChat(c)}>{sub ? `↳ ${c.title}` : c.title}</span>
            </div>
            <span id="usageBrief" title="Tokens used in this conversation, sub-agents included">{brief}</span>
            <ContextMeter />
            {/* A compaction rewrites the history, so never during a turn. */}
            <button id="compactNow" title="Summarize the conversation so far, to free context" onClick={compactNow}
                disabled={!s.agent || !!s.running || sub || !s.agent.provider.transcript?.().length}>Compact</button>
            <button id="chatInfoBtn" title="This chat's figures" aria-label="This chat's figures" aria-expanded={UI.chatInfo}
                onClick={() => toggleChatInfo()}>ⓘ</button>
            <button id="panelToggle" title="Show or hide the environment panel: files, console, skills, machine, log"
                aria-pressed={panelShown()} onClick={togglePanel}>▣ Panel</button>
        </header>
    );
}

export default function ChatColumn() {
    const drawn = [...S.sessions.values()].filter((s) => s.drawn || s.chat === S.chat);
    return (
        <main id="center">
            <Header />
            <div id="chatView" className={settings.thinking ? '' : 'hide-thinking'}>
                {UI.chatInfo && <ChatInfo />}
                {UI.contextPanel && <ContextPanel />}
                <div id="logs">
                    {drawn.map((s) => <ChatLog key={s.chat.id} s={s} open={s.chat === S.chat} />)}
                </div>
                <Composer />
            </div>
        </main>
    );
}
