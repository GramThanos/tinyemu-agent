// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * dialogs.js — the page's own dialogs and menus (no library): a modal choice, the
 * composer's menus, Settings, the project dialog, and the two floating panels in
 * the chat header. Each is a field of UI (state.js) that a component draws.
 */

'use strict';

import { emit } from './store.js';
import { UI } from './state.js';

/* A modal choice: resolves with the picked option's value, or null (Esc, Cancel).
 * Its button click is a user activation, which the folder picker needs.
 * options: [{ value, label, hint }] */
export function choose(title, text, options) {
    return new Promise((resolve) => {
        UI.choice?.resolve(null);
        UI.choice = { title, text, options, resolve: (v) => { UI.choice = null; emit('ui'); resolve(v); } };
        emit('ui');
    });
}

/* items: { group } | { sep } | { label, hint, checked, disabled, onclick };
 * anchor: the element the menu opens from. */
export function openMenu(anchor, items) {
    UI.menu = { rect: anchor.getBoundingClientRect(), items };
    emit('ui');
}
export function closeMenu() {
    if (!UI.menu) return;
    UI.menu = null;
    emit('ui');
}

export function openSettings(tab = 'models') {
    UI.settings = tab;
    emit('ui', 'settings');
}
export function closeSettings() {
    UI.settings = null;
    emit('ui', 'settings');
}

/** The project dialog: a project's settings, or a new one (null). */
export function openProject(p) {
    UI.project = p;
    emit('ui');
}
export function closeProject() {
    UI.project = undefined;
    emit('ui');
}

export function toggleChatInfo(open = !UI.chatInfo) {
    UI.chatInfo = open;
    if (open) UI.contextPanel = false;
    emit('ui');
}
export function toggleContextPanel(open = !UI.contextPanel) {
    UI.contextPanel = open;
    if (open) UI.chatInfo = false;
    emit('ui');
}

/* What an import or a deletion did, under Settings → Skills' bar (the chat is
 * behind the dialog). Problems in red, the rest as a note; empty hides it. */
export function skillsNote(problems = [], note = '') {
    UI.skillsNote = { problems, note };
    emit('skills');
}
