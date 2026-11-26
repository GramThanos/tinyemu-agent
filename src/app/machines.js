// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * machines.js — TinyEMU-distros' systems, and how a VM of one is made.
 *
 * The distros are TinyEMU-distros' (js/distros.js), listed by its Pages'
 * manifest.json; without it only the default is offered. A distro name that isn't
 * a plain folder name is ignored, so nothing can point outside those Pages; ?cfg=
 * boots any other config, as the default project's "custom" machine.
 */

'use strict';

import { agentConfig, DISTROS_PAGES, distroLabel, ENGINE, parseManifest } from '../../js/distros.js';
import { params, readJSON, S, writeJSON } from './state.js';

export const DEFAULT_DISTRO = 'debian-13-riscv64-lite';
export const MEMORY_SIZES = [128, 256, 512];
// What this page's engine runs: x86emu-wasm has the PC and the RISC-V machines.
export const ENGINE_ARCHES = ['x86', 'riscv32', 'riscv64'];
export const STATUS_WORDS = { off: 'not started', starting: 'starting', ready: 'ready', pausing: 'pausing', paused: 'paused', failed: 'failed' };

export async function loadDistros() {
    const url = new URL('manifest.json', DISTROS_PAGES).href;
    try {
        const r = await fetch(url, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        S.distroList = parseManifest(await r.json(), url);
    } catch (e) { S.distroProblem = `${url}: ${e.message}`; }
}
// One not in the list (offline, or a name it lacks) is still looked for there.
export const distroInfo = (name) => S.distroList.find((d) => d.name === name) || {
    name,
    label: name === DEFAULT_DISTRO ? distroLabel(name, 'riscv64') : name,
    arch: /riscv64/.test(name) ? 'riscv64' : /riscv32/.test(name) ? 'riscv32' : 'x86',
    description: '',
    config: new URL(`${name}/config.cfg`, DISTROS_PAGES).href,
};
const runnable = (d) => ENGINE_ARCHES.includes(d.arch);
/* The machines a chat can pick: the manifest's runnable ones, or just the default. */
export const machineChoices = () => (S.distroList.length ? S.distroList.filter(runnable) : [distroInfo(DEFAULT_DISTRO)]);
const plainLabel = (d) => (d.label || d.name).replace(/\s*\([^)]*\)$/, '');
export const envLabelOf = (key) => {
    if (key === 'bashjs') return 'bash.js';
    const name = key.slice(3);
    if (name === 'custom') return 'Custom config';
    return plainLabel(distroInfo(name));
};
export { plainLabel };

/* The engine: ENGINE, or ?engine= naming another release on TinyEMU's Pages, or
 * a folder on this page's own origin (a local build: ?engine=deps/TinyEMU/dist/wasm/).
 * Nothing else, so a link can't make the page run code from anywhere else. */
export const engineRelease = () => {
    const e = params.get('engine') || '';
    if (/^[\w.-]+$/.test(e)) return e;
    try {
        const u = new URL(e.endsWith('/') ? e : `${e}/`, location.href);
        if (e && u.origin === location.origin) return u.href;
    } catch { /* not a URL */ }
    return ENGINE;
};

/* A VM's options, less its volumes (the environment adds them, per project). */
export function vmOptions({ distro, memoryMB, jit }) {
    const custom = distro === 'custom' ? params.get('cfg') : null;
    const x86 = !!custom || distroInfo(distro).arch === 'x86';
    return {
        // The distro's own config.cfg on TinyEMU-distros' Pages (?cfg=: any config),
        // changed on the page for the agent (agentConfig: no network, the JS volumes).
        configUrl: custom ? new URL(custom, location.href).href : distroInfo(distro).config,
        configOverride: agentConfig(),
        mode: 'worker',
        memoryMB: parseInt(params.get('mem'), 10) > 0 ? parseInt(params.get('mem'), 10) : memoryMB,
        cmdline: (x86 ? [
            // Make the boot visible: early messages go to the serial port, which
            // shares the console, and the log level is raised.
            'earlyprintk=ttyS0 loglevel=7',
            // Keep time with the TSC, which runs at a fixed 100 MHz of host time
            // (TSC_FREQ in x86_machine.c). Linux can't calibrate it against the
            // PIT here, so it would count timer ticks instead, and the WASM
            // emulator can't deliver 1000 a second, so the guest clock ran slow.
            // highres/nohz off keep the tick periodic, which is much cheaper to
            // emulate than reprogramming the PIT for every timer.
            'tsc_early_khz=100000 tsc=reliable highres=off nohz=off',
        ] : [
            // RISC-V keeps time with the CLINT's mtime, which follows host time, so
            // it needs none of that; OpenSBI's banner already shows on the console.
            'loglevel=7',
        ]).join(' '),
        hasNetwork: false,
        cols: 80,
        rows: 24,
        // The engine's x86 -> WebAssembly JIT (x86_jit.c), for x86 machines only
        // (?jit=0 turns it off), so a RISC-V saved state doesn't depend on it.
        x86jit: jit && params.get('jit') !== '0' && x86,
        // ?jittail=1: chain compiled pages with WebAssembly tail calls instead of
        // through C. Slower than through C, so off unless asked for.
        x86jitTailcalls: params.get('jittail') === '1',
    };
}

/* Boot and resume times across visits, for the Environment panel: the latest BOOT_KEEP. */
export const BOOT_HISTORY = 'tinyemu-agent-boot-history';
const BOOT_KEEP = 20;
export function bootHistory() {
    const list = readJSON(BOOT_HISTORY, []);
    return Array.isArray(list) ? list.filter((b) => b && Number.isFinite(b.seconds)) : [];
}
export function recordBoot(env) {
    const seconds = Math.round(env.bootMs / 100) / 10;
    if (!Number.isFinite(seconds)) return null;
    writeJSON(BOOT_HISTORY, [...bootHistory(), { at: Date.now(), how: env.how, seconds, distro: env.spec.distro }].slice(-BOOT_KEEP));
    return seconds;
}
