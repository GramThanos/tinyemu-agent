// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * layout.js — the sidebar and the panel: shown or hidden, their widths, and the
 * panel's tab, remembered in this browser. On a narrow screen the sidebar slides
 * in and the panel goes over the chat.
 */

'use strict';

import { emit } from './store.js';
import { readJSON, writeJSON } from './state.js';

export const LAYOUT = 'tinyemu-agent-layout';
export const TABS = ['files', 'console', 'machine', 'log'];
export const CENTER_MIN = 360;
export const SIDE_MIN = 180, SIDE_MAX = 480, PANEL_MIN = 280;

export const layout = (() => {
    const l = readJSON(LAYOUT, {});
    return l && typeof l === 'object' ? l : {};
})();
if (!TABS.includes(layout.tab)) layout.tab = 'files';

const NARROW = '(max-width: 900px)';
export const narrow = () => matchMedia(NARROW).matches;
/* Narrow-screen state that isn't kept: the sidebar slid in. */
export const view = { sideOpen: false };

export function saveLayout() { writeJSON(LAYOUT, layout); }
export function changeLayout(patch) {
    Object.assign(layout, patch);
    saveLayout();
    emit('ui');
}

export const panelShown = () => (narrow() ? !!layout.panelNarrow : !layout.noPanel);
export const sideHidden = () => !!layout.noSide && !narrow();

export function showPanel(tab = layout.tab) {
    changeLayout({ tab, ...(narrow() ? { panelNarrow: true } : { noPanel: false }) });
}
export function hidePanel() {
    changeLayout(narrow() ? { panelNarrow: false } : { noPanel: true });
}
export function togglePanel() {
    if (panelShown()) hidePanel(); else showPanel();
}
export function hideSidebar() {
    if (narrow()) { view.sideOpen = false; emit('ui'); } else changeLayout({ noSide: true });
}
export function showSidebar() {
    if (narrow()) { view.sideOpen = !view.sideOpen; emit('ui'); } else changeLayout({ noSide: false });
}

/* A width for the sidebar (sideW) or the panel (panelW), keeping the chat CENTER_MIN wide. */
export function clampSize(key, w, { sideWidth, panelWidth }) {
    if (key === 'sideW') return Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, w, innerWidth - panelWidth - CENTER_MIN)));
    return Math.round(Math.max(PANEL_MIN, Math.min(w, innerWidth - sideWidth - CENTER_MIN)));
}

matchMedia(NARROW).addEventListener('change', () => emit('ui'));
