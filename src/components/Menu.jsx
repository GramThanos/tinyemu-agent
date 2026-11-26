// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Menu.jsx — the open menu (UI.menu, dialogs.openMenu): above its anchor if there
 * is room, else below it, kept inside the window. Items are text only.
 */

import { useLayoutEffect, useRef } from 'react';
import { UI } from '../app/state.js';
import { closeMenu } from '../app/dialogs.js';

export default function Menu() {
    const el = useRef(null);
    const menu = UI.menu;
    useLayoutEffect(() => {
        const m = el.current;
        if (!m || !menu) return;
        const r = menu.rect;
        const h = m.offsetHeight;
        const w = m.offsetWidth;
        m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
        m.style.top = `${r.top - h - 6 > 8 ? r.top - h - 6 : Math.min(r.bottom + 6, innerHeight - h - 8)}px`;
        m.querySelector('button:not(:disabled)')?.focus();
    }, [menu]);
    if (!menu) return null;
    return (
        <div className="menu" role="menu" ref={el}>
            {menu.items.map((it, i) => {
                if (it.group) return <div key={i} className="mgroup">{it.group}</div>;
                if (it.sep) return <hr key={i} />;
                return (
                    <button key={i} type="button" role="menuitemradio" aria-checked={!!it.checked} disabled={!!it.disabled}
                        onClick={() => { closeMenu(); it.onclick?.(); }}>
                        <span className="ck">{it.checked ? '✓' : ''}</span>
                        <span className="mt">{it.label}{it.hint && <small>{it.hint}</small>}</span>
                    </button>
                );
            })}
        </div>
    );
}
