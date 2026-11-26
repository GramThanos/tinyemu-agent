// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ConsolePane.jsx — the console: the open chat's VM, in xterm.js (MIT, an npm
 * dependency, loaded as its own chunk the first time the tab shows). One terminal
 * shows the open chat's VM: switching chats replays that VM's recent output
 * (env.console, escape codes kept) into it. The fit add-on sizes it to the panel,
 * and the guest's tty is told the new size (env.resizeConsole). If the library
 * can't load, the console falls back to plain text and a line to type in.
 */

import { useEffect, useRef, useState } from 'react';
import { S } from '../../app/state.js';
import { envOf } from '../../app/world.js';

const TERM_KEEP = 200000;
/* The fallback's text: the output less its escape codes. */
const plainText = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '').replace(/[\x00\x07\r]/g, '');

let loading = null;
function loadXterm() {
    loading ||= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])
        .then(([{ Terminal }, { FitAddon }]) => ({ Terminal, FitAddon }));
    return loading;
}

export default function ConsolePane({ active }) {
    const host = useRef(null);
    const plain = useRef(null);
    const term = useRef(null);       // { term, fit } once loaded
    const shows = useRef(null);      // the environment the terminal shows
    const [failed, setFailed] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const env = envOf(S.chat);
    const none = env.kind !== 'vm';

    // The terminal, once, the first time the tab shows.
    useEffect(() => {
        if (!active || term.current || failed) return;
        let gone = false;
        loadXterm().then(({ Terminal, FitAddon }) => {
            if (gone || term.current) return;
            const t = new Terminal({
                fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace',
                fontSize: 12, lineHeight: 1.2, scrollback: 5000, cursorBlink: true, convertEol: false,
                theme: { background: '#11110f', foreground: '#e9e7e2', cursor: '#d4845f', selectionBackground: '#4a3a30' },
            });
            const fit = new FitAddon();
            t.loadAddon(fit);
            t.open(host.current);
            // Keys typed in the terminal go to the guest as they are (a VM still off starts).
            t.onData((data) => {
                const e = shows.current;
                if (e?.kind !== 'vm') return;
                if (e.status !== 'ready') e.warm();
                e.sendInput(data);
            });
            t.onResize(({ cols, rows }) => shows.current?.resizeConsole(cols, rows));
            term.current = { term: t, fit };
            setLoaded(true);
            fitNow();
        }).catch((e) => {
            console.warn('console: xterm.js did not load, using plain text', e);
            setFailed(true);
        });
        return () => { gone = true; };
    }, [active, failed]);

    const fitNow = () => {
        const h = host.current;
        if (!term.current || !h?.offsetWidth || !h.offsetHeight) return;
        try { term.current.fit.fit(); } catch { /* not laid out yet */ }
    };
    // Fit whenever the host changes size (the panel resized, the window, the tab shown).
    useEffect(() => {
        const ro = new ResizeObserver(fitNow);
        ro.observe(host.current);
        return () => ro.disconnect();
    }, []);

    // Show the open chat's VM: its recent output, then what it writes. Guest output can
    // arrive far faster than the page can draw it: batched, on a timer (a frame
    // callback never fires in a hidden tab).
    const ready = loaded || failed;
    useEffect(() => {
        if (!active || !ready) return;
        shows.current = none ? null : env;
        const t = term.current?.term;
        if (t) { t.reset(); fitNow(); } else if (plain.current) plain.current.textContent = '';
        if (none) return;
        // The guest learns this terminal's size, also when it was another chat's VM before.
        if (t) { t.write(env.console); env.resizeConsole(t.cols, t.rows); } else if (plain.current) plain.current.textContent = plainText(env.console);
        let pending = '';
        let timer = 0;
        const flush = () => {
            timer = 0;
            const text = pending;
            pending = '';
            if (term.current) { term.current.term.write(text); return; }
            const p = plain.current;
            if (!p) return;
            const atEnd = p.scrollTop + p.clientHeight >= p.scrollHeight - 4;
            const more = plainText(text);
            if (p.textContent.length + more.length > TERM_KEEP) p.textContent = (p.textContent + more).slice(-TERM_KEEP / 2);
            else p.append(more);
            if (atEnd) p.scrollTop = p.scrollHeight;
        };
        const off = env.on((what, e, text) => {
            if (what !== 'console') return;
            if (!timer) timer = setTimeout(flush, 30);
            pending = (pending + text).slice(-TERM_KEEP);
        });
        return () => { off(); clearTimeout(timer); };
    }, [active, ready, env, none]);

    const sendLine = (e) => {
        if (e.key !== 'Enter') return;
        if (env.kind === 'vm') {
            if (env.status !== 'ready') env.warm();
            env.sendInput(`${e.target.value}\n`);
        }
        e.target.value = '';
    };
    return (
        <div id="consolePane" role="tabpanel" aria-labelledby="tabConsole" hidden={!active}>
            {none && <div id="consoleNone" className="pane-note">This chat works in bash.js, which has no console: its commands show in the chat.
                Pick a TinyEMU machine in the message box to have one.</div>}
            <div id="termHost" ref={host} aria-label="VM console" hidden={none || failed} />
            {failed && !none && <>
                <pre id="term" ref={plain} />
                <input id="stdin" placeholder="VM console: type a command, Enter sends" autoComplete="off" onKeyDown={sendLine} />
            </>}
        </div>
    );
}
