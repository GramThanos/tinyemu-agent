// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * SettingsDialog.jsx — Settings, a modal dialog with sections: Models (the
 * providers), Modes (system prompts and their tools), Tools (the defaults), Skills
 * (the library), Integrations (MCP servers), Agent (features, limits, keeping the
 * page running), Context (compaction), and Data.
 */

import { useTopics } from '../../app/store.js';
import { UI } from '../../app/state.js';
import { closeSettings, openSettings } from '../../app/dialogs.js';
import Modal from '../Modal.jsx';
import ModelsSection from './ModelsSection.jsx';
import ModesSection from './ModesSection.jsx';
import ToolsSection from './ToolsSection.jsx';
import SkillsSection from './SkillsSection.jsx';
import IntegrationsSection from './IntegrationsSection.jsx';
import AgentSection from './AgentSection.jsx';
import ContextSection from './ContextSection.jsx';
import DataSection from './DataSection.jsx';

const SECTIONS = [
    ['models', 'Models', ModelsSection], ['modes', 'Modes', ModesSection], ['tools', 'Tools', ToolsSection],
    ['skills', 'Skills', SkillsSection], ['integrations', 'Integrations', IntegrationsSection],
    ['agent', 'Agent', AgentSection], ['context', 'Context', ContextSection], ['data', 'Data', DataSection],
];
const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

export default function SettingsDialog() {
    useTopics('settings');
    // A section that went away (the old "prompt") opens Modes.
    const tab = UI.settings === 'prompt' ? 'modes' : UI.settings;
    const Section = SECTIONS.find(([k]) => k === tab)?.[2];
    return (
        <Modal open={!!tab} className="big" aria-label="Settings" id="settingsDlg" onClose={closeSettings}>
            <div className="dlg-head"><h2>Settings</h2><button className="ghost" aria-label="Close" onClick={closeSettings}>×</button></div>
            <div className="dlg-body">
                <div className="dlg-nav" role="tablist" aria-label="Settings sections">
                    {SECTIONS.map(([k, label]) => (
                        <button key={k} role="tab" aria-selected={k === tab} onClick={() => openSettings(k)}
                            // Dragging skill folders over Skills opens it, so they can be dropped there.
                            onDragEnter={k === 'skills' ? (e) => { if (carriesFiles(e)) openSettings('skills'); } : undefined}>{label}</button>
                    ))}
                </div>
                {Section && <Section />}
            </div>
        </Modal>
    );
}
