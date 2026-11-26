// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ChatInfo.jsx — the ⓘ panel: the open chat's figures. Usage (tokens, time,
 * cache, shares), then folds from its running figures (js/figures.js): the model,
 * the tools, time, sub-agents, interruptions, rate limits; then the chat itself.
 * It redraws every 2 s, for a working chat's clock.
 */

import { useEffect, useState } from 'react';
import { figuresSummary, usageSummary } from '../../js/figures.js';
import { chatById, fmt, pct, plural, S, seconds, short } from '../app/state.js';
import { toggleContextPanel } from '../app/dialogs.js';

const infoOpen = new Set();   // folds left open, kept across the panel's redraws
function Fold({ id, title, aside, children }) {
    return (
        <details open={infoOpen.has(id)} onToggle={(e) => { if (e.currentTarget.open) infoOpen.add(id); else infoOpen.delete(id); }}>
            <summary>{title}{aside && <span className="aside">{` · ${aside}`}</span>}</summary>
            {children}
        </details>
    );
}
function KV({ rows }) {
    return (
        <div className="kv">
            {rows.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [
                <span key={`${k}-k`} className="k">{k}</span>, <span key={`${k}-v`} className="v">{v}</span>,
            ])}
        </div>
    );
}
const STOP_LABELS = {
    end: 'finished', tool_use: 'called tools', max_tokens: 'hit the output limit', empty: 'came back empty',
    refusal: 'refused', aborted: 'stopped', max_steps: 'ran out of steps', error: 'failed',
};

/* The context size per request, as a small line chart; compactions as ticks. */
function ContextChart({ points, limit }) {
    const W = 300, H = 46;
    const max = Math.max(limit || 0, ...points.map((p) => p[1]), 1);
    const x = (i) => (points.length > 1 ? (i / (points.length - 1)) * (W - 2) + 1 : W / 2);
    const y = (v) => H - 2 - (v / max) * (H - 4);
    const label = `Context size at each of the last ${points.length} requests, up to ${short(Math.max(...points.map((p) => p[1])))} tokens; dashed lines are compactions.`;
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="spark" role="img" aria-label={label}>
            <polyline points={points.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')} fill="none" stroke="#4f8fe0" strokeWidth="1.5" />
            {points.map((p, i) => (p[2] ? <line key={i} x1={x(i)} x2={x(i)} y1={0} y2={H} stroke="#c99a2e" strokeDasharray="2 2" /> : null))}
            <title>{label}</title>
        </svg>
    );
}

function Figures({ c }) {
    const fg = c.figs;
    const sm = figuresSummary(fg);
    const out = [];
    // Model: why replies stopped, speed, cache, parallel calls, the context curve.
    if (sm.replies) {
        const stops = Object.entries(fg.replies).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${STOP_LABELS[k] || k}`).join(' · ');
        const info = S.sessions.get(c.id)?.agent?.contextInfo();
        out.push(
            <Fold key="model" id="model" title="Model" aside={`${sm.replies} replies`}>
                <KV rows={[
                    ['Replies', stops],
                    ['Speed', sm.tokensPerSecond === null ? null : `${sm.tokensPerSecond.toFixed(1)} tokens/s while streaming`],
                    ['First token', sm.firstMsAvg === null ? null : `after ${seconds(Math.round(sm.firstMsAvg))} on average, ${seconds(Math.round(sm.firstMsMax))} at most`],
                    ['Cache', sm.coldShare === null ? null : `${fg.cache.cold} of ${fg.cache.requests} requests read nothing from it (${pct(sm.coldShare)})`],
                    ['Tool calls a step', sm.parallelAvg === null ? null : `${sm.parallelAvg.toFixed(1)} on average, ${fg.steps.maxParallel} at most`],
                ]} />
                {fg.context.length > 1 && <><div className="chart-head">Context size per request</div><ContextChart points={fg.context} limit={info?.limit} /></>}
            </Fold>,
        );
    }
    // Tools: one row per tool, then the Bash commands run most.
    if (sm.tools.length) {
        const stopped = sm.tools.reduce((n, t) => n + t.stopped, 0);
        const calls = sm.tools.reduce((n, t) => n + t.calls, 0);
        out.push(
            <Fold key="tools" id="tools" title="Tools" aside={`${calls} calls`}>
                <div className="ttable">
                    {['Tool', 'Calls', 'Failed', 'Median', 'Slowest', 'Output', 'Cut'].map((h) => <span key={h} className="th">{h}</span>)}
                    {sm.tools.map((t) => [
                        <span key={`${t.name}-a`}>{t.name}</span>,
                        <span key={`${t.name}-b`} className="n">{String(t.calls)}</span>,
                        <span key={`${t.name}-c`} className="n">{t.failed ? `${t.failed} (${pct(t.failRate)})` : '0'}</span>,
                        <span key={`${t.name}-d`} className="n">{t.medianMs === null ? '—' : seconds(Math.round(t.medianMs))}</span>,
                        <span key={`${t.name}-e`} className="n">{seconds(t.maxMs)}</span>,
                        <span key={`${t.name}-f`} className="n">{`${short(t.avgChars)} ch`}</span>,
                        <span key={`${t.name}-g`} className="n">{String(t.capped)}</span>,
                    ])}
                </div>
                <p className="note">{stopped
                    ? `You stopped ${stopped} call${stopped === 1 ? '' : 's'}. "Cut" counts results cut to the output limit; "Output" is the average size before cutting.`
                    : '"Cut" counts results cut to the output limit; "Output" is the average size, in characters, before cutting.'}</p>
                {sm.bash.length > 0 && <>
                    <div className="chart-head">Bash commands run most</div>
                    <p className="mono">{sm.bash.slice(0, 12).map(([w, n]) => `${w} ${n}`).join(' · ')}</p>
                </>}
            </Fold>,
        );
    }
    // Time: the model, the guest, the page, MCP servers, and you. Parallel calls overlap.
    const parts = [
        ['model', 'Waiting on the model', c.stats.apiMs || 0, '#4f8fe0'],
        ['vm', 'Tools in the VM', fg.via.vm || 0, '#2fb39a'],
        ['page', 'Tools in the page', fg.via.page || 0, '#a07ae0'],
        ['mcp', 'Tools on MCP servers', fg.via.mcp || 0, '#d07a9a'],
        ['user', 'Waiting for your answers', fg.via.user || 0, '#c99a2e'],
    ].filter((p) => p[2]);
    const total = parts.reduce((n, p) => n + p[2], 0);
    if (total > 0) {
        out.push(
            <Fold key="time" id="time" title="Time" aside={seconds(Math.round(total))}>
                <div className="seg">
                    {parts.map(([k, label, ms, color]) => <span key={k} title={`${label}: ${seconds(Math.round(ms))}`} style={{ width: `${(ms / total) * 100}%`, background: color }} />)}
                </div>
                <div className="frows">
                    {parts.map(([k, label, ms, color]) => [
                        <span key={`${k}-s`} className="sw" style={{ background: color }} />, <span key={`${k}-l`}>{label}</span>,
                        <span key={`${k}-n`} className="n">{seconds(Math.round(ms))}</span>, <span key={`${k}-p`} className="p">{pct(ms / total)}</span>,
                    ])}
                </div>
                <p className="note">Calls that ran side by side each count their own time, so this can add up to more than the time worked. Sub-agents count in all of them.</p>
            </Fold>,
        );
    }
    // Sub-agents' outcomes.
    const sb = fg.subs;
    const ended = sb.done + sb.failed + sb.stopped + sb.interrupted;
    if (c.kind !== 'sub' && ended) {
        out.push(
            <Fold key="subs" id="subs" title="Sub-agents" aside={`${ended} ended`}>
                <KV rows={[['Finished', String(sb.done)], ['Failed', String(sb.failed)], ['Stopped', String(sb.stopped)],
                    ['Interrupted by a reload', String(sb.interrupted)], ['Asked again for a report', sb.wrapUps ? String(sb.wrapUps) : null]]} />
            </Fold>,
        );
    }
    // Interruptions: lost connections, browser pauses, resumes after a reload.
    const br = fg.breaks;
    if (br.outages || br.pauses || br.resumes) {
        out.push(
            <Fold key="breaks" id="breaks" title="Interruptions">
                <KV rows={[
                    ['No connection', br.outages ? `${br.outages}×, waited ${seconds(Math.round(br.outageMs))}` : null],
                    ['Browser paused the page', br.pauses ? `${br.pauses}×, ${seconds(Math.round(br.pauseMs))}` : null],
                    ['Resumed after a reload', br.resumes ? `${br.resumes}×` : null],
                ]} />
            </Fold>,
        );
    }
    // Rate limits, as the provider last reported them (any chat: they are the account's).
    const lim = S.lastLimits || fg.limits;
    out.push(
        <Fold key="limits" id="limits" title="Rate limits">
            {lim?.list?.length ? <>
                <div className="shares">
                    {lim.list.map((l) => {
                        const used = l.limit ? 1 - l.remaining / l.limit : 0;
                        const reset = l.resetAt ? `resets ${l.resetAt <= Date.now() ? 'now' : `in ${seconds(Math.max(0, Math.round(l.resetAt - Date.now())))}`}` : '';
                        return [
                            <span key={`${l.name}-n`}>{l.name}</span>,
                            <span key={`${l.name}-b`} className="bar" title={`${l.remaining.toLocaleString()} of ${l.limit.toLocaleString()} left${reset ? `, ${reset}` : ''}`}>
                                <span style={{ width: `${Math.max(0, Math.min(100, used * 100)).toFixed(1)}%`, background: used > 0.9 ? '#d05555' : used > 0.7 ? '#c99a2e' : undefined }} />
                            </span>,
                            <span key={`${l.name}-p`} className="p">{pct(used)}</span>,
                        ];
                    })}
                </div>
                <p className="note">{`Used of each limit, as the provider reported at ${new Date(lim.at).toLocaleTimeString()}. Hover a bar for what is left and when it resets.`}</p>
            </> : <p className="note">No rate limits yet: the provider sends them with each response, if it lets the browser read them.</p>}
        </Fold>,
    );
    return out;
}

export default function ChatInfo() {
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 2000);   // a working chat's clock
        return () => clearInterval(t);
    }, []);
    const c = S.chat;
    const s = S.sessions.get(c.id);
    const sub = c.kind === 'sub';
    const u = usageSummary(c.usage);
    const t = u.total;
    const names = { main: sub ? 'This sub-agent' : 'Main agent', sub: 'Sub-agents', compaction: 'Compaction summaries' };

    const rows = [];
    if (sub) {
        rows.push(['Kind', `sub-agent (${c.subName || 'sub-agent'}) of “${chatById(c.parent)?.title || 'a deleted chat'}”`]);
        rows.push(['State', s?.running ? 'working' : c.status || 'interrupted']);
    } else {
        rows.push(['State', s?.running ? `working, for ${seconds(Date.now() - (c.turn?.started || Date.now()))}` : 'idle']);
    }
    rows.push(['Started', new Date(c.created).toLocaleString()]);
    rows.push(['Last activity', new Date(c.updated).toLocaleString()]);
    const sent = c.events.filter((e) => e.k === 'user' && !e.answer).length;
    const answers = c.events.filter((e) => e.k === 'user' && e.answer).length;
    const replies = c.events.filter((e) => e.k === 'assistant').length;
    rows.push(['Messages', `${plural(sent, sub ? 'task' : 'sent')}, ${plural(replies, 'reply', 'replies')}`
        + (answers ? `, ${plural(answers, 'answered question')}` : '')]);
    const tools = Object.entries(c.toolStats);
    const calls = tools.reduce((n, [, x]) => n + x.calls, 0);
    const failed = tools.reduce((n, [, x]) => n + x.failed, 0);
    rows.push(['Tool calls', calls ? `${calls.toLocaleString()}${failed ? ` (${failed} failed)` : ''}: `
        + tools.sort((a, b) => b[1].calls - a[1].calls).map(([n, x]) => `${n} ${x.calls}`).join(', ') : 'none']);
    if (!sub) {
        const subs = S.chats.filter((x) => x.parent === c.id);
        const busy = subs.filter((x) => S.sessions.get(x.id)?.running).length;
        rows.push(['Sub-agents', subs.length ? `${subs.length}${busy ? `, ${busy} working` : ''}` : 'none']);
    }
    rows.push(['Compactions', `${c.compactions.main}${c.compactions.sub ? `, ${c.compactions.sub} by sub-agents` : ''}`]);
    rows.push(['Log', plural(c.exchanges.length, 'exchange')]);
    const info = s?.agent?.contextInfo();

    return (
        <div id="chatInfo" className="panel floating" role="dialog" aria-label="This chat's usage and figures">
            <h3>{c.title}</h3>
            <h4>Usage<span className="aside">{c.model || ''}</span></h4>
            <div className="big">
                <b>{t.requests ? `${short(u.tokens)} tokens` : 'No requests yet'}</b>
                <span className="muted">{t.requests ? plural(t.requests, 'request') : ''}</span>
            </div>
            <div className="kv pairs">
                <span className="k">API time</span><span className="v">{seconds(Math.round(c.stats.apiMs || 0))}</span>
                <span className="k">Working</span><span className="v">{seconds(Math.round(c.stats.workMs || 0))}</span>
                <span className="k">Cache hit</span><span className="v">{u.cacheHit === null ? '—' : `${Math.round(u.cacheHit * 100)}%`}</span>
                <span className="k">Turns</span><span className="v">{c.stats.turns.toLocaleString()}</span>
            </div>
            <h4>Breakdown<span className="aside">tokens</span></h4>
            <KV rows={[['Input', fmt(t.input)], ['Output', fmt(t.output)], ['Cache read', fmt(t.cacheRead)], ['Cache write', fmt(t.cacheWrite)],
                ['Thinking (in output)', t.thinkingKnown ? fmt(t.thinking) : '—']]} />
            {t.requests > 0 && <>
                <h4>Where the tokens went</h4>
                <div className="shares">
                    {u.shares.filter((p) => !(sub && p.key === 'sub')).map((p) => [
                        <span key={`${p.key}-n`}>{names[p.key]}</span>,
                        <span key={`${p.key}-b`} className="bar" title={`${fmt(p.tokens)} tokens`}><span style={{ width: `${(p.share * 100).toFixed(1)}%` }} /></span>,
                        <span key={`${p.key}-p`} className="p">{`${Math.round(p.share * 100)}%`}</span>,
                    ])}
                </div>
            </>}
            {info && (
                <button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); toggleContextPanel(true); }}>
                    {`Context: ${info.estimated ? '~' : ''}${short(info.used)} of ${short(info.limit)} tokens (${Math.round((info.used / info.limit) * 100)}%) →`}
                </button>
            )}
            <Figures c={c} />
            <hr />
            <h4>Chat</h4>
            <dl>{rows.map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}</dl>
        </div>
    );
}
