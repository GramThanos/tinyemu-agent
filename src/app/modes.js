// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * modes.js — the page's modes (js/modes.js): the list kept in this browser, the
 * mode each chat works in, and changing them from Settings → Modes and the picker
 * next to the message box.
 */

'use strict';

import { DEFAULT_MODE, defaultOf, ModeStore, modePolicy, modeShape, newModeId, SUB_MODE } from '../../js/modes.js';
import { emit } from './store.js';
import { chatById, S } from './state.js';
import { setSettings, settings } from './settings.js';

export const modeStore = new ModeStore();
{
    const r = modeStore.load({ systemPrompt: settings.systemPrompt });
    S.modes = r.modes;
    // The edited prompt from before modes is the build mode's now.
    if (r.migrated) { modeStore.save(S.modes); setSettings({ systemPrompt: null }); }
}

export function saveModes() {
    if (!modeStore.save(S.modes)) alert('This browser has no storage for the modes, so changes last until the page reloads.');
    emit('modes', 'ui');
}

export const modeById = (id) => S.modes.find((m) => m.id === id) || null;
/* The mode a chat works in: its own, else build. A sub-agent's chat: the sub-agent mode. */
export function modeOf(c) {
    if (c?.kind === 'sub') return modeById(SUB_MODE);
    return modeById(c?.mode) || modeById(DEFAULT_MODE);
}
export const subMode = () => modeById(SUB_MODE);
/* The modes the picker offers: not hidden, not the sub-agent one, and a chat's own. */
export const pickableModes = (c) => S.modes.filter((m) => (!m.hidden && !m.sub) || m === modeOf(c));

/** A tool policy that follows a chat's mode as it changes (tools.withPolicy). */
export const policyOf = (c) => (name) => modePolicy(modeOf(chatById(c.id) || c), name);
export const subPolicy = () => (name) => modePolicy(subMode(), name);

/** Put a mode in place of the one with its id, or add it. */
export function putMode(m) {
    const shaped = modeShape(m);
    const i = S.modes.findIndex((x) => x.id === shaped.id);
    if (i >= 0) S.modes[i] = shaped; else S.modes.push(shaped);
    saveModes();
    return shaped;
}
export function addMode(name = 'New mode') {
    const base = modeById(DEFAULT_MODE);
    return putMode({ id: newModeId(name, S.modes), name, description: '', prompt: base.prompt, hidden: false, tools: {} });
}
export function removeMode(m) {
    if (m.builtin) return;
    S.modes = S.modes.filter((x) => x !== m);
    // Chats that worked in it go back to build.
    for (const c of S.chats) if (c.mode === m.id) c.mode = DEFAULT_MODE;
    saveModes();
}
export function resetMode(m) {
    const d = defaultOf(m.id);
    if (d) putMode(d);
}
