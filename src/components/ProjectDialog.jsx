// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ProjectDialog.jsx — a project's settings, or a new project: its name, what new
 * chats start with (environment, VM memory and JIT, model), its files and
 * folders (linked folders, uploads, the Files panel), and its environment
 * variables. Keyed by the project, so its form starts afresh for each.
 */

import { useState } from 'react';
import { envKey } from '../../js/projects.js';
import { offeredModels } from '../../js/providerStore.js';
import { useTopics, emit } from '../app/store.js';
import { S, UI } from '../app/state.js';
import { distroInfo, machineChoices, MEMORY_SIZES } from '../app/machines.js';
import { projectOf, rt, WORKSPACE } from '../app/world.js';
import { checkEnvRows, deleteProject, openProjectChat, saveProject } from '../app/chatOps.js';
import { closeProject } from '../app/dialogs.js';
import { showPanel } from '../app/layout.js';
import Modal from './Modal.jsx';

let rowSeq = 0;

function Form({ p }) {
    useTopics('files');   // the linked folders
    const start = p ? p.env : projectOf(S.chat).env;
    const [name, setName] = useState(p ? p.name : '');
    const [env, setEnv] = useState(envKey(start));
    const memNow = start.kind === 'vm' ? start.memoryMB : 256;
    const [memory, setMemory] = useState(memNow);
    const [jit, setJit] = useState(start.kind !== 'vm' || start.jit);
    const offered = offeredModels(S.providers);
    const modelKey = (m) => `${m.provider}\n${m.model}`;
    const [model, setModel] = useState(p?.model && offered.some((m) => modelKey(m) === modelKey(p.model)) ? modelKey(p.model) : '');
    const [rows, setRows] = useState(() => (p ? p.envVars : []).map(([k, v]) => ({ id: ++rowSeq, k, v })));
    const check = checkEnvRows(rows.map((r) => [r.k, r.v]));

    const envs = [['bashjs', 'bash.js (in the page, no VM)'], ...machineChoices().map((d) => [`vm:${d.name}`, `${d.label || d.name} · ${d.arch}`])];
    if (start.kind === 'vm' && !envs.some(([k]) => k === `vm:${start.distro}`)) envs.push([`vm:${start.distro}`, start.distro]);
    const isVM = env !== 'bashjs';
    const setRow = (id, patch) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const save = () => {
        if (check.problems.length) return;
        const [provider, m] = model.split('\n');
        saveProject(p, {
            name, envVars: check.pairs, model: m ? { provider, model: m } : null,
            env: isVM ? { kind: 'vm', distro: env.slice(3), memoryMB: Number(memory), jit } : { kind: 'bashjs' },
        });
    };
    // The project's files: open one of its chats, then the Files panel.
    const toFiles = async (then) => {
        closeProject();
        await openProjectChat(p);
        showPanel('files');
        if (then) setTimeout(() => emit(then));
    };
    const links = p ? rt(p).links.links : [];
    return (
        <>
            <div className="dlg-head"><h2 id="projTitle">{p ? p.name : 'New project'}</h2><button className="ghost" aria-label="Close" onClick={closeProject}>×</button></div>
            <div className="dlg-pane page">
                <label className="field"><span>Name</span><input id="projName" maxLength={80} autoComplete="off" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
                <h2>New chats start with</h2>
                <p className="hint">Each chat can change these for itself, in its message box.</p>
                <label className="field"><span>Environment</span>
                    <select id="projEnv" value={env} onChange={(e) => setEnv(e.target.value)}>{envs.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </label>
                {isVM && (
                    <div className="row" id="projVMOpts">
                        <label>Memory <select value={memory} onChange={(e) => setMemory(Number(e.target.value))}>
                            {[...new Set([...MEMORY_SIZES, memNow])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{`${n} MB`}</option>)}
                        </select></label>
                        <label><input type="checkbox" checked={jit} disabled={distroInfo(env.slice(3)).arch !== 'x86'} onChange={(e) => setJit(e.target.checked)} /> x86 JIT
                            <span className="tdesc">compiles hot x86 code to WebAssembly</span></label>
                    </div>
                )}
                <label className="field"><span>Model</span>
                    <select id="projModel" value={model} onChange={(e) => setModel(e.target.value)}>
                        <option value="">the last one picked</option>
                        {offered.map((m) => <option key={modelKey(m)} value={modelKey(m)}>{`${m.label} · ${m.providerLabel}`}</option>)}
                    </select>
                </label>
                <h2>Files and folders</h2>
                <p className="hint">The project&apos;s workspace, at <code>/workspace</code> in every environment of its chats. Link a
                    folder from your computer (kept in sync) or upload files; the Files panel shows everything.</p>
                <div id="projLinks" className="linked">
                    {!p ? <div className="m">Save the project first, then add its files and folders.</div>
                        : !links.length ? <div className="m">No linked folders.</div>
                            : links.map((l) => (
                                <div key={l.path}>
                                    <span>{`${WORKSPACE}${l.path}`}</span>
                                    <span className="m">{`← ${l.name}, ${l.mode === 'read' ? 'read-only' : 'read-write'}${l.needsPermission ? ', needs permission again' : ''}`}</span>
                                </div>
                            ))}
                </div>
                <div className="row">
                    <button type="button" disabled={!p} onClick={() => toFiles('focus-files-link')}>Link folder</button>
                    <button type="button" disabled={!p} onClick={() => toFiles('focus-files-pick')}>Upload files</button>
                    <button type="button" disabled={!p} onClick={() => toFiles(null)}>Open in the Files panel</button>
                </div>
                <h2>Environment variables</h2>
                <p className="hint">Set in every shell the agents&apos; commands run in (sub-agents&apos; too), at the start of each command,
                    and in new login shells in a VM (<code>/etc/profile.d/tinyemu-agent.sh</code>).</p>
                <div id="envRows" className="envrows">
                    {rows.map((r, i) => (
                        <div key={r.id} className="envrow">
                            <input placeholder="NAME" value={r.k} spellCheck={false} aria-label="Variable name" className={check.bad.has(i) ? 'bad' : undefined}
                                onChange={(e) => setRow(r.id, { k: e.target.value })} />
                            <input placeholder="value" value={r.v} spellCheck={false} aria-label="Value" onChange={(e) => setRow(r.id, { v: e.target.value })} />
                            <button type="button" title="Remove this variable" onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>×</button>
                        </div>
                    ))}
                </div>
                <p className="hint" id="envNote">{check.problems.length ? `Can't save: ${check.problems.join('; ')}.` : ''}</p>
                <div className="row"><button id="envAdd" type="button" title="Add a variable" onClick={() => setRows([...rows, { id: ++rowSeq, k: '', v: '' }])}>Add variable</button></div>
            </div>
            <div className="dlg-foot">
                {p && S.projects.length > 1 && <button className="danger" type="button" onClick={() => deleteProject(p)}>Delete project</button>}
                <span className="spacer" />
                <button type="button" onClick={closeProject}>Cancel</button>
                <button className="primary" type="button" disabled={check.problems.length > 0} onClick={save}>Save</button>
            </div>
        </>
    );
}

export default function ProjectDialog() {
    const open = UI.project !== undefined;
    return (
        <Modal open={open} id="projectDlg" aria-label="Project" onClose={closeProject}>
            {open && <Form key={UI.project?.id ?? 'new'} p={UI.project} />}
        </Modal>
    );
}
