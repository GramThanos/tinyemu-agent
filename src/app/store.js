// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * store.js — how the page's state reaches React.
 *
 * The page's state is plain objects the agent's modules change in place (chat
 * records, sessions, environments, providers), as they always have: the agent
 * loop, the environments and the stores are not React code, and their records are
 * saved as they are. What React subscribes to are *topics*, each a version number
 * that `emit(topic)` moves on (useSyncExternalStore's snapshot: a number, so it is
 * immutable and compares with Object.is). A component reads the objects during
 * render and re-renders when a topic it uses moved.
 *
 * Topics: 'ui' (everything about the open chat and the page's chrome), 'log:<chat
 * id>' (a chat's log, which streams), 'files', 'settings', 'mcp', 'skills'. A
 * finer topic keeps a streaming chat from redrawing the rest of the page.
 *
 * The React Compiler is not used: it memoizes on the identity of what a component
 * reads, and these objects change without changing identity.
 */

'use strict';

import { useCallback, useSyncExternalStore } from 'react';

const versions = new Map();   // topic -> number
const listeners = new Map();  // topic -> Set of callbacks

export function emit(...topics) {
    for (const t of topics) {
        versions.set(t, (versions.get(t) || 0) + 1);
        for (const fn of listeners.get(t) || []) fn();
    }
}

export function subscribe(topic, fn) {
    let set = listeners.get(topic);
    if (!set) listeners.set(topic, (set = new Set()));
    set.add(fn);
    return () => { set.delete(fn); if (!set.size) listeners.delete(topic); };
}

/** Re-render when any of `topics` moves on. @returns the versions, joined. */
export function useTopics(...topics) {
    const key = topics.join('\n');
    const sub = useCallback((fn) => {
        const offs = key.split('\n').map((t) => subscribe(t, fn));
        return () => offs.forEach((off) => off());
    }, [key]);
    const snap = useCallback(() => key.split('\n').map((t) => versions.get(t) || 0).join(','), [key]);
    return useSyncExternalStore(sub, snap);
}

export const useUI = () => useTopics('ui');
