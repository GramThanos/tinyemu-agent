// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * modes.js — the agent's modes: each a system prompt and a choice of tools.
 *
 * A chat works in one mode (c.mode), picked next to its message box; sub-agents
 * work in the sub-agent one. Three are built in and can be edited (and reset):
 *   build      does the work: reads, changes and runs things (the default);
 *   plan       looks and plans, changes nothing: edit, write and delegate are off;
 *   sub-agent  what delegate's sub-agents get; hidden from the picker, and
 *              delegate and ask_user off (ask_user the page never gives them).
 * The user can add more. A mode is
 *   { id, name, description, prompt, hidden, sub, tools: { [tool]: 'on'|'off' }, builtin }
 * where `prompt` is a template ({{VAR_...}}, see Agent.js renderPrompt), `hidden`
 * keeps it out of the picker, `sub` marks the one sub-agents use, and `tools`
 * overrides the Tools settings for that mode (a tool not named follows them).
 *
 * Kept in localStorage as the list of modes, built-in ones included as edited; a
 * built-in one missing from the list is its default. Before modes, Settings had one
 * edited system prompt: the first load makes it the build mode's.
 */

'use strict';

import { DELEGATE_TOOL, ASK_TOOL, EDIT_TOOL, WRITE_TOOL, resolveToolName } from './tools.js';

export const MODES_KEY = 'tinyemu-agent-modes';
export const DEFAULT_MODE = 'build';
export const SUB_MODE = 'sub-agent';

/* What every built-in prompt starts with: who the agent is, on which model, where. */
const BASE = 'You are TinyEMU, an AI agent running on {{VAR_MODEL_NAME}} (model id {{VAR_MODEL_ID}}). '
    + 'You have access to a sandbox ({{VAR_ARCH}}, {{VAR_OS_NAME}}), a bit slow and without internet access (no need to install anything). '
    + 'You work under the `/workspace` folder. Keep a to-do list (todo_write) for work of several steps, so the user can follow it.';

export const BUILD_PROMPT = `${BASE}

You are in {{VAR_MODE}} mode: do what the user asks, end to end. Read before you change things, make the changes, and check them (build, run, test) when you can. Feel free to delegate independent pieces of work to sub-agents and orchestrate them.`;

export const PLAN_PROMPT = `${BASE}

You are in {{VAR_MODE}} mode: investigate and plan, but change nothing. Read files, search, and run commands that only look (listing, reading, running the tests is fine; installing, writing, moving or deleting is not). Ask the user when a decision is theirs. End with a plan: the steps in order, the files each one touches, and how to check the result. The user switches to another mode to carry it out.`;

export const SUB_PROMPT = `${BASE}

You are a sub-agent: another agent gave you this task through its delegate tool, and the user is not reading along. Do the task, then end with a report for that agent: what you did, what you found, the paths of anything you created or changed, and anything that failed or is left undone. Your final message is the only thing it receives, so put everything it needs there.`;

export const BUILTIN_MODES = [
    { id: 'build', name: 'Build', description: 'Does the work: reads, changes and runs things.', prompt: BUILD_PROMPT, hidden: false, sub: false, tools: {} },
    { id: 'plan', name: 'Plan', description: 'Looks around and writes a plan; changes nothing.', prompt: PLAN_PROMPT, hidden: false, sub: false,
        tools: { [EDIT_TOOL]: 'off', [WRITE_TOOL]: 'off', [DELEGATE_TOOL]: 'off' } },
    { id: SUB_MODE, name: 'Sub-agent', description: 'What sub-agents work in (delegate).', prompt: SUB_PROMPT, hidden: true, sub: true,
        tools: { [DELEGATE_TOOL]: 'off', [ASK_TOOL]: 'off' } },
].map((m) => ({ ...m, builtin: true }));

const OVERRIDES = new Set(['on', 'off']);
const builtinOf = (id) => BUILTIN_MODES.find((m) => m.id === id) || null;

/** A mode record as kept: known fields only, a built-in one's defaults filled in. */
export function modeShape(m) {
    if (!m || typeof m !== 'object') return null;
    const base = builtinOf(m.id);
    const id = typeof m.id === 'string' && /^[\w-]{1,40}$/.test(m.id) ? m.id : null;
    if (!id) return null;
    const str = (v, d) => (typeof v === 'string' && v.trim() ? v : d);
    const tools = {};
    for (const [k, v] of Object.entries(m.tools && typeof m.tools === 'object' ? m.tools : base?.tools || {})) {
        // Names from before snake_case (Edit, Delegate) are kept under the new ones.
        if (OVERRIDES.has(v)) tools[resolveToolName(k)] = v;
    }
    return {
        id,
        name: str(m.name, base?.name || id).trim().slice(0, 40),
        description: typeof m.description === 'string' ? m.description.slice(0, 200) : base?.description || '',
        prompt: str(m.prompt, base?.prompt || BUILD_PROMPT),
        hidden: typeof m.hidden === 'boolean' ? m.hidden : !!base?.hidden,
        // The sub-agent mode is the built-in one; others can't take its place.
        sub: !!base?.sub,
        tools,
        builtin: !!base,
    };
}

/** A new mode's id from its name: lower case, unique among `modes`. */
export function newModeId(name, modes) {
    const stem = String(name || 'mode').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'mode';
    let id = stem;
    for (let n = 2; modes.some((m) => m.id === id); n++) id = `${stem}-${n}`;
    return id;
}

/* True if a built-in mode is as it ships (nothing to reset). */
export function isDefault(m) {
    const b = builtinOf(m.id);
    if (!b) return false;
    return m.name === b.name && m.description === b.description && m.prompt === b.prompt && m.hidden === b.hidden
        && JSON.stringify(sortKeys(m.tools)) === JSON.stringify(sortKeys(b.tools));
}
const sortKeys = (o) => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => a.localeCompare(b)));
export const defaultOf = (id) => (builtinOf(id) ? modeShape(builtinOf(id)) : null);

/**
 * One mode's choice for a tool: true (on), false (off) or undefined (the Tools
 * settings decide). For tools.withPolicy.
 */
export function modePolicy(mode, name) {
    const v = mode?.tools?.[name];
    return v === 'on' ? true : v === 'off' ? false : undefined;
}

/* The page's localStorage, or null: with storage blocked (all cookies blocked, some
 * private modes), merely reading `localStorage` throws. */
function pageStorage() {
    try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class ModeStore {
    constructor({ storage = pageStorage() } = {}) { this.storage = storage; }

    /**
     * The modes: built-in ones first, in their order, then the user's.
     * @param {{ systemPrompt?: string|null }} legacy  the edited prompt from before modes
     * @returns {{ modes: object[], migrated: boolean }}
     */
    load(legacy = {}) {
        let list = null;
        try { list = JSON.parse(this.storage?.getItem(MODES_KEY)); } catch { /* none */ }
        let migrated = false;
        if (!Array.isArray(list)) {
            list = [];
            if (typeof legacy.systemPrompt === 'string' && legacy.systemPrompt.trim()) {
                list.push({ ...BUILTIN_MODES[0], prompt: legacy.systemPrompt });
                migrated = true;
            }
        }
        const kept = list.map(modeShape).filter(Boolean);
        const seen = new Set();
        const modes = [];
        for (const b of BUILTIN_MODES) {
            modes.push(kept.find((m) => m.id === b.id) || modeShape(b));
            seen.add(b.id);
        }
        for (const m of kept) if (!seen.has(m.id)) { modes.push(m); seen.add(m.id); }
        return { modes, migrated };
    }

    save(modes) {
        try { this.storage?.setItem(MODES_KEY, JSON.stringify(modes.map(modeShape).filter(Boolean))); return true; } catch { return false; }
    }

    clear() { try { this.storage?.removeItem(MODES_KEY); } catch { /* nothing saved */ } }
}
