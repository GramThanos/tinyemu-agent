// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ChatLog.jsx — one chat's log: its items (src/app/sessions.js), the waiting line,
 * and the messages queued during a turn, which stay last. Guest and model text
 * only ever go in as text (React's children), never as HTML; the model's replies
 * as Markdown, rebuilt from an allowlist (Markdown.jsx).
 *
 * It follows the end while the reader is there: a new item scrolls to it, and
 * more text in the last one keeps it in view, unless the reader scrolled up.
 *
 * Only the last WINDOW items are drawn: a long chat would otherwise keep
 * thousands of cards in the page. Scrolling near the top draws WINDOW more above,
 * keeping the view where it was; back at the end, the window shrinks again.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toolArgText } from '../../js/Agent.js';
import { BASH_TOOL, DELEGATE_TOOL, resolveToolName } from '../../js/tools.js';
import { useTopics } from '../app/store.js';
import { fmt, seconds } from '../app/state.js';
import { envLabelOf } from '../app/machines.js';
import { envKeyOf, projectOf } from '../app/world.js';
import { cardsOpen, logTopic, subChatOf, touch } from '../app/sessions.js';
import { switchChat } from '../app/chatOps.js';
import { Markdown } from './Markdown.jsx';

const Stat = ({ stat }) => (stat ? <span className="mstat" title={stat.title}>{stat.text}</span> : null);

const Message = memo(function Message({ it }) {
    const [actions, setActions] = useState(true);
    return (
        <div className={`msg ${it.cls}`}>
            {it.cls === 'assistant' ? <Markdown text={it.text} /> : it.text}
            {it.actions && actions && (
                <div className="actions">
                    {it.actions.map(([label, fn]) => (
                        <button key={label} onClick={() => { setActions(false); it.actions = null; fn(); }}>{label}</button>
                    ))}
                </div>
            )}
            <Stat stat={it.stat} />
        </div>
    );
});

const Thinking = memo(function Thinking({ it }) {
    return (
        <details className="thinking">
            <summary>Thinking<Stat stat={it.stat} /></summary>
            <pre>{it.text}</pre>
        </details>
    );
});

/* How long a running call has run, each second. */
function Clock({ since }) {
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, []);
    return seconds(Math.round((Date.now() - since) / 1000) * 1000);
}

const ToolCard = memo(function ToolCard({ it, s, sub }) {
    const [open] = useState(cardsOpen.get);
    const card = useRef(null);
    const out = useRef(null);
    useLayoutEffect(() => { if (it.running && out.current) out.current.scrollTop = out.current.scrollHeight; });
    const call = it.call;
    const button = (cls, label, title, fn, disabled = false) => (
        <button type="button" className={`tbtn ${cls}`} title={title} disabled={disabled}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); fn(); }}>{label}</button>
    );
    const stop = () => {
        if (s.agent?.cancelTool(call.id)) { it.stopping = true; touch(it, s); }
    };
    return (
        <details ref={card} open={open} className={it.isError && !it.running ? 'failed' : undefined} title={it.title || undefined}>
            {/* A click on the summary (or Enter/Space on it) toggles the card after the
                handlers run: that becomes the way new cards start. */}
            <summary onClick={() => setTimeout(() => cardsOpen.set(card.current?.open))}>
                {it.running && <span className="spinner" title="running" />}
                <span className="tstat" title={it.statTitle}>{it.running ? <Clock since={it.started} /> : it.statText}</span>
                {it.running && button('stop', it.stopping ? 'stopping…' : '■ stop', 'Stop this call only; the agent carries on and is told', stop, it.stopping)}
                {sub && button('open', 'open ↗', 'Open this sub-agent\'s conversation (read-only)', () => switchChat(sub))}
                <span className="name">{call.name}</span>
                {resolveToolName(call.name) === BASH_TOOL && call.input?.shell && <span className="tshell">{` [${call.input.shell}]`}</span>}
                {` ${toolArgText(call)}`}
            </summary>
            <pre className="input">{JSON.stringify(call.input, null, 2)}</pre>
            <pre ref={out}>{it.output}</pre>
        </details>
    );
});

const Compaction = memo(function Compaction({ it }) {
    const { c, who } = it;
    const how = { auto: 'automatically', overflow: 'after the model reported a full context', manual: 'by hand' }[c.reason] || '';
    return (
        <details className="compaction">
            <summary>{`⟲ Compacted ${who} ${how}: ${fmt(c.before)} → ~${fmt(c.after)} tokens (compaction ${c.count})`}</summary>
            <pre>{c.summary}</pre>
        </details>
    );
});

/* An empty chat says what it is about. Not recorded: it goes with the first message. */
function Welcome({ s }) {
    const p = projectOf(s.chat);
    return (
        <div className="welcome">
            <h2>What should the agent do?</h2>
            <p>{`In ${p.name}: its files are at /workspace. The agent works in ${envLabelOf(envKeyOf(s.chat))}, `
                + 'which you can change below, as you can the model.'}</p>
            <p>Type @ and a skill&apos;s id to include it. Several chats can work at once.</p>
        </div>
    );
}

/* "Waiting for the model… 12 s", or a countdown to `until`. */
function Waiting({ w }) {
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, []);
    let label;
    if (w.until) label = w.text.replace('{s}', String(Math.max(0, Math.ceil((w.until - Date.now()) / 1000))));
    else {
        const secs = Math.floor((Date.now() - w.started) / 1000);
        label = secs ? `${w.text} ${secs} s` : w.text;
    }
    return <div className="msg note waiting"><span className="spinner" aria-hidden="true" /><span>{label}</span></div>;
}

function Queued({ q }) {
    return (
        <div className="msg user queued">
            {q.text}
            <div className="qnote">
                <span>Waiting: goes to the agent when its current step or tool calls finish.</span>
                <button title="Take this message back and put it in the box again" onClick={() => q.cancel()}>Cancel</button>
            </div>
        </div>
    );
}

const WINDOW = 150;

function ChatLog({ s, open }) {
    useTopics(logTopic(s.chat));
    const el = useRef(null);
    const atEnd = useRef(true);
    // The first item drawn: null follows the end (the last WINDOW); a number holds
    // still while the reader is up the log, so new items don't shift the view.
    const [start, setStart] = useState(null);
    // The height before drawing more above, so the view stays on what was there.
    const grewFrom = useRef(null);
    const first = Math.min(start ?? Infinity, Math.max(0, s.items.length - WINDOW));
    useLayoutEffect(() => {
        const L = el.current;
        if (!L || !open) return;
        if (grewFrom.current !== null) {
            L.scrollTop += L.scrollHeight - grewFrom.current;
            grewFrom.current = null;
        } else if (s.scrollToEnd || atEnd.current) {
            L.scrollTop = L.scrollHeight;
        }
        s.scrollToEnd = false;
    });
    const more = () => {
        if (!first) return;
        grewFrom.current = el.current?.scrollHeight ?? null;
        setStart(Math.max(0, first - WINDOW));
    };
    const onScroll = () => {
        const L = el.current;
        atEnd.current = L.scrollTop + L.clientHeight >= L.scrollHeight - 80;
        if (L.scrollTop < 200 && first && grewFrom.current === null) more();
        else if (atEnd.current && start !== null) setStart(null);
        else if (!atEnd.current && start === null) setStart(first);
    };
    return (
        <div className="log" aria-live="polite" hidden={!open} ref={el} onScroll={onScroll}>
            {first > 0 && (
                <button type="button" className="earlier" onClick={more}>
                    {`Show earlier (${first.toLocaleString()} more)`}
                </button>
            )}
            {s.items.slice(first).map((it) => {
                if (it.kind === 'msg') return <Message key={it.id} it={it} v={it.v} />;
                if (it.kind === 'thinking') return <Thinking key={it.id} it={it} v={it.v} />;
                if (it.kind === 'compaction') return <Compaction key={it.id} it={it} v={it.v} />;
                if (it.kind === 'welcome') return <Welcome key={it.id} s={s} />;
                const sub = resolveToolName(it.call.name) === DELEGATE_TOOL ? subChatOf(s.chat.id, it.call.id)?.id : null;
                return <ToolCard key={it.id} it={it} v={it.v} s={s} sub={sub} />;
            })}
            {s.waiting && <Waiting w={s.waiting} />}
            {[...s.queued.values()].map((q) => <Queued key={q.id} q={q} />)}
        </div>
    );
}

export default memo(ChatLog);
