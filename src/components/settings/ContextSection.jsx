// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ContextSection.jsx — Settings → Context: how full the model's context window
 * is, and compaction (when it happens by itself, and the window's size).
 */

import { useState } from 'react';
import { fmt, S } from '../../app/state.js';
import { COMPACT_LEVELS, setSettings, settings, windowOf } from '../../app/settings.js';
import { ses } from '../../app/sessions.js';
import { Check } from './controls.jsx';

function ContextStats() {
    const a = ses().agent;
    const info = a?.contextInfo();
    if (!info) return <dl id="contextStats" className="kvs"><dt>Conversation</dt><dd>none yet: connect a model</dd></dl>;
    const c = S.chat.compactions;
    const pct = info.limit ? Math.min(100, Math.round((info.used / info.limit) * 100)) : 0;
    const w = windowOf(a.provider);
    const last = info.last;
    const how = last && ({ auto: 'automatic', overflow: 'the model reported the context was full', manual: 'by hand' }[last.reason] || last.reason);
    const rows = [
        ['Window', `${fmt(w.tokens)} tokens (${w.source})`],
        ['In use', `${info.estimated ? '~' : ''}${fmt(info.used)} tokens, ${pct}%` + (info.estimated ? ' (estimate until the next response)' : ' (at the last response)')],
        ['Compacts at', settings.compactAuto
            ? `${fmt(info.trigger)} tokens: ${settings.compactAt}% of the window${a.provider.maxOutput ? ', less room for a reply' : ''}`
            : 'never by itself (off)'],
        ['Compactions', `${c.main} in this conversation, ${c.sub} by sub-agents`],
        ...(last ? [['Last', `${new Date(last.at).toLocaleTimeString()}, ${how}: ${fmt(last.before)} → `
            + (last.measured === null ? `~${fmt(last.after)} (estimate)` : `${fmt(last.measured)}`) + ' tokens']] : []),
    ];
    return <dl id="contextStats" className="kvs">{rows.map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}</dl>;
}

export default function ContextSection() {
    const [windowText, setWindowText] = useState(settings.contextWindow ? String(settings.contextWindow) : '');
    return (
        <div id="setContext" className="dlg-pane page" role="tabpanel">
            <h2>Context</h2>
            <p className="hint">How full the model&apos;s context window is, and compaction: the conversation so far is summarized
                by the same model and the summary takes its place. Files are not affected.</p>
            <div className="toggles">
                <label><Check k="compactAuto" /> Compact by itself when the context reaches
                    <select value={settings.compactAt} onChange={(e) => setSettings({ compactAt: Number(e.target.value) })}>
                        {COMPACT_LEVELS.map((n) => <option key={n} value={n}>{`${n}%`}</option>)}
                    </select> of the window</label>
                <label>Context window <input type="number" min={1000} step={1000} size={9} placeholder="the model's" value={windowText}
                    onChange={(e) => setWindowText(e.target.value)}
                    onBlur={() => {
                        const n = parseInt(windowText, 10);
                        const v = Number.isInteger(n) && n >= 1000 ? n : null;
                        setSettings({ contextWindow: v });
                        setWindowText(v ? String(v) : '');
                    }} /> tokens
                    <span className="hint">(leave empty to use what the model reports)</span></label>
            </div>
            <h2>The open chat</h2>
            <ContextStats />
        </div>
    );
}
