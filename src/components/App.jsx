// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * App.jsx — the page: the sidebar of projects and chats, the open chat, and the
 * panel for its environment; plus the dialogs and menus, which are the page's own
 * (no library).
 */

import { useEffect, useRef } from 'react';
import { useUI } from '../app/store.js';
import { S, UI } from '../app/state.js';
import { layout, panelShown, sideHidden, view } from '../app/layout.js';
import { closeMenu, toggleChatInfo, toggleContextPanel } from '../app/dialogs.js';
import Sidebar from './Sidebar.jsx';
import ChatColumn from './ChatColumn.jsx';
import Panel from './Panel.jsx';
import Resizer from './Resizer.jsx';
import Menu from './Menu.jsx';
import ChoiceDialog from './ChoiceDialog.jsx';
import SettingsDialog from './settings/SettingsDialog.jsx';
import ProjectDialog from './ProjectDialog.jsx';

export default function App() {
    useUI();
    const side = useRef(null);
    const panel = useRef(null);

    // Escape and a click elsewhere close a menu and the header's floating panels.
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            if (UI.menu) { e.preventDefault(); closeMenu(); } else if (UI.contextPanel) toggleContextPanel(false);
            else if (UI.chatInfo) toggleChatInfo(false);
        };
        const onClick = (e) => {
            const t = e.target;
            if (UI.menu && !t.closest?.('.menu, [aria-haspopup=menu]')) closeMenu();
            if (UI.contextPanel && !t.closest?.('#contextPanel, #contextMeter')) toggleContextPanel(false);
            if (UI.chatInfo && !t.closest?.('#chatInfo, #chatInfoBtn')) toggleChatInfo(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('click', onClick, true);
        return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick, true); };
    }, []);

    if (!S.loaded || !S.chat) return null;
    const style = {};
    if (Number.isFinite(layout.sideW)) style['--side-w'] = `${layout.sideW}px`;
    if (Number.isFinite(layout.panelW)) style['--panel-w'] = `${layout.panelW}px`;
    const widths = () => ({
        sideWidth: sideHidden() ? 0 : side.current?.getBoundingClientRect().width || 0,
        panelWidth: panelShown() ? panel.current?.getBoundingClientRect().width || 0 : 0,
    });
    return (
        <>
            <div id="app" className={[sideHidden() && 'no-side', view.sideOpen && 'side-open'].filter(Boolean).join(' ')} style={style}>
                <Sidebar ref={side}>
                    <Resizer id="sbResize" sizeKey="sideW" box={side} sign={1} widths={widths} label="Resize the sidebar" />
                </Sidebar>
                <ChatColumn />
                <Panel ref={panel}>
                    <Resizer id="panelResize" sizeKey="panelW" box={panel} sign={-1} widths={widths} label="Resize the panel" />
                </Panel>
            </div>
            <Menu />
            <SettingsDialog />
            <ProjectDialog />
            <ChoiceDialog />
        </>
    );
}
