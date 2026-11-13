/*
 * keepAwake.js — keep the computer and the browser from stopping the page while
 * the agent works.
 *
 * Two measures, each a setting, both active only while some turn runs:
 *
 * - A Screen Wake Lock (navigator.wakeLock): the screen doesn't dim or lock, and
 *   so the computer doesn't go to sleep. Browsers release it when the tab is
 *   hidden, so it is asked for again each time the tab comes back.
 *
 * - A quiet sound (the "audio" setting, off by default): Chrome freezes a tab
 *   only after it has been hidden *and silent* for five minutes, and throttles
 *   the timers of a tab that hasn't played sound lately. A tab Chrome hears as
 *   audible is spared both. The page plays a short, very quiet low tone every
 *   PERIOD_S seconds, from a looping buffer on the audio clock, so no timer of
 *   the page (which a hidden tab throttles) has to fire for it. The tab shows the
 *   speaker icon while it runs. An AudioContext may only start after a click or
 *   key press, so until the user's next one it may wait.
 */

'use strict';

/* Seconds between two tones: well inside the 30 s Chrome uses for "played sound
 * lately", and the five minutes before it freezes a silent tab. */
export const PERIOD_S = 15;
const TONE_S = 0.6;          // how long each tone lasts
const TONE_HZ = 40;          // low: most speakers barely play it
/* About -54 dBFS: far below what anyone hears, above the -72 dBFS under which
 * Chrome counts a tab as silent. */
const TONE_GAIN = 0.002;

/** The looping buffer: one quiet tone, faded in and out (no click), then silence. */
export function toneSamples(rate, periodS = PERIOD_S) {
    const out = new Float32Array(Math.round(rate * periodS));
    const n = Math.round(rate * TONE_S);
    const fade = Math.round(rate * 0.1);
    for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / fade, (n - 1 - i) / fade);
        out[i] = TONE_GAIN * env * Math.sin((2 * Math.PI * TONE_HZ * i) / rate);
    }
    return out;
}

/**
 * @param {object} o
 * @param {() => boolean} o.wakeLock   the setting, read at each change
 * @param {() => boolean} o.audio      the setting, read at each change
 * @param {() => void} [o.onChange]    the state changed (for the Settings line)
 */
export function createKeepAwake({ wakeLock, audio, onChange = () => {} }) {
    let active = false;
    let lock = null;          // the WakeLockSentinel held now
    let lockState = 'off';    // off | held | unsupported | denied | hidden
    let requesting = false;   // a request is out: don't send a second
    let ctx = null;           // the AudioContext, made at first use
    let source = null;
    let audioState = 'off';   // off | playing | waiting (for a click) | unsupported

    const changed = () => { try { onChange(); } catch { /* the page's problem */ } };

    async function applyLock() {
        const want = active && wakeLock();
        if (!want) {
            const l = lock;
            lock = null;
            lockState = 'off';
            if (l) await l.release().catch(() => {});
            changed();
            return;
        }
        if (lock || requesting) return;
        if (!navigator.wakeLock?.request) { lockState = 'unsupported'; changed(); return; }
        if (document.visibilityState !== 'visible') { lockState = 'hidden'; changed(); return; }
        requesting = true;
        try {
            const l = await navigator.wakeLock.request('screen').finally(() => { requesting = false; });
            // Settings or the turn may have changed while it was asked for.
            if (!(active && wakeLock())) { await l.release().catch(() => {}); return; }
            lock = l;
            lockState = 'held';
            l.addEventListener('release', () => {
                if (lock !== l) return;
                lock = null;
                lockState = document.visibilityState === 'visible' ? 'off' : 'hidden';
                changed();
            });
        } catch {
            lockState = 'denied';   // a policy, low battery, or not allowed here
        }
        changed();
    }

    async function applyAudio() {
        const want = active && audio();
        if (!want) {
            if (source) { try { source.stop(); } catch { /* already */ } source = null; }
            if (ctx && ctx.state === 'running') await ctx.suspend().catch(() => {});
            audioState = 'off';
            changed();
            return;
        }
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) { audioState = 'unsupported'; changed(); return; }
        if (!ctx) ctx = new AC();
        if (!source) {
            const samples = toneSamples(ctx.sampleRate);
            const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
            buf.copyToChannel(samples, 0);
            source = ctx.createBufferSource();
            source.buffer = buf;
            source.loop = true;
            source.connect(ctx.destination);
            source.start();
        }
        if (ctx.state !== 'running') await ctx.resume().catch(() => {});
        audioState = ctx.state === 'running' ? 'playing' : 'waiting';
        changed();
    }

    const apply = () => Promise.all([applyLock(), applyAudio()]);

    // The lock goes when the tab is hidden: ask again when it is back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applyLock(); });
    // Audio that had to wait for the user starts at their next click or key.
    const gesture = () => { if (audioState === 'waiting') applyAudio(); };
    addEventListener('pointerdown', gesture, true);
    addEventListener('keydown', gesture, true);

    return {
        /** Some turn runs (true) or none does (false). */
        set(running) {
            if (running === active) return;
            active = running;
            apply();
        },
        /** A setting changed. */
        refresh() { apply(); },
        state() { return { active, wakeLock: lockState, audio: audioState }; },
    };
}
