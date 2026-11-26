// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Composer.jsx — the message box and what the message goes to: the chat's
 * environment and model (menus), the thinking level, and Send (Stop during a
 * turn, Append when something is typed then). While the agent asks something, its
 * questions take the box's place (AskForm). Typing `@` at the start of a word
 * lists the skills that are on (the mentions list).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EFFORTS, offeredModels, typeOf } from '../../js/providerStore.js';
import { emit, subscribe, useTopics } from '../app/store.js';
import { params, S } from '../app/state.js';
import { effortFor, setSettings, settings } from '../app/settings.js';
import { machineChoices, plainLabel, STATUS_WORDS } from '../app/machines.js';
import { connections, pickLabel, pickName, pickOf, sameModel, TEST_PROVIDER } from '../app/models.js';
import { envKeyOf, envOf, pool, projectOf, rt, skills } from '../app/world.js';
import { ses } from '../app/sessions.js';
import { sendPrompt, setChatEnv, setChatMode, setChatModel } from '../app/agents.js';
import { modeOf, pickableModes } from '../app/modes.js';
import { openMenu, openSettings } from '../app/dialogs.js';
import { showPanel } from '../app/layout.js';
import AskForm from './AskForm.jsx';
import Todos from './Todos.jsx';

const PROMPT_HINT = 'Ask the agent to do something. Enter sends, Shift+Enter adds a line, @ picks a skill.';
const MENTION_MAX = 8;

/* The `@word` being typed at the caret: { start, query }, or null. */
function mentionAt(p) {
    if (p.selectionStart !== p.selectionEnd) return null;
    const before = p.value.slice(0, p.selectionStart);
    const m = /(^|[\s([{"'])@([\w.-]*)$/.exec(before);
    return m ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

function envMenu(anchor, c) {
    const p = projectOf(c);
    const current = envKeyOf(c);
    const x = pool.project(p, rt(p).volumes);
    const stateOf = (key) => {
        const e = x.envs.get(key);
        if (!e) return '';
        const n = [...e.users].filter((id) => S.chats.some((y) => y.id === id) && id !== c.id).length;
        return [e.kind === 'vm' ? STATUS_WORDS[e.status] : '', n ? `shared with ${n} chat${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    };
    const items = [{ group: 'In the page' }, {
        label: 'bash.js', hint: ['bash and its own utilities on the workspace, no VM: starts at once', stateOf('bashjs')].filter(Boolean).join(' · '),
        checked: current === 'bashjs', onclick: () => setChatEnv(c, 'bashjs'),
    }, { group: 'TinyEMU machines' }];
    const choices = machineChoices();
    if (params.get('cfg')) choices.unshift({ name: 'custom', label: `the config in the link (${params.get('cfg')})`, arch: 'as it says' });
    for (const d of choices) {
        const key = `vm:${d.name}`;
        items.push({ label: plainLabel(d), hint: [d.arch, stateOf(key)].filter(Boolean).join(' · '), checked: current === key, onclick: () => setChatEnv(c, key) });
    }
    if (S.distroProblem) items.push({ label: 'Only the default machine is offered', hint: `Could not read the list: ${S.distroProblem}`, disabled: true });
    items.push({ sep: true }, { label: 'This project\'s environments…', onclick: () => showPanel('machine') });
    openMenu(anchor, items);
}

function modelMenu(anchor, c) {
    const current = pickOf(c);
    const offered = offeredModels(S.providers);
    const items = [];
    let group = null;
    for (const m of offered) {
        if (m.providerLabel !== group) { group = m.providerLabel; items.push({ group }); }
        items.push({
            label: m.label, hint: m.label !== m.model ? m.model : '', checked: sameModel(m, current),
            onclick: () => setChatModel(c, { provider: m.provider, model: m.model }),
        });
    }
    if (!offered.length) items.push({ label: 'No models yet', hint: 'Add a provider and tick its models in Settings → Models', disabled: true });
    items.push({ sep: true }, { label: 'Set up providers and models…', onclick: () => openSettings('models') });
    openMenu(anchor, items);
}

/* The chat's mode: its prompt and its tools (Settings → Modes). Hidden modes aren't offered. */
function ModeChip({ c, disabled }) {
    const mode = modeOf(c);
    const open = (anchor) => openMenu(anchor, [
        { group: 'Mode' },
        ...pickableModes(c).map((m) => ({ label: m.name, hint: m.description, checked: m === mode, onclick: () => setChatMode(c, m.id) })),
        { sep: true }, { label: 'Edit modes…', onclick: () => openSettings('modes') },
    ]);
    return (
        <button id="modePick" type="button" className="chip" aria-haspopup="menu" disabled={disabled}
            title={`${mode?.name || 'Mode'}: ${mode?.description || ''}\nHow the agent works in this chat: its instructions and its tools; click to change it`}
            onClick={(e) => open(e.currentTarget)}>
            <span className="lbl">{mode?.name || 'mode'}</span>
        </button>
    );
}

function EnvChip({ c, disabled }) {
    const env = envOf(c);
    const shared = [...env.users].filter((id) => id !== c.id && S.chats.some((y) => y.id === id)).length;
    const title = `Where this chat's tools run: ${env.label}`
        + (env.kind === 'vm' ? `, ${STATUS_WORDS[env.status]}${env.stage ? ` (${env.stage})` : ''}` : ', in the page')
        + (shared ? `\nShared with ${shared} other chat${shared === 1 ? '' : 's'} of ${env.project.name}` : '')
        + '\nClick to change it';
    return (
        <button id="envPick" type="button" className="chip" title={title} aria-haspopup="menu" disabled={disabled}
            onClick={(e) => envMenu(e.currentTarget, c)}>
            <span className={`dot ${env.status}`} />
            <span className="lbl">{env.kind === 'bashjs' ? 'bash.js' : `${env.label}${env.status === 'ready' ? '' : ` · ${STATUS_WORDS[env.status]}`}`}</span>
        </button>
    );
}

function ModelChip({ c, disabled }) {
    const pick = pickOf(c);
    const s = ses();
    const text = s.building ? (S.loadingText || `loading ${pickName(pick)}…`) : pick ? pickName(pick) : 'choose a model';
    return (
        <button id="modelPick" type="button" className="chip" aria-haspopup="menu" disabled={disabled}
            title={pick ? `${pickLabel(pick)}\nThe model this chat talks to; click to change it` : 'No model yet: set up a provider in Settings → Models'}
            onClick={(e) => modelMenu(e.currentTarget, c)}>
            <span className="lbl">{text}</span>
        </button>
    );
}

/* Each wire format has its own scale; the choice is remembered per kind. */
function Effort({ c, disabled }) {
    const pick = pickOf(c);
    const s = ses();
    const kind = pick ? (pick.provider === TEST_PROVIDER ? s.agent?.provider.kind : typeOf(connections.config(pick.provider))?.kind) : null;
    const levels = EFFORTS[kind];
    if (!levels) return null;
    const onChange = (e) => {
        const level = e.target.value;
        setSettings({ effort: { ...settings.effort, [kind]: level } });
        // Running conversations take it from their next request; sub-agents fork it.
        for (const x of S.sessions.values()) if (x.agent?.provider.kind === kind) x.agent.provider.setEffort?.(level);
        connections.setEffort(kind, level);
    };
    return (
        <label id="effortField" title="How much the model thinks. Applies from your next message; with Claude a change mid-conversation re-reads the history uncached once.">
            <select id="effort" aria-label="Thinking" value={effortFor(kind)} onChange={onChange} disabled={disabled}>
                {levels.map((l) => <option key={l} value={l}>{l ? `thinking: ${l}` : 'thinking: default'}</option>)}
            </select>
        </label>
    );
}

function Mentions({ m, pick }) {
    const list = useRef(null);
    useLayoutEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); });
    return (
        <div className="menu mentions" id="mentionList" role="listbox" aria-label="Skills" ref={list}>
            <div className="mgroup">Skills · Enter or Tab to include</div>
            {m.items.map((sk, i) => (
                <button key={sk.id} type="button" id={`mention-${i}`} role="option" aria-selected={i === m.sel} tabIndex={-1}
                    // mousedown, so the box keeps the focus (and the caret) for the insertion.
                    onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                    <span className="mt">
                        {`@${sk.id}`}
                        {sk.name && sk.name !== sk.id && <span className="mname">{` · ${sk.name}`}</span>}
                        {sk.description && <small>{sk.description}</small>}
                    </span>
                </button>
            ))}
        </div>
    );
}

export default function Composer() {
    useTopics('composer', 'skills');
    const c = S.chat;
    const s = ses();
    const box = useRef(null);
    const [mention, setMention] = useState(null);   // { items, at, sel }
    const sub = c.kind === 'sub';
    const asking = s.asks.length > 0;
    const usable = !sub && (!!s.agent || !!pickOf(c));

    // The box grows with what is typed, up to its max height.
    useLayoutEffect(() => {
        const p = box.current;
        if (!p) return;
        p.style.height = 'auto';
        p.style.height = s.draft ? `${Math.min(p.scrollHeight, innerHeight * 0.4)}px` : '';
    }, [s.draft, c]);
    // A new chat puts the caret in the box.
    useEffect(() => subscribe('focus-prompt', () => setTimeout(() => box.current?.focus())), []);

    const findMentions = () => {
        const p = box.current;
        const found = p && settings.mentions && !p.disabled ? mentionAt(p) : null;
        const all = found ? skills.enabled() : [];
        // Ids starting with what was typed first, then ids or names containing it.
        const q = found?.query ?? '';
        const starts = all.filter((x) => x.id.toLowerCase().startsWith(q));
        const contains = all.filter((x) => !starts.includes(x) && `${x.id} ${x.name}`.toLowerCase().includes(q));
        const items = [...starts, ...contains].slice(0, MENTION_MAX);
        if (!found || !items.length) { setMention(null); return; }
        setMention((m) => {
            const same = m && items.length === m.items.length && items.every((x, i) => x.id === m.items[i].id);
            return { items, at: found.start, sel: same ? m.sel : 0 };
        });
    };
    /* Replace the `@word` at the caret with the skill's id and a space. */
    const pickMention = (i) => {
        const sk = mention?.items[i];
        const p = box.current;
        if (!sk || !p) return;
        p.setRangeText(`@${sk.id} `, mention.at, p.selectionStart, 'end');
        setMention(null);
        p.focus();
        setDraft(p.value);
    };
    // The box is the open session's draft, so a chat keeps what was typed in it.
    const setDraft = (v) => { s.draft = v; emit('composer'); };

    const send = () => { setMention(null); sendPrompt(); };
    const onKeyDown = (e) => {
        // The @ list takes the arrows, Enter, Tab and Escape while it shows.
        if (mention && !e.nativeEvent.isComposing) {
            const n = mention.items.length;
            let mine = true;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setMention({ ...mention, sel: (mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
            else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') pickMention(mention.sel);
            else if (e.key === 'Escape') setMention(null);
            else mine = false;
            if (mine) { e.preventDefault(); e.stopPropagation(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!s.running || s.draft.trim()) send(); }
        // Escape stops a turn even with a message typed (which would make the button Append).
        if (e.key === 'Escape' && s.running) { e.preventDefault(); s.running.abort(); }
    };

    // During a turn, a typed message goes to the agent at its next step.
    const appending = !!s.running?.turn && !asking && !!s.draft.trim();
    const sendTitle = appending ? 'Give the agent this message at its next step, without stopping it'
        : s.running ? (sub ? 'Stop this sub-agent; the main agent gets "stopped" as its result' : 'Stop (Esc)') : 'Send (Enter)';
    const placeholder = sub
        ? `A sub-agent's conversation, read-only: the main agent gave it its task${s.running ? '. Stop ends it, and the main agent is told' : ''}.`
        : usable ? PROMPT_HINT : 'Set up a model first: Settings → Models.';
    return (
        <form id="chat" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <div className="composer">
                <Todos c={c} />
                {asking && <AskForm key={s.asks[0].key} s={s} />}
                <textarea id="prompt" ref={box} rows={2} placeholder={placeholder} hidden={asking} disabled={!usable}
                    aria-autocomplete="list" aria-expanded={!!mention} aria-controls={mention ? 'mentionList' : undefined}
                    aria-activedescendant={mention ? `mention-${mention.sel}` : undefined}
                    value={s.draft} onChange={(e) => { setDraft(e.target.value); findMentions(); }}
                    onKeyDown={onKeyDown}
                    // Moving the caret (clicks, Home/End, the arrows when the list is closed) can leave or enter a mention.
                    onKeyUp={(e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) findMentions(); }}
                    onClick={findMentions}
                    onBlur={() => setTimeout(() => { if (document.activeElement !== box.current) setMention(null); }, 100)} />
                {mention && <Mentions m={mention} pick={pickMention} />}
                <div className="cbarline">
                    {/* A chat's model and environment change between turns, not during one. */}
                    <ModeChip c={c} disabled={sub || !!s.running} />
                    <EnvChip c={c} disabled={sub || !!s.running} />
                    <ModelChip c={c} disabled={sub || !!s.running} />
                    <Effort c={c} disabled={sub} />
                    <span className="spacer" />
                    <button id="send" disabled={sub ? !s.running : !usable} title={sendTitle} aria-label={sendTitle}
                        className={s.running ? (appending ? 'append' : 'stop') : ''}>{s.running ? (appending ? 'Append' : '■') : '↑'}</button>
                </div>
            </div>
        </form>
    );
}
