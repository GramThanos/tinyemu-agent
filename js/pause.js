/*
 * pause.js — noticing when the browser stopped running this page.
 *
 * A browser can stop a page's JavaScript altogether: it freezes a background tab
 * (the Page Lifecycle `freeze` event), the computer sleeps, or someone pauses it
 * in the debugger. The VM's worker stops with it, so the guest makes no progress
 * meanwhile, but Date.now() keeps going: a tool call would come back as timed
 * out, or "the guest stopped responding", for time in which nothing could run.
 *
 * `pauses.now()` is a clock that leaves those stretches out; timeouts use it.
 * A pause is a `freeze`...`resume`, or a gap between heartbeats of more than
 * GAP_MS while the page was visible on both sides. A hidden tab's timers are
 * throttled (Chrome runs them once a minute after a while) while its worker
 * carries on, so long gaps in a hidden tab are not counted unless it froze.
 */

'use strict';

const BEAT_MS = 1000;
const GAP_MS = 5000;

const listeners = new Set();
let total = 0;          // ms of pauses seen so far
let lastBeat = Date.now();
let frozenAt = 0;
let visibleBefore = true;

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function paused(ms, why) {
    if (ms <= 0) return;
    total += ms;
    for (const fn of listeners) {
        try { fn(ms, why); } catch { /* a listener never breaks the clock */ }
    }
}

export const pauses = {
    /** A clock in ms, like Date.now(), that stands still while the page is paused. */
    now() { return Date.now() - total; },
    /** ms of pauses so far: compare two readings to see if one happened between. */
    get total() { return total; },
    /** fn(ms, why) after each pause; returns a function that removes it. */
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** For tests: count a pause by hand. */
    _add(ms) { paused(ms, 'test'); },
};

/* Only in a page: a heartbeat in Node would keep the process alive. */
if (typeof document !== 'undefined' && typeof setInterval === 'function') {
    setInterval(() => {
        const now = Date.now();
        const gap = now - lastBeat;
        const vis = visible();
        if (!frozenAt && gap > GAP_MS && vis && visibleBefore) paused(gap - BEAT_MS, 'gap');
        lastBeat = now;
        visibleBefore = vis;
    }, BEAT_MS);
    document.addEventListener('freeze', () => { frozenAt = Date.now(); });
    document.addEventListener('resume', () => {
        if (frozenAt) paused(Date.now() - frozenAt, 'frozen');
        frozenAt = 0;
        lastBeat = Date.now();
    });
    document.addEventListener('visibilitychange', () => {
        // A tab that comes back after being hidden: its throttled gap isn't a pause.
        if (visible()) { lastBeat = Date.now(); visibleBefore = true; }
    });
}
