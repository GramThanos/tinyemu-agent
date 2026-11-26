// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Todos.jsx — the open chat's agent's to-do list (TodoWrite), above the message
 * box: the step in progress, and the whole list when opened. A sub-agent's chat
 * shows its own; a main chat also says how its sub-agents' lists stand. The steps
 * are model text: shown as text only.
 */

import { useState } from 'react';
import { descendsFrom, S } from '../app/state.js';
import { switchChat } from '../app/chatOps.js';

const MARK = { pending: '○', in_progress: '◐', completed: '●' };

export default function Todos({ c }) {
    const [open, setOpen] = useState(false);
    const list = c.todos || [];
    const subs = c.kind === 'sub' ? [] : S.chats.filter((x) => descendsFrom(x, c) && x.todos?.length && S.sessions.get(x.id)?.running);
    if (!list.length && !subs.length) return null;
    const done = list.filter((x) => x.status === 'completed').length;
    const now = list.find((x) => x.status === 'in_progress');
    return (
        <div className="todos">
            {list.length > 0 && (
                <button type="button" className="todohead" aria-expanded={open} onClick={() => setOpen(!open)}
                    title={open ? 'Hide the steps' : 'Show every step'}>
                    <span className="twist">{open ? '▾' : '▸'}</span>
                    <span className="todocount">{`${done}/${list.length}`}</span>
                    <span className="todonow">{now ? now.content : done === list.length ? 'All done' : 'To do'}</span>
                </button>
            )}
            {open && (
                <ol className="todolist">
                    {list.map((x, i) => (
                        <li key={i} className={x.status}><span className="tmark" aria-label={x.status}>{MARK[x.status]}</span>{x.content}</li>
                    ))}
                </ol>
            )}
            {subs.map((x) => {
                const d = x.todos.filter((t) => t.status === 'completed').length;
                const n = x.todos.find((t) => t.status === 'in_progress');
                return (
                    <button key={x.id} type="button" className="todosub" onClick={() => switchChat(x.id)} title="Open this sub-agent's chat">
                        {`↳ ${x.title}: ${d}/${x.todos.length}${n ? ` · ${n.content}` : ''}`}
                    </button>
                );
            })}
        </div>
    );
}
