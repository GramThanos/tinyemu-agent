// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ContextPanel.jsx — the context meter's breakdown: how the window is used
 * (js/figures.js contextBreakdown: the system prompt and each tool definition
 * estimated from their text, the rest Messages), its parts adding up to the window.
 */

import { contextBreakdown } from '../../js/figures.js';
import { fmt, percent, S, short } from '../app/state.js';
import { settings, windowOf } from '../app/settings.js';
import { currentSystem, skills } from '../app/world.js';
import { ses } from '../app/sessions.js';

export const CONTEXT_COLORS = {
    messages: '#4f8fe0', tools: '#2fb39a', skills: '#c99a2e', system: '#a07ae0', buffer: '#5b6270', free: '#2a2e37',
};

export default function ContextPanel() {
    const a = ses().agent;
    const info = a?.contextInfo();
    if (!info) {
        return (
            <div id="contextPanel" className="panel floating" role="dialog" aria-label="Context window">
                <h3>Context</h3><p className="muted">No conversation yet: connect a model.</p>
            </div>
        );
    }
    const system = a.provider.system ?? a._system ?? currentSystem();
    const b = contextBreakdown({
        used: info.used, limit: info.limit, trigger: info.trigger, auto: settings.compactAuto,
        system: typeof system === 'string' ? system : JSON.stringify(system),
        defs: a.tools.defs, transcript: info.used ? [] : (a.provider.transcript?.() ?? []),
    });
    const enabledSkills = skills.enabled().length;
    const w = windowOf(a.provider);
    const c = S.chat;
    const notes = [
        b.measured
            ? `In use: ${fmt(info.used)} tokens${info.estimated ? ', estimated since the last compaction' : ', measured at the last response'}. `
                + 'The system prompt and tool definitions are estimated from their text (about 4 characters a token); Messages is the rest.'
            : 'No response yet: everything is estimated from the text (about 4 characters a token).',
        `Window: ${fmt(info.limit)} tokens, ${w.source}.`,
        settings.compactAuto
            ? `Compacts by itself at ${fmt(info.trigger)} tokens (${settings.compactAt}%${a.provider.maxOutput ? ', less room for a reply' : ''}); the buffer above that stays free.`
            : 'Automatic compaction is off (Settings → Context).',
        `Compactions: ${c.compactions.main} in this chat${c.compactions.sub ? `, ${c.compactions.sub} by sub-agents` : ''}.`,
    ];
    return (
        <div id="contextPanel" className="panel floating" role="dialog" aria-label="Context window">
            <h3>Context</h3>
            <div className="big">
                <b>{`${Math.round((b.used / info.limit) * 100)}% used`}</b>
                <span className="muted">{`${b.measured && !info.estimated ? '' : '~'}${short(b.used)} / ${short(info.limit)}`}</span>
            </div>
            <div className="seg">
                {b.segments.filter((p) => p.tokens && p.key !== 'free').map((p) => (
                    <span key={p.key} title={`${p.label}: ${fmt(p.tokens)} tokens`}
                        style={{ width: `${(p.tokens / info.limit) * 100}%`, background: CONTEXT_COLORS[p.key] }} />
                ))}
            </div>
            <div className="frows">
                {b.segments.filter((p) => !(p.key === 'buffer' && !settings.compactAuto)).map((p) => [
                    <span key={`${p.key}-sw`} className="sw" style={{ background: CONTEXT_COLORS[p.key], outline: p.key === 'free' ? '1px solid #3a4150' : undefined }} />,
                    <span key={`${p.key}-l`}>{p.key === 'skills' ? `${p.label}${enabledSkills ? ` (${enabledSkills})` : ' (none on)'}` : p.label}</span>,
                    <span key={`${p.key}-n`} className="n">{short(p.tokens)}</span>,
                    <span key={`${p.key}-p`} className="p">{percent(p.tokens, info.limit)}</span>,
                ])}
            </div>
            <details>
                <summary>{`Tool definitions: ${b.tools.length} tools`}</summary>
                <div className="frows">
                    {b.tools.map((t) => [
                        <span key={`${t.name}-0`} />,
                        <span key={`${t.name}-l`} className="sub">{t.name}</span>,
                        <span key={`${t.name}-n`} className="n">{short(t.tokens)}</span>,
                        <span key={`${t.name}-p`} className="p">{percent(t.tokens, info.limit)}</span>,
                    ])}
                </div>
            </details>
            {notes.map((t) => <p key={t} className="note">{t}</p>)}
        </div>
    );
}
