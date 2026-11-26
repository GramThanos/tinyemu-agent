// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Panel.jsx — the side panel: the open chat's environment, in tabs (Files,
 * Console, Environment, Log). The tab shown is remembered with the layout. It
 * stays mounted while hidden, so the console keeps its terminal.
 */

import { S } from '../app/state.js';
import { changeLayout, hidePanel, layout, panelShown, TABS } from '../app/layout.js';
import { envOf } from '../app/world.js';
import FilesPane from './panel/FilesPane.jsx';
import ConsolePane from './panel/ConsolePane.jsx';
import MachinePane from './panel/MachinePane.jsx';
import LogPane from './panel/LogPane.jsx';

const LABELS = { files: 'Files', console: 'Console', machine: 'Environment', log: 'Log' };
const IDS = { files: ['tabFiles', 'filesPane'], console: ['tabConsole', 'consolePane'], machine: ['tabMachine', 'machinePane'], log: ['tabLog', 'logPane'] };
const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

export default function Panel({ ref, children }) {
    const shown = panelShown();
    const env = envOf(S.chat);
    const tab = layout.tab;
    return (
        <aside id="panel" aria-label="The chat's environment" hidden={!shown} ref={ref}>
            {children}
            <div id="panelBar">
                <div role="tablist" aria-label="Environment view">
                    {TABS.map((t) => (
                        <button key={t} role="tab" id={IDS[t][0]} aria-selected={t === tab} aria-controls={IDS[t][1]}
                            onClick={() => changeLayout({ tab: t })}
                            // Dragging files over the Files tab opens it, so they can be dropped there.
                            onDragEnter={t === 'files' ? (e) => { if (carriesFiles(e)) changeLayout({ tab: 'files' }); } : undefined}>{LABELS[t]}</button>
                    ))}
                </div>
                <span id="panelEnv">{`${env.project.name} · ${env.label}`}</span>
                <button id="panelClose" className="ghost" title="Hide the panel" aria-label="Hide the panel" onClick={hidePanel}>×</button>
            </div>
            <FilesPane active={shown && tab === 'files'} />
            <ConsolePane active={shown && tab === 'console'} />
            {shown && tab === 'machine' && <MachinePane />}
            {shown && tab === 'log' && <LogPane />}
        </aside>
    );
}
