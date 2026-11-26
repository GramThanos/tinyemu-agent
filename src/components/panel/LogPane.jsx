// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * LogPane.jsx — the Log tab: every exchange of the open chat, sub-agents
 * included (src/app/stats.js), as JSON rows filled when opened; its token usage
 * and tool calls; and Export / Import of the log with the conversation, so an
 * import can carry on from it. No key is in either.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { toolArgText } from '../../../js/Agent.js';
import { emit, useTopics } from '../../app/store.js';
import { fmt, S, seconds } from '../../app/state.js';
import { ensureChatShape, LOG_FORMAT, shownExchanges, USAGE_COLUMNS, usageTotal } from '../../app/stats.js';
import { addMessage, saveChatSoon, ses } from '../../app/sessions.js';
import { changed } from '../../app/agents.js';

const PREVIEW = {
    start: (e) => (e.agent === 'main' ? `${e.model || ''}` : `${e.resumed ? '(resumed) ' : ''}${e.description || ''}`),
    user: (e) => (e.retry ? '(asked again)' : e.resumed ? '(resumed after a reload)' : `${e.injected ? '(sent while working) ' : ''}${e.text}`),
    response: (e) => `${e.stop}${e.toolCalls?.length ? ` · ${e.toolCalls.map((c) => c.name).join(', ')}` : ''}${e.text ? ` · ${e.text}` : ''}`,
    tool: (e) => `${e.name}${e.isError ? ' ✗' : ''}${Number.isFinite(e.ms) ? ` · ${seconds(e.ms)}` : ''} · ${toolArgText(e)}`,
    compaction: (e) => `${e.reason}: ${e.before} → ~${e.after} tokens`,
    error: (e) => e.message,
};

function LogRow({ e, imported }) {
    const [open, setOpen] = useState(false);
    const preview = (PREVIEW[e.type]?.(e) ?? '').replace(/\s+/g, ' ').slice(0, 200);
    return (
        // Filled when opened: a long log would otherwise hold every JSON text at once.
        <details className={imported ? 'imported' : undefined} onToggle={(ev) => setOpen(ev.currentTarget.open)}>
            <summary>
                <span className="lt">{e.t ? new Date(e.t).toLocaleTimeString() : ''}</span>
                <span className="la">{e.agent ?? ''}</span>
                <span className="ly">{e.type ?? ''}</span>
                <span className="lx">{preview}</span>
            </summary>
            {open && <pre>{JSON.stringify(e, null, 2)}</pre>}
        </details>
    );
}

function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportLog() {
    const a = ses().agent;
    const imported = S.importedLog;
    const data = {
        format: LOG_FORMAT, version: 1, exported: new Date().toISOString(),
        ...(imported ? { reexported: true } : {}),
        model: a && !imported ? { kind: a.provider.kind ?? null, model: a.provider.model ?? null, label: ses().label } : null,
        conversation: a && !imported ? a.provider.exportHistory?.() ?? null : imported?.conversation ?? null,
        exchanges: shownExchanges(),
    };
    download(`tinyemu-agent-log-${data.exported.replace(/[:.]/g, '-')}.json`, JSON.stringify(data, null, 2));
}

async function importLog(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { addMessage('problem', `${file.name} is not a JSON file.`); return; }
    if (data?.format !== LOG_FORMAT || !Array.isArray(data.exchanges)) {
        addMessage('problem', `${file.name} is not a log exported from this page.`);
        return;
    }
    S.importedLog = { exchanges: data.exchanges.filter((e) => e && typeof e === 'object'), conversation: data.conversation ?? null };
    emit('log');
    // The conversation goes back only into the same kind of provider: each keeps
    // its own wire format.
    const s = ses();
    const conv = data.conversation;
    const kind = data.model?.kind;
    if (!conv || !s.agent?.provider.importHistory) return;
    if (s.running) { addMessage('note', 'Opened the log. Stop the agent and import again to restore its conversation.'); return; }
    if (kind !== s.agent.provider.kind) {
        addMessage('note', `Opened the log. Its conversation was with ${data.model?.label || 'another provider'}, so it can't be `
            + 'restored into this one; connect the same kind of provider to restore it.');
        return;
    }
    if (!confirm(`Also restore the conversation from ${file.name} into this chat? It replaces this chat's conversation with the model.`)) return;
    try {
        s.agent.provider.importHistory(conv);
        s.agent.closePending();
        addMessage('note', `Restored the conversation from ${file.name}${data.model?.label ? ` (${data.model.label})` : ''}. `
            + 'Your next message carries on from it; the chat above does not show its earlier messages.');
        S.importedLog = null;
        saveChatSoon(S.chat, 0);
        changed();
        emit('log');
    } catch (e) {
        addMessage('problem', `Could not restore the conversation: ${e.message}`);
    }
}

function UsageTable({ c }) {
    const total = usageTotal(c);
    return (
        <table id="usageTable" className="stats">
            <thead><tr>{['', ...USAGE_COLUMNS.map(([, l]) => l)].map((l) => <th key={l}>{l}</th>)}</tr></thead>
            <tbody>
                {[[c.kind === 'sub' ? 'This sub-agent' : 'Main agent', c.usage.main], ['Sub-agents', c.usage.sub], ['Compaction', c.usage.compaction], ['Total', total, 'total']]
                    .map(([label, t, cls]) => (
                        <tr key={label} className={cls}>
                            <td>{label}</td>
                            {USAGE_COLUMNS.map(([k]) => <td key={k}>{k === 'thinking' && !t.thinkingKnown ? '—' : fmt(t[k])}</td>)}
                        </tr>
                    ))}
            </tbody>
        </table>
    );
}

function ToolTable({ c }) {
    const names = Object.keys(c.toolStats).sort();
    const total = { calls: 0, failed: 0, total: 0, longest: 0 };
    for (const n of names) {
        const t = c.toolStats[n];
        total.calls += t.calls; total.failed += t.failed; total.total += t.total; total.longest = Math.max(total.longest, t.longest);
    }
    return (
        <table id="toolStatsTable" className="stats">
            <thead><tr>{['', 'Calls', 'Failed', 'Total time', 'Average', 'Longest'].map((l) => <th key={l}>{l}</th>)}</tr></thead>
            <tbody>
                {!names.length ? <tr><td colSpan={6}>No tool calls yet.</td></tr>
                    : [...names.map((n) => [n, c.toolStats[n]]), ['Total', total, 'total']].map(([label, t, cls]) => (
                        <tr key={label} className={cls}>
                            {[label, fmt(t.calls), fmt(t.failed), seconds(t.total), seconds(Math.round(t.total / t.calls)), seconds(t.longest)]
                                .map((v, i) => <td key={i}>{v}</td>)}
                        </tr>
                    ))}
            </tbody>
        </table>
    );
}

export default function LogPane() {
    useTopics('log');
    const c = S.chat;
    const [filter, setFilter] = useState('all');
    const pick = useRef(null);
    const list = useRef(null);
    const atEnd = useRef(true);
    const exchanges = shownExchanges();
    const agents = [...new Set(exchanges.map((e) => e.agent))];
    const f = agents.includes(filter) ? filter : 'all';
    useLayoutEffect(() => { if (atEnd.current && list.current) list.current.scrollTop = list.current.scrollHeight; });
    const clear = () => {
        if (S.importedLog) S.importedLog = null;
        else c.exchanges = [];
        saveChatSoon(c);
        emit('log');
    };
    const shown = exchanges.filter((e) => f === 'all' || e.agent === f);
    return (
        <div id="logPane" role="tabpanel" aria-labelledby="tabLog">
            <div id="logBar">
                <select id="logFilter" aria-label="Show the exchanges of" value={f} onChange={(e) => setFilter(e.target.value)}>
                    <option value="all">every agent</option>
                    {agents.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <span id="logCount">{`${exchanges.length.toLocaleString()} exchange${exchanges.length === 1 ? '' : 's'}`
                    + (S.importedLog ? ' · imported from a file' : '')}</span>
                <button id="logExport" disabled={!exchanges.length} onClick={exportLog}
                    title="Save every exchange of this conversation, and the conversation itself, as a JSON file">Export</button>
                <button id="logImport" onClick={() => pick.current.click()} title="Open an exported log; it can also restore that conversation">Import</button>
                <button id="logClear" disabled={!exchanges.length} onClick={clear} title="Empty the log (the conversation goes on)">Clear</button>
                <input id="logPick" ref={pick} type="file" accept=".json,application/json" hidden
                    onChange={(e) => { const file = e.target.files[0]; e.target.value = ''; if (file) importLog(file); }} />
            </div>
            <div id="logStats" className="page">
                <details>
                    <summary>Token usage and tool calls of this chat</summary>
                    <h2>Token usage <button title="Start counting from zero"
                        onClick={() => { c.usage = ensureChatShape({}).usage; saveChatSoon(c); emit('log', 'ui'); }}>Reset</button></h2>
                    <div className="tablewrap"><UsageTable c={c} /></div>
                    <p className="hint">Input counts uncached input tokens only; cached tokens are under Cache read. Output includes
                        thinking. Claude doesn&apos;t report thinking tokens separately (—).</p>
                    <h2>Tool calls <button title="Start counting from zero"
                        onClick={() => { c.toolStats = {}; saveChatSoon(c); emit('log', 'ui'); }}>Reset</button></h2>
                    <div className="tablewrap"><ToolTable c={c} /></div>
                </details>
            </div>
            <div id="logList" role="list" ref={list}
                onScroll={(e) => { const L = e.currentTarget; atEnd.current = L.scrollTop + L.clientHeight >= L.scrollHeight - 40; }}>
                {!exchanges.length
                    ? <div className="files-empty">Nothing yet. Every message, model reply and tool call of this conversation, sub-agents included, appears here.</div>
                    : shown.map((e, i) => <LogRow key={`${i}-${e.t}`} e={e} imported={!!S.importedLog} />)}
            </div>
        </div>
    );
}
