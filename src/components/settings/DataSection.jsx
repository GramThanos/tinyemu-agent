// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * DataSection.jsx — Settings → Data: what this page keeps in this browser
 * (src/app/data.js), counted when shown, and buttons that delete parts of it.
 * Each asks first, and none runs while an agent works.
 */

import { useCallback, useEffect, useState } from 'react';
import { DATA_ACTIONS, dataBusy, dataStats } from '../../app/data.js';

const BUTTONS = [
    ['workspace', null, 'Delete everything in the open chat\'s project\'s /workspace, and unlink its linked folders'],
    ['skills', 'Delete skills', 'Delete every imported skill'],
    ['states', 'Delete saved states', 'Delete the saved state of every machine of every project'],
    ['settings', 'Reset settings', 'Put the settings back to their defaults, and reload'],
    ['chats', 'Delete chats', 'Delete every chat, and start a new one'],
    ['everything', 'Delete everything', 'Delete all of the above, every project and the providers with their keys, and reload'],
];

export default function DataSection() {
    const [stats, setStats] = useState(null);
    const [busy, setBusy] = useState(null);   // the action running
    const refresh = useCallback(() => { dataStats().then(setStats); }, []);
    useEffect(refresh, [refresh]);
    const run = async (key) => {
        const a = DATA_ACTIONS[key];
        if (dataBusy() || !confirm(a.ask())) return;
        setBusy(key);
        try {
            await a.run();
        } catch (e) {
            alert(`${a.busy.replace('…', '')} failed: ${e.message}`);
        } finally {
            setBusy(null);
            refresh();
        }
    };
    const disabled = { skills: stats && !stats.hasSkills, states: stats && !stats.hasStates };
    return (
        <div id="setData" className="dlg-pane page" role="tabpanel">
            <h2>Data <button id="dataRefresh" title="Count again" onClick={refresh}>Refresh</button></h2>
            <p className="hint">What this page keeps in this browser. Each button asks first; none of them touches the folders
                on your computer that are linked into a workspace (they are only unlinked).</p>
            <dl id="dataStats" className="kvs">{stats?.rows.map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}</dl>
            <div className="sysbar">
                {BUTTONS.map(([key, label, title]) => (
                    <button key={key} title={title} className={key === 'everything' ? 'danger' : undefined}
                        disabled={!!busy || !!disabled[key]} onClick={() => run(key)}>
                        {busy === key ? DATA_ACTIONS[key].busy : label || `Empty ${stats?.project || 'this project'}'s workspace`}
                    </button>
                ))}
            </div>
        </div>
    );
}
