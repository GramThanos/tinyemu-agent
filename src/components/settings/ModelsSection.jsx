// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ModelsSection.jsx — Settings → Models: the providers, each with its key (or URL)
 * and the models it offers. Keys are kept in this browser and only ever go to
 * their own provider (a changed key or URL loads it afresh: connections.forget).
 */

import { useEffect, useRef, useState } from 'react';
import { listModels, MODEL_LIMITS, PROVIDER_TYPES, providerShape, typeOf } from '../../../js/providerStore.js';
import { hasWebGPU } from '../../../js/providers/webllm.js';
import { S, short } from '../../app/state.js';
import { connections, localBaseURL, saveProviders, setModelSettings } from '../../app/models.js';

const listing = new Map();   // provider id -> AbortController of its listing

function save() {
    if (!saveProviders()) alert('This browser has no storage for the providers, so they last until the page reloads.');
}

/* What a reply may take when nothing is set, per wire format (js/providers). */
const DEFAULT_OUTPUT = { claude: '64000', webllm: '2048', openai: 'server default' };

/* One model's own settings, over what its provider listed: shown under its row. */
function ModelSettings({ p, m, kind, onClose }) {
    const own = p.modelSettings?.[m.id] || {};
    const [v, setV] = useState({ label: own.label ?? '', contextWindow: own.contextWindow ?? '', maxOutput: own.maxOutput ?? '',
        temperature: own.temperature ?? '' });
    const [note, setNote] = useState('');
    const bad = Object.entries(MODEL_LIMITS).filter(([k, [min, max]]) => {
        if (v[k] === '' || v[k] === null) return false;
        const n = Number(v[k]);
        return !Number.isFinite(n) || n < min || n > max;
    }).map(([k]) => k);
    const field = (k, label, props, hint) => (
        <label key={k}>
            <span>{label}</span>
            <input {...props} value={v[k]} className={bad.includes(k) ? 'bad' : undefined}
                onChange={(e) => { setV({ ...v, [k]: e.target.value }); setNote(''); }} />
            {hint && <small>{hint}</small>}
        </label>
    );
    const save = () => {
        if (bad.length) return;
        setModelSettings(p, m.id, v);
        setNote('Saved: chats on this model use it from their next message.');
    };
    const reset = () => {
        setModelSettings(p, m.id, null);
        setV({ label: '', contextWindow: '', maxOutput: '', temperature: '' });
        setNote('Back to what the provider says.');
    };
    return (
        <div className="modelset" role="group" aria-label={`Settings of ${m.id}`}>
            {field('label', 'Name', { placeholder: m.label.replace(/\s*\([^)]*\)$/, '') || m.id, maxLength: 80 })}
            {field('contextWindow', 'Context window', { type: 'number', min: 1000, step: 1000, placeholder: m.contextWindow ? String(m.contextWindow) : 'unknown' },
                kind === 'webllm' ? 'tokens; applies when the model next loads' : 'tokens; what the context meter and compaction count against')}
            {field('maxOutput', 'Max response', { type: 'number', min: 1, step: 256, placeholder: DEFAULT_OUTPUT[kind] || '' },
                'tokens a reply may take, thinking included')}
            {kind !== 'claude' && field('temperature', 'Temperature', { type: 'number', min: 0, max: 2, step: 0.1, placeholder: kind === 'webllm' ? '0.2' : 'server default' },
                '0 to 2; some reasoning models refuse it')}
            <div className="row">
                <button type="button" disabled={bad.length > 0} onClick={save}>Save</button>
                <button type="button" disabled={!p.modelSettings?.[m.id]} onClick={reset} title="Forget this model's own settings">Reset</button>
                <button type="button" className="ghost" onClick={onClose}>Close</button>
                <span className="pnote">{bad.length ? `Out of range: ${bad.join(', ')}` : note}</span>
            </div>
        </div>
    );
}

function ProviderCard({ p, focus }) {
    const [editing, setEditing] = useState(null);   // the model whose settings are open
    const t = typeOf(p);
    const [filter, setFilter] = useState('');
    const [status, setStatus] = useState(null);   // the listing's state, else the count
    const [busy, setBusy] = useState(false);
    const first = useRef(null);
    useEffect(() => { if (focus) first.current?.focus(); }, [focus]);
    const remove = () => {
        if (!confirm(`Remove ${p.label}${p.apiKey ? ' and its API key' : ''} from this browser? Chats using its models need another model.`)) return;
        S.providers = S.providers.filter((x) => x !== p);
        connections.forget(p.id);
        save();
    };
    const list = async () => {
        if (t.kind === 'webllm') return;
        listing.get(p.id)?.abort();
        const ctl = new AbortController();
        listing.set(p.id, ctl);
        setBusy(true);
        setStatus('listing models…');
        try {
            let claudeBaseURL;
            try { claudeBaseURL = localBaseURL(); } catch { /* none */ }
            const listed = await listModels(p, { signal: ctl.signal, claudeBaseURL });
            if (ctl.signal.aborted) return;
            p.models = listed;
            // Models no longer listed stop being offered.
            p.enabled = p.enabled.filter((id) => listed.some((m) => m.id === id));
            setStatus(listed.length ? `${p.enabled.length} of ${listed.length} offered: tick the ones chats should offer` : 'no chat models listed');
            connections.forget(p.id);
            save();
        } catch (e) {
            if (ctl.signal.aborted) return;
            // fetch() reports an unreachable server and a CORS refusal the same way.
            const hint = !(e instanceof TypeError) || !t.custom ? ''
                : t.cors ? ` Check that it runs and allows this page (${location.origin}): ${t.cors}.`
                    : ' Check that the server runs and allows requests from this page (CORS).';
            setStatus(`Could not list the models: ${e.message}.${hint}`);
        } finally {
            if (listing.get(p.id) === ctl) listing.delete(p.id);
            setBusy(false);
        }
    };
    const q = filter.trim().toLowerCase();
    const shown = p.models.filter((m) => !q || `${m.id} ${m.label}`.toLowerCase().includes(q));
    const field = (label, input) => [<span key={`${label}-l`} className="pnote">{label}</span>, <span key={`${label}-i`} style={{ display: 'contents' }}>{input}</span>];
    return (
        <div className="provider">
            <div className="phead">
                <b>{p.label}</b><span className="pnote">{t.label}</span>
                <button type="button" className="danger" onClick={remove}>Remove</button>
            </div>
            <div className="pfields">
                {field('Name', <input ref={first} defaultValue={p.label}
                    onBlur={(e) => { p.label = e.target.value.trim() || t.label; save(); }} />)}
                {t.custom && field('API URL', <input type="url" placeholder={t.defaultURL || 'http://localhost:8080/v1'} defaultValue={p.baseURL || ''}
                    onBlur={(e) => { p.baseURL = e.target.value.trim(); connections.forget(p.id); save(); }} />)}
                {/* A key belongs to this provider only; a change loads it afresh. */}
                {(t.key || t.custom) && field(t.custom ? 'API key (if any)' : 'API key', <input type="password" autoComplete="off"
                    placeholder="kept in this browser" defaultValue={p.apiKey || ''}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (p.apiKey || '')) { p.apiKey = v; connections.forget(p.id); save(); } }} />)}
            </div>
            <div className="row">
                <button type="button" disabled={busy} onMouseDown={(e) => e.currentTarget.focus()} onClick={list}>{t.kind === 'webllm' ? 'Models' : 'List models'}</button>
                <span className="pnote">{status || (p.models.length ? `${p.enabled.length} of ${p.models.length} offered` : 'press List models')}</span>
                {p.models.length >= 12 && <input placeholder="filter" size={14} value={filter} onChange={(e) => setFilter(e.target.value)} />}
            </div>
            {p.models.length > 0 && (
                <div className="models">
                    {shown.map((m) => {
                        const own = p.modelSettings?.[m.id];
                        const ctx = own?.contextWindow ?? m.contextWindow;
                        return [
                            <div key={m.id} className="mrow">
                                <label>
                                    <input type="checkbox" checked={p.enabled.includes(m.id)} onChange={(e) => {
                                        p.enabled = p.enabled.filter((x) => x !== m.id);
                                        if (e.target.checked) p.enabled.push(m.id);
                                        setStatus(null);
                                        save();
                                    }} />
                                    {own?.label || m.label}{' '}
                                    <small>{[own?.label || m.label !== m.id ? m.id : '', ctx ? `${short(ctx)} context` : '',
                                        own?.maxOutput ? `${short(own.maxOutput)} out` : '', Number.isFinite(own?.temperature) ? `temp ${own.temperature}` : '',
                                        own ? 'your settings' : ''].filter(Boolean).join(' · ')}</small>
                                </label>
                                <button type="button" className={`mset${own ? ' on' : ''}`} aria-expanded={editing === m.id}
                                    title={`This model's own settings: name, context window, response size${t.kind !== 'claude' ? ', temperature' : ''}`}
                                    aria-label={`Settings of ${m.id}`} onClick={() => setEditing(editing === m.id ? null : m.id)}>⚙</button>
                            </div>,
                            editing === m.id && <ModelSettings key={`${m.id}-set`} p={p} m={m} kind={t.kind} onClose={() => setEditing(null)} />,
                        ];
                    })}
                </div>
            )}
        </div>
    );
}

export default function ModelsSection() {
    const [type, setType] = useState(PROVIDER_TYPES[0].type);
    const [webgpu, setWebgpu] = useState(true);
    const [focus, setFocus] = useState(null);
    useEffect(() => { hasWebGPU().then(setWebgpu); }, []);
    const add = () => {
        const t = PROVIDER_TYPES.find((x) => x.type === type);
        if (!t) return;
        let id = t.type;
        for (let n = 2; S.providers.some((p) => p.id === id); n++) id = `${t.type}-${n}`;
        const p = providerShape({ id, type: t.type, label: t.label });
        // WebLLM's models are known without asking: offer them all.
        if (t.kind === 'webllm') p.enabled = p.models.map((m) => m.id);
        S.providers.push(p);
        setFocus(p.id);
        save();
    };
    return (
        <div className="dlg-pane page" role="tabpanel">
            <h2>Providers</h2>
            <p className="hint">Set up the providers you use, then tick the models each one should offer. Every chat picks one
                of them in its message box. Keys are kept in this browser and only ever go to their own provider.</p>
            <div id="providerList">
                {!S.providers.length && <p className="hint">No providers yet. Pick one below and press Add provider: Claude, OpenAI, Gemini, OpenRouter, Mistral,
                    Groq, DeepSeek, xAI, Moonshot, Together, Fireworks, Cerebras, DeepInfra, Hugging Face, Ollama or LM Studio on
                    this computer, any other OpenAI-compatible server (llama.cpp, vLLM), or a model run in this browser with WebGPU.</p>}
                {S.providers.map((p) => <ProviderCard key={p.id} p={p} focus={focus === p.id} />)}
            </div>
            <div className="row">
                <select id="providerType" aria-label="Kind of provider" value={type} onChange={(e) => setType(e.target.value)}>
                    {[['Cloud APIs', (t) => !t.custom && t.kind !== 'webllm'], ['On this computer', (t) => t.local],
                        ['Other', (t) => (t.custom && !t.local) || t.kind === 'webllm']].map(([group, has]) => (
                        <optgroup key={group} label={group}>
                            {PROVIDER_TYPES.filter(has).map((t) => (
                                <option key={t.type} value={t.type} disabled={t.type === 'webllm' && !webgpu}>
                                    {t.label}{t.type === 'webllm' && !webgpu ? ' — no WebGPU here' : ''}</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
                <button id="providerAdd" onClick={add}>Add provider</button>
            </div>
        </div>
    );
}
