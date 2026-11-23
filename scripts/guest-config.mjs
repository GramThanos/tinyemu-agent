// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * guest-config.mjs — the agent's guest.cfg, made from a distro's own config.cfg.
 *
 * scripts/serve.mjs generates it on request and scripts/build.mjs writes it into a
 * release, so the page boots the same distro/<name>/guest.cfg either way.
 *
 * A distro from TinyEMU-distros ships a config.cfg with a ${ASSET_BASE}
 * placeholder for where its files are hosted. The agent's copy differs in three
 * ways:
 *   - ${ASSET_BASE}/ is dropped, so the kernel and disk are named relative to the
 *     config itself, and the site works from any static host and path (GitHub
 *     Pages included). The engine resolves both against the config's URL. A
 *     published copy (TinyEMU-distros' Pages) has ${ASSET_BASE} already filled
 *     in with its own URL: given that URL as `base`, it is dropped the same way,
 *     so scripts/serve.mjs mirrors the kernel and disk too;
 *   - network devices are dropped, so the VM stays offline;
 *   - the JS volumes that js/GuestBridge.js mounts go in the next free fsN slots.
 *     The engine takes at most four (MAX_FS_DEVICE), so the distro can use one.
 */

'use strict';

/* The page's JS volumes, by tag: the tools' bridge, /workspace and /agent/skills. */
export const AGENT_VOLUMES = ['agent', 'workspace', 'skills'];

/**
 * @param {string} distroCfg  the distro's config.cfg text
 * @param {string[]} [volumes]
 * @param {{ base?: string }} [opts]  base: the URL the distro was published at
 * @returns {string}
 */
export function guestConfigText(distroCfg, volumes = AGENT_VOLUMES, { base } = {}) {
    let text = distroCfg;
    if (base) {
        // Only files right under it: a path that goes on into a folder isn't the distro's.
        const quoted = base.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`"${quoted}/(?=[^"/]+")`, 'g'), '"');
    }
    const cfg = text
        .replaceAll('"${ASSET_BASE}/', '"')
        .replaceAll('${ASSET_BASE}', 'this file\'s directory')   // in the distro's comment
        .replace(/^[ \t]*eth\d+\s*:.*\n/gm, '');
    const used = new Set([...cfg.matchAll(/\bfs(\d+)\s*:/g)].map((m) => +m[1]));
    const free = () => { let n = 0; while (used.has(n)) n++; used.add(n); return n; };
    const end = cfg.lastIndexOf('}');
    const head = cfg.slice(0, end).trimEnd();
    const sep = head.endsWith(',') || head.endsWith('{') ? '' : ',';
    return '/* The agent\'s config: GENERATED from config.cfg by scripts/guest-config.mjs (tinyemu-agent). */\n'
        + `${head}${sep}\n${volumes.map((v) => `    fs${free()}: { file: "js:${v}", tag: "${v}" },\n`).join('')}}\n`;
}

/* The engine's machine names, as the page's arch names. */
const ARCH = { pc: 'x86', riscv32: 'riscv32', riscv64: 'riscv64', riscv128: 'riscv128' };

/**
 * A distro's entry in distro/index.json, which lists the machines the page can
 * boot (its VM tab): { name, label, arch }.
 * @param {string} name       the distro's folder name
 * @param {string} distroCfg  its config.cfg text
 */
export function distroEntry(name, distroCfg) {
    const machine = distroCfg.match(/^\s*machine\s*:\s*"([^"]+)"/m)?.[1] || 'pc';
    const arch = ARCH[machine] || machine;
    // "alpine-3.20-x86" -> "Alpine 3.20 (x86)", "debian-13-riscv64-lite" -> "Debian 13 lite (riscv64)"
    const words = name.split(/[-_]/).filter((w) => w !== arch);
    const label = `${words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')} (${arch})`;
    return { name, label, arch };
}
