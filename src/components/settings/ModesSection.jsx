// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ModesSection.jsx — Settings → Modes: the agent's modes (js/modes.js). Each has a
 * name, a description, a system prompt with variables, whether the mode menu next
 * to the message box offers it, and which tools it turns on or off whatever
 * Settings → Tools says. Build, Plan and Sub-agent are built in (edit them, or
 * reset them); New mode adds one of your own, from the build mode's prompt.
 */

import { useRef, useState } from 'react';
import { ALL_TOOL_NAMES, ASK_TOOL, DELEGATE_TOOL } from '../../../js/tools.js';
import { isDefault } from '../../../js/modes.js';
import { useTopics } from '../../app/store.js';
import { S } from '../../app/state.js';
import { PROMPT_VAR_HELP, settings, TOOL_HINTS } from '../../app/settings.js';
import { addMode, modeById, putMode, removeMode, resetMode } from '../../app/modes.js';
import { promptVars } from '../../app/world.js';
import { renderPrompt } from '../../../js/Agent.js';

function ModeForm({ mode, onDone }) {
    const [m, setM] = useState(() => structuredClone(mode));
    const box = useRef(null);
    const set = (patch) => setM((x) => ({ ...x, ...patch }));
    const unsaved = JSON.stringify(m) !== JSON.stringify(mode);
    const vars = { ...promptVars(), MODE: m.name };
    const insert = (token) => {
        const ta = box.current;
        ta.focus();
        ta.setRangeText(token, ta.selectionStart, ta.selectionEnd, 'end');
        set({ prompt: ta.value });
    };
    const setTool = (name, v) => {
        const tools = { ...m.tools };
        if (v === 'default') delete tools[name]; else tools[name] = v;
        set({ tools });
    };
    const save = () => { if (m.prompt.trim() && m.name.trim()) putMode(m); };
    const remove = () => { if (confirm(`Delete the mode ${mode.name}? Chats in it go back to Build.`)) { removeMode(mode); onDone(); } };
    const reset = () => { if (confirm(`Put ${mode.name} back as it ships? Your changes to it are lost.`)) { resetMode(mode); setM(structuredClone(modeById(mode.id))); } };
    const globallyOn = (name) => !settings.disabledTools.includes(name);
    const never = (name) => mode.sub && (name === DELEGATE_TOOL || name === ASK_TOOL);
    return (
        <div className="modeform">
            <label className="field"><span>Name</span><input value={m.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="field"><span>Description <span className="hint">(shown in the mode menu)</span></span>
                <input value={m.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} /></label>
            {m.sub
                ? <p className="hint">Sub-agents work in this mode: the agent gives them their task with its Delegate tool. It is never offered in the mode menu.</p>
                : <label><input type="checkbox" checked={!m.hidden} onChange={(e) => set({ hidden: !e.target.checked })} /> Offer it in the mode menu next to the message box</label>}
            <h2>System prompt</h2>
            <p className="hint">What the model is told before the conversation, in this mode. Variables are filled in for each chat at
                every message; click one to insert it at the cursor.</p>
            <textarea id="optSystem" ref={box} spellCheck={false} aria-label="System prompt" value={m.prompt}
                onChange={(e) => set({ prompt: e.target.value })} />
            <dl id="systemVars">
                {Object.entries(PROMPT_VAR_HELP).map(([name, help]) => {
                    const token = `{{VAR_${name}}}`;
                    return [
                        <dt key={`${name}-t`}><button type="button" title="Insert at the cursor" onClick={() => insert(token)}>{token}</button></dt>,
                        <dd key={`${name}-d`}>{`${help}; now `}<code>{vars[name] || ''}</code></dd>,
                    ];
                })}
            </dl>
            <details className="preview">
                <summary>The prompt as the open chat would get it</summary>
                <pre>{renderPrompt(m.prompt, vars)}</pre>
            </details>
            <h2>Tools</h2>
            <p className="hint">Turn a tool on or off in this mode only; &quot;as in Tools&quot; follows Settings → Tools.</p>
            <div className="modetools">
                {ALL_TOOL_NAMES.map((name) => (
                    <label key={name} title={TOOL_HINTS[name] || ''}>
                        <span className="tname">{name}</span>
                        {never(name)
                            ? <span className="tdesc">never for sub-agents</span>
                            : (
                                <select value={m.tools[name] || 'default'} onChange={(e) => setTool(name, e.target.value)}>
                                    <option value="default">{`as in Tools (${globallyOn(name) ? 'on' : 'off'})`}</option>
                                    <option value="on">on</option>
                                    <option value="off">off</option>
                                </select>
                            )}
                    </label>
                ))}
            </div>
            <div className="sysbar">
                <button className="primary" disabled={!unsaved || !m.prompt.trim() || !m.name.trim()} onClick={save}>Save</button>
                <button disabled={!unsaved} onClick={() => setM(structuredClone(mode))}>Revert</button>
                {mode.builtin && <button disabled={isDefault(mode)} onClick={reset} title="Go back to the built-in name, prompt and tools">Reset to default</button>}
                {!mode.builtin && <button className="danger" onClick={remove}>Delete mode</button>}
                {unsaved && <span className="hint">unsaved changes</span>}
            </div>
        </div>
    );
}

export default function ModesSection() {
    useTopics('modes');
    const [id, setId] = useState(S.modes[0]?.id);
    const mode = S.modes.find((m) => m.id === id) || S.modes[0];
    return (
        <div id="setModes" className="dlg-pane page" role="tabpanel">
            <h2>Modes</h2>
            <p className="hint">A mode is how the agent works in a chat: its instructions and its tools. Each chat picks one next to its
                message box; sub-agents work in the Sub-agent mode. A change applies from the next message.</p>
            <div className="modelist" role="tablist" aria-label="Modes">
                {S.modes.map((m) => (
                    <button key={m.id} role="tab" aria-selected={m === mode} onClick={() => setId(m.id)}
                        title={m.description}>{m.name}{m.hidden || m.sub ? ' (hidden)' : ''}</button>
                ))}
                <button type="button" onClick={() => setId(addMode('New mode').id)}>+ New mode</button>
            </div>
            {mode && <ModeForm key={`${mode.id}`} mode={mode} onDone={() => setId(S.modes[0]?.id)} />}
        </div>
    );
}
