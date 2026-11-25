// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * distros.js — the machines the page can boot, and the config it boots them with.
 *
 * Nothing is copied into this site: the distros come from TinyEMU-distros' GitHub
 * Pages, whose manifest.json lists them, and each one boots from its own
 * config.cfg there (absolute URLs, served with CORS). The engine comes from
 * TinyEMU's Pages the same way (jsLab's engine.js; ENGINE below).
 *
 * The agent changes a distro's config in two ways, through jsLab's
 * configOverride (applied on the page, booted as a data: URL):
 *   - network devices are dropped, so the VM stays offline;
 *   - the JS volumes that js/GuestBridge.js mounts go in the next free fsN slots.
 *     The engine takes at most four (MAX_FS_DEVICE), so the distro can use one.
 * A config still holding TinyEMU-distros' literal ${ASSET_BASE} (a local build
 * served as it was unpacked) gets its files named relative to itself.
 */

'use strict';

/* TinyEMU-distros' Pages: <name>/config.cfg for each distro, manifest.json lists them. */
export const DISTROS_PAGES = 'https://gramthanos.github.io/TinyEMU-distros/';

/* The TinyEMU engine release the page boots (jsLab's engineUrls). Pinned, since a
 * saved VM state only resumes on the engine it was saved with; ?engine= picks
 * another release for one load. */
export const ENGINE = 'v2026-11-23';

/* The page's JS volumes, by tag: the tools' bridge, /workspace and /agent/skills. */
export const AGENT_VOLUMES = ['agent', 'workspace', 'skills'];

const NAME = /^[\w-][\w.-]*$/;

/* "debian-13-riscv64-lite" (arch riscv64) -> "Debian 13 lite (riscv64)" */
export function distroLabel(name, arch) {
    const words = name.split(/[-_]/).filter((w) => w && w !== arch);
    if (!words.length) return name;
    return `${words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')}${arch ? ` (${arch})` : ''}`;
}

/**
 * The distros in a manifest.json: [{ name, label, arch, description, config }],
 * `config` an absolute URL. Entries without a plain name or an http(s) config
 * are left out.
 * @param {object} manifest  { distros: [{ name, arch, description, config, url }] }
 * @param {string} base      the manifest's URL
 */
export function parseManifest(manifest, base) {
    const list = Array.isArray(manifest?.distros) ? manifest.distros : [];
    const out = [];
    for (const d of list) {
        if (!d || typeof d.name !== 'string' || !NAME.test(d.name)) continue;
        let config;
        try { config = new URL(typeof d.url === 'string' ? d.url : typeof d.config === 'string' ? d.config : `${d.name}/config.cfg`, base); } catch { continue; }
        if (!/^https?:$/.test(config.protocol)) continue;
        const arch = typeof d.arch === 'string' ? d.arch : 'x86';
        out.push({
            name: d.name,
            label: distroLabel(d.name, arch),
            arch,
            description: typeof d.description === 'string' ? d.description : '',
            config: config.href,
        });
    }
    return out;
}

/**
 * jsLab's configOverride for the agent: drops ethN, adds the volumes. Given the
 * parsed config with its paths already absolute; changes it in place.
 * @param {string[]} [volumes]
 */
export function agentConfig(volumes = AGENT_VOLUMES) {
    return (cfg) => {
        for (const k of Object.keys(cfg)) {
            if (/^eth\d+$/.test(k)) delete cfg[k];
        }
        // An unfilled ${ASSET_BASE} ("this file's directory") was made absolute as a
        // folder of that name: take it out again.
        const unplaced = /\/(?:\$\{ASSET_BASE\}|\$%7BASSET_BASE%7D)\//gi;
        for (const k of ['bios', 'kernel', 'initrd']) {
            if (typeof cfg[k] === 'string') cfg[k] = cfg[k].replace(unplaced, '/');
        }
        for (const [k, v] of Object.entries(cfg)) {
            if (/^drive\d+$/.test(k) && v && typeof v.file === 'string') v.file = v.file.replace(unplaced, '/');
        }
        const used = new Set(Object.keys(cfg).map((k) => /^fs(\d+)$/.exec(k)?.[1]).filter(Boolean).map(Number));
        let n = 0;
        for (const tag of volumes) {
            while (used.has(n)) n++;
            used.add(n);
            cfg[`fs${n}`] = { file: `js:${tag}`, tag };
        }
        return cfg;
    };
}
