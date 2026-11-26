// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ToolsSection.jsx — Settings → Tools: which tools the model gets by default, and
 * the tools' own numbers. A mode can turn a tool on or off for itself (Settings →
 * Modes); a tool it doesn't name follows these.
 */

import { ALL_TOOL_NAMES } from '../../../js/tools.js';
import { S } from '../../app/state.js';
import { setSettings, settings, TOOL_HINTS, TOOL_OPTIONS } from '../../app/settings.js';
import { openSettings } from '../../app/dialogs.js';
import { NumberSetting } from './controls.jsx';

export default function ToolsSection() {
    const overriding = (name) => S.modes.filter((m) => m.tools[name]).map((m) => `${m.name}: ${m.tools[name]}`);
    return (
        <div id="setTools" className="dlg-pane page" role="tabpanel">
            <h2>Tools</h2>
            <p className="hint">What the model can use, in every mode that doesn&apos;t say otherwise
                (<button type="button" className="linkbtn" onClick={() => openSettings('modes')}>Modes</button>). A change applies from
                your next message, in the same conversation.</p>
            <div id="toolToggles">
                {ALL_TOOL_NAMES.map((name) => {
                    const modes = overriding(name);
                    return [
                        <label key={name}>
                            <input type="checkbox" checked={!settings.disabledTools.includes(name)} onChange={(e) => setSettings({
                                disabledTools: [...settings.disabledTools.filter((n) => n !== name), ...(e.target.checked ? [] : [name])],
                            })} />
                            <span className="tname">{name}</span>
                            <span className="tdesc">{TOOL_HINTS[name] || ''}{modes.length ? ` · modes: ${modes.join(', ')}` : ''}</span>
                        </label>,
                        TOOL_OPTIONS[name] && (
                            <div key={`${name}-o`} className="topts">
                                {TOOL_OPTIONS[name].map(([before, key, after]) => (
                                    <label key={key}>{`${before} `}<NumberSetting k={key} />{` ${after}`}</label>
                                ))}
                            </div>
                        ),
                    ];
                })}
            </div>
        </div>
    );
}
