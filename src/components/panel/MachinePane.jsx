// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * MachinePane.jsx — the Environment tab: the open chat's environment (its
 * figures, and the engine's counters sampled every 2 s while the tab shows), and
 * every environment of its project, with who uses it.
 */

import { useEffect, useState } from 'react';
import { formatSize, megabytes, params, S, chatById } from '../../app/state.js';
import { bootHistory, distroInfo, engineRelease, STATUS_WORDS } from '../../app/machines.js';
import { chatTools, envOf, pool, projectOf, rt } from '../../app/world.js';
import { addMessage } from '../../app/sessions.js';

/* The engine's counters of a VM: { stats, rate } (instructions a second). */
function useEngine(env) {
    const [sample, setSample] = useState({ env: null, stats: null, rate: null, last: null });
    useEffect(() => {
        let last = null;
        let gone = false;
        const tick = async () => {
            if (!env?.vm?.engineStats || env.status !== 'ready') return;
            try {
                const st = await env.vm.engineStats();
                if (gone) return;
                const now = performance.now();
                const rate = last && st.cycles >= 0 && last.cycles >= 0 && now > last.at ? ((st.cycles - last.cycles) / (now - last.at)) * 1000 : null;
                last = { cycles: st.cycles, at: now };
                setSample((s) => ({ env, stats: st, rate: rate ?? (s.env === env ? s.rate : null) }));
            } catch { /* stopped meanwhile */ }
        };
        tick();
        const t = setInterval(tick, 2000);
        return () => { gone = true; clearInterval(t); };
    }, [env, env.status]);
    return sample.env === env ? sample : { stats: null, rate: null };
}

function EnvList({ p, mine }) {
    const x = pool.project(p, rt(p).volumes);
    const envs = [...x.envs.values()].filter((e) => e.users.size || e.vm || e.saved || e === mine);
    if (!envs.length) return <p className="hint">None yet.</p>;
    return envs.map((e) => {
        const users = [...e.users].map(chatById).filter(Boolean);
        const bits = [e.kind === 'vm' ? STATUS_WORDS[e.status] : 'in the page',
            users.length ? `used by ${users.map((c) => `“${c.title}”`).join(', ')}` : 'no chat uses it', e.busy ? 'working' : ''];
        const del = async () => {
            if (!confirm(`Delete ${e.label} of ${p.name}? It stops, and its saved state is deleted; the next chat that uses it boots it afresh. The workspace stays.`)) return;
            await e.discard().catch((err) => addMessage('problem', `Could not delete ${e.label}: ${err.message}`));
        };
        return (
            <div key={e.key} className={`envcard${e === mine ? ' current' : ''}`}>
                <span className="en">{e.label}</span>
                <span className="es">{bits.filter(Boolean).join(' · ')}</span>
                <div className="eb">
                    {e.kind === 'vm' && e.status === 'ready' && (
                        <button disabled={e.busy} onClick={() => e.pause().catch((err) => addMessage('problem', `Could not pause ${e.label}: ${err.message}`))}>Pause</button>
                    )}
                    {e.kind === 'vm' && (e.vm || e.saved || e.status === 'paused') && (
                        <button className="danger" title="Stop it and delete its saved state; the workspace stays" disabled={e.busy} onClick={del}>Delete</button>
                    )}
                </div>
            </div>
        );
    });
}

export default function MachinePane() {
    const env = envOf(S.chat);
    const { stats: st, rate } = useEngine(env);
    const rows = [['Project', env.project.name]];
    if (env.kind === 'bashjs') {
        rows.push(['Environment', 'bash.js, in the page']);
        rows.push(['What it has', 'bash and its own utilities (cat, grep, sed, awk, find, …) on /workspace and /agent/skills, '
            + 'and an in-memory /tmp; no programs of a VM']);
        rows.push(['Shells', `${env.tools.shells().length}`]);
    } else {
        const d = distroInfo(env.spec.distro);
        rows.push(['System', d.description || d.label || d.name]);
        rows.push(['Engine', `TinyEMU ${engineRelease()}`]);
        rows.push(['Processor', env.spec.distro === 'custom' ? 'as the config says' : d.arch]);
        rows.push(['Memory', `${env.spec.memoryMB} MB`]);
        if (d.arch === 'x86') {
            const blocks = st?.jitBlocks;
            rows.push(['x86 JIT', !env.spec.jit ? 'off' : blocks > 0 ? `on, ${blocks.toLocaleString()} blocks compiled`
                : blocks < 0 ? 'off: this engine build has none, or the browser refused it' : 'on']);
        }
        rows.push(['State', `${STATUS_WORDS[env.status]}${env.stage ? ` (${env.stage})` : ''}`
            + (env.status === 'ready' && env.how ? `, ${env.how} in ${(env.bootMs / 1000).toFixed(1)} s` : '')]);
        rows.push(['Saved state', params.has('nosnapshot') ? 'off (?nosnapshot=1)'
            : env.saved ? `${new Date(env.saved.at).toLocaleString()}, ${megabytes(env.saved.size)}` : 'none yet']);
        const mips = (r) => `${(r / 1e6).toFixed(r >= 1e7 ? 0 : 1)} M/s`;
        if (st && st.cycles >= 0) {
            rows.push(['Speed', rate !== null ? `now ${mips(rate)}` : 'measuring…']);
            rows.push(['Instructions', `${(st.cycles / 1e9).toFixed(2)} billion since ${env.how === 'resumed' ? 'the saved state was booted' : 'boot'}`]);
        }
        if (st && st.diskChunks >= 0) rows.push(['Disk', `${st.diskChunks.toLocaleString()} chunks downloaded, ${formatSize(st.diskBytes)}`]);
        for (const [name, v] of Object.entries(st?.volumes || {})) {
            rows.push([`Volume ${name}`, `${v.reads.toLocaleString()} reads (${formatSize(v.readBytes)}), `
                + `${v.writes.toLocaleString()} writes (${formatSize(v.writeBytes)})`]);
        }
        if (S.lastHealth && env.status === 'ready') {
            const h = S.lastHealth;
            const mem = h.memTotalKB ? `${Math.round((h.memAvailableKB ?? 0) / 1024)} MB free of ${Math.round(h.memTotalKB / 1024)} MB` : null;
            rows.push(['Guest', [mem, h.load1 !== null ? `load ${h.load1} / ${h.load5} / ${h.load15}` : null,
                h.procs ? `${h.procs} processes` : null].filter(Boolean).join(' · ')
                + ` (after the last command, ${new Date(h.at).toLocaleTimeString()})`]);
        }
        const boots = bootHistory().filter((b) => b.distro === env.spec.distro);
        const avg = (xs) => xs.reduce((n, b) => n + b.seconds, 0) / xs.length;
        const cold = boots.filter((b) => b.how !== 'resumed');
        const warm = boots.filter((b) => b.how === 'resumed');
        if (boots.length) {
            rows.push(['Starts', [cold.length ? `cold boot ${avg(cold).toFixed(0)} s on average (${cold.length})` : null,
                warm.length ? `resume ${avg(warm).toFixed(1)} s (${warm.length})` : null].filter(Boolean).join(' · ')]);
        }
    }
    const vm = env.kind === 'vm';
    const save = async () => { try { await env.save(); } catch (e) { addMessage('problem', `Could not save the VM state: ${e.message}`); } };
    const pause = async () => { try { await env.pause(); } catch (e) { addMessage('problem', `Could not pause ${env.label}: ${e.message}`); } };
    const fresh = async () => {
        if (vm && !confirm(`Stop ${env.label} and forget its saved state? What runs in it now stops; the next tool call `
            + 'boots it from scratch. The workspace and chats stay.')) return;
        await env.discard().catch((e) => addMessage('problem', `Could not restart ${env.label}: ${e.message}`));
        // Every chat on it gets new shells.
        for (const id of env.users) { const s = S.sessions.get(id); if (s?.agent && !s.running) s.agent.tools = chatTools(s.chat); }
        addMessage('note', vm ? `${env.label} will boot afresh at the next tool call.` : 'The shells start again in /workspace.');
        if (vm) env.warm();
    };
    return (
        <div id="machinePane" className="page" role="tabpanel" aria-labelledby="tabMachine">
            <h2>This chat&apos;s environment</h2>
            <dl id="vmStats" className="kvs">{rows.map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}</dl>
            <div className="sysbar">
                {vm && <button id="saveState" onClick={save} disabled={env.status !== 'ready' || !env.fingerprint}
                    title="Save the running VM, so using it again (or reloading the page) resumes from here">Save state</button>}
                {vm && <button id="pauseEnv" onClick={pause} disabled={env.status !== 'ready' || env.busy}
                    title={env.busy ? 'An agent is working in it' : 'Save the VM\'s state and stop it, to free memory; the next tool call resumes it'}>Pause</button>}
                <button id="freshBoot" onClick={fresh} disabled={env.busy}
                    title={vm ? 'Stop the VM and forget its saved state: the next tool call boots it from scratch'
                        : 'Forget every shell\'s directory and variables in this project\'s bash.js'}>{vm ? 'Fresh boot' : 'Reset shells'}</button>
            </div>
            <h2>The project&apos;s environments</h2>
            <p className="hint">Chats of a project that pick the same environment share it, each in its own shell. A project runs
                one VM at a time, since they all work on its workspace: starting another pauses the one running once nobody
                works in it. A VM nobody uses for a while is paused by itself (Settings → Agent).</p>
            <div id="envList" className="envlist"><EnvList p={projectOf(S.chat)} mine={env} /></div>
        </div>
    );
}
