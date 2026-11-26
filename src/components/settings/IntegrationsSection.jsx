// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * IntegrationsSection.jsx — Settings → Integrations: MCP servers (src/app/
 * mcpServers.js). Each card: on or off, name, URL, headers (values hidden, as they
 * are usually tokens), Connect, the server's tools with a tick each, and its
 * instructions. The hub's changes redraw it ('mcp').
 */

import { useEffect, useRef, useState } from 'react';
import { useTopics } from '../../app/store.js';
import { S } from '../../app/state.js';
import { addMcpServer, mcp, removeMcpServer, saveMcp } from '../../app/mcpServers.js';

const STATUS = { off: 'off', connecting: 'connecting…', ready: 'connected', failed: 'failed' };
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
let rowSeq = 0;

function McpCard({ s, focus }) {
    const st = mcp.status(s.id);
    const status = s.enabled ? st.status : 'off';
    const url = useRef(null);
    const [rows, setRows] = useState(() => s.headers.map(([k, v]) => ({ id: ++rowSeq, k, v })));
    const [bad, setBad] = useState('');
    useEffect(() => { if (focus) url.current?.focus(); }, [focus]);

    const saveHeaders = (list = rows) => {
        const pairs = [];
        const wrong = [];
        for (const r of list) {
            const k = r.k.trim();
            if (!k) continue;
            if (!HEADER_NAME.test(k)) { wrong.push(k); continue; }
            pairs.push([k, r.v.trim()]);
        }
        setBad(wrong.length ? `Not header names: ${wrong.join(', ')}` : '');
        if (wrong.length) return false;
        if (JSON.stringify(pairs) === JSON.stringify(s.headers)) return true;
        s.headers = pairs;
        saveMcp();
        if (s.enabled) mcp.sync();
        return true;
    };
    const setRow = (id, patch) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const connect = () => {
        s.url = url.current.value.trim();
        saveHeaders();
        s.enabled = true;
        saveMcp();
        mcp.connect(s);
    };
    const remove = () => {
        if (confirm(`Remove the MCP server ${s.name}${s.headers.length ? ' and its headers' : ''} from this browser?`)) removeMcpServer(s);
    };
    const offered = st.tools.length - st.tools.filter((t) => s.disabledTools.includes(t.name)).length;
    return (
        <div className="provider">
            <div className="phead">
                <input type="checkbox" checked={s.enabled} title="On: its tools are offered to every chat" aria-label={`Use ${s.name}`}
                    onChange={(e) => { s.enabled = e.target.checked; saveMcp(); mcp.sync(); }} />
                <b>{s.name}</b>
                <span className="pnote" title={st.server?.name ? `${st.server.name} ${st.server.version || ''}`.trim() : undefined}>
                    <span className={`sdot ${status}`} />
                    {STATUS[status] + (status === 'ready' ? `, ${st.tools.length} tool${st.tools.length === 1 ? '' : 's'}` : '')}
                </span>
                <button type="button" className="danger" onClick={remove}>Remove</button>
            </div>
            <div className="pfields">
                <span className="pnote">Name</span>
                <input defaultValue={s.name} maxLength={40} title="Its tools are named mcp__<name>__<tool>"
                    onBlur={(e) => { const v = e.target.value.trim() || 'server'; if (v !== s.name) { s.name = v; saveMcp(); } }} />
                <span className="pnote">URL</span>
                <input ref={url} type="url" placeholder="https://example.com/mcp" defaultValue={s.url}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== s.url) { s.url = v; saveMcp(); if (s.enabled) mcp.sync(); } }} />
                <span className="pnote">Headers</span>
                <div>
                    <div className="hrows">
                        {rows.map((r) => (
                            <div key={r.id} className="hrow">
                                <input placeholder="Authorization" value={r.k} aria-label="Header name"
                                    onChange={(e) => setRow(r.id, { k: e.target.value })} onBlur={() => saveHeaders()} />
                                <input type="password" autoComplete="off" placeholder="Bearer …" value={r.v} aria-label="Header value"
                                    onChange={(e) => setRow(r.id, { v: e.target.value })} onBlur={() => saveHeaders()} />
                                <button type="button" title="Remove this header" onClick={() => {
                                    const next = rows.filter((x) => x.id !== r.id);
                                    setRows(next);
                                    saveHeaders(next);
                                }}>×</button>
                            </div>
                        ))}
                    </div>
                    <button type="button" onClick={() => setRows([...rows, { id: ++rowSeq, k: '', v: '' }])}>Add header</button>
                    <span className="pnote bad">{bad}</span>
                </div>
            </div>
            <div className="row">
                <button type="button" disabled={status === 'connecting'} onClick={connect}>{status === 'ready' ? 'Reconnect' : 'Connect'}</button>
                {status === 'failed' && <span className="pnote bad">{st.error || 'failed'}</span>}
                {status === 'ready' && st.tools.length > 0 && <span className="pnote">{`${offered} of ${st.tools.length} offered`}</span>}
            </div>
            {status === 'ready' && st.tools.length > 0 && (
                <div className="models">
                    {st.tools.map((t) => (
                        <label key={t.name}>
                            <input type="checkbox" checked={!s.disabledTools.includes(t.name)} onChange={(e) => {
                                s.disabledTools = s.disabledTools.filter((x) => x !== t.name);
                                if (!e.target.checked) s.disabledTools.push(t.name);
                                saveMcp();
                            }} />
                            {t.title && t.title !== t.name ? `${t.name} · ${t.title}` : t.name}
                            {t.description && <span className="tdesc">{t.description.split('\n')[0].slice(0, 200)}</span>}
                        </label>
                    ))}
                </div>
            )}
            {st.instructions && <details><summary>The server&apos;s instructions</summary><pre>{st.instructions}</pre></details>}
        </div>
    );
}

export default function IntegrationsSection() {
    useTopics('mcp');
    const [focus, setFocus] = useState(null);
    return (
        <div id="setIntegrations" className="dlg-pane page" role="tabpanel">
            <h2>MCP servers</h2>
            <p className="hint">Tools from <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">MCP servers</a>
                {' '}for every chat, next to the built-in ones: each server&apos;s tools are named <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.
                The page reaches a server over HTTP (Streamable HTTP), from this browser: the server must allow this page&apos;s
                origin (CORS). A server that runs over stdio needs an HTTP bridge in front of it. Headers (a token, say) are
                kept in this browser and only ever go to their own server.</p>
            <div id="mcpList">
                {!S.mcpServers.length && <p className="hint">No servers yet. Add one with its URL (its MCP endpoint, often ending in /mcp), and any
                    headers it needs, then Connect.</p>}
                {S.mcpServers.map((s) => <McpCard key={s.id} s={s} focus={focus === s.id} />)}
            </div>
            <div className="row"><button id="mcpAdd" type="button" onClick={() => setFocus(addMcpServer().id)}>Add server</button></div>
        </div>
    );
}
