// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * AskForm.jsx — the open chat's first waiting question (ask_user), in place of the
 * message box. Option buttons work like radio buttons (or checkboxes, with
 * multi_select); a typed answer is the question's own unless it allows several.
 * Keyed by the question, so what was picked stays while it is shown.
 */

import { useEffect, useRef, useState } from 'react';

export default function AskForm({ s }) {
    const item = s.asks[0];
    const [state, setState] = useState(() => Object.fromEntries(item.questions.map((q) => [q.id, { picked: [], text: '' }])));
    const first = useRef(null);
    useEffect(() => { first.current?.focus(); }, []);
    const ready = item.questions.every((q) => state[q.id].picked.length || state[q.id].text.trim());
    const set = (id, patch) => setState((st) => ({ ...st, [id]: { ...st[id], ...patch } }));
    const submit = () => {
        if (!ready) return;
        const answers = {};
        for (const q of item.questions) {
            const st = state[q.id];
            answers[q.id] = { picked: q.options.filter((o) => st.picked.includes(o)), text: st.text };
        }
        item.finish({ answers });
    };
    let firstSet = false;
    const firstRef = () => { if (firstSet) return undefined; firstSet = true; return first; };
    return (
        <div id="askBox" role="group" aria-label="The agent's questions">
            <div className="askhead">
                {`The agent asks${item.questions.length > 1 ? ` ${item.questions.length} questions` : ''}`
                    + `${s.asks.length > 1 ? ` (${s.asks.length - 1} more waiting after these)` : ''}:`}
            </div>
            {item.questions.map((q) => {
                const st = state[q.id];
                const toggle = (o) => {
                    if (q.multi) set(q.id, { picked: st.picked.includes(o) ? st.picked.filter((x) => x !== o) : [...st.picked, o] });
                    // One answer: picking an option replaces a typed one.
                    else set(q.id, st.picked.includes(o) ? { picked: [] } : { picked: [o], text: '' });
                };
                return (
                    <fieldset key={q.id}>
                        <legend>{q.header || q.id}</legend>
                        <div className="askq">{q.question}</div>
                        {q.options.length > 0 && (
                            <div className="askopts">
                                {q.options.map((o) => (
                                    <button key={o} type="button" ref={firstRef()} aria-pressed={st.picked.includes(o)} onClick={() => toggle(o)}>{o}</button>
                                ))}
                            </div>
                        )}
                        {q.multi && <div className="askhint">Pick any that apply.</div>}
                        {q.custom && (
                            <input className="askother" ref={firstRef()} value={st.text}
                                placeholder={q.options.length ? 'Or type your own answer…' : 'Type your answer…'}
                                aria-label={`Your own answer to: ${q.question}`}
                                onChange={(e) => {
                                    const text = e.target.value;
                                    set(q.id, !q.multi && text.trim() && st.picked.length ? { text, picked: [] } : { text });
                                }}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
                        )}
                    </fieldset>
                );
            })}
            <div className="askbar">
                <button type="button" className="go" disabled={!ready} onClick={submit}>Answer</button>
                <button type="button" title="Don't answer; the agent carries on with its best judgment" onClick={() => item.finish({ declined: true })}>Dismiss</button>
            </div>
        </div>
    );
}
