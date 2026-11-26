// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Resizer.jsx — a handle that sets the sidebar's or the panel's width
 * (layout.sideW, layout.panelW, applied as --side-w / --panel-w on #app). None
 * means the stylesheet's default. The chat keeps at least CENTER_MIN. Dragging,
 * the arrow keys (Shift: further), and double-click or Home for the default.
 */

import { useEffect, useRef } from 'react';
import { emit } from '../app/store.js';
import { clampSize, layout, narrow, saveLayout } from '../app/layout.js';

export default function Resizer({ id, sizeKey, box, sign, widths, label }) {
    const handle = useRef(null);
    const set = (w) => { layout[sizeKey] = clampSize(sizeKey, w, widths()); emit('ui'); };
    const reset = () => { delete layout[sizeKey]; saveLayout(); emit('ui'); };

    // A smaller window can leave saved widths too wide for the chat: fit them again.
    useEffect(() => {
        const onResize = () => {
            if (narrow() || !Number.isFinite(layout[sizeKey])) return;
            layout[sizeKey] = clampSize(sizeKey, layout[sizeKey], widths());
            emit('ui');
        };
        addEventListener('resize', onResize);
        return () => removeEventListener('resize', onResize);
    }, [sizeKey, widths]);

    const onPointerDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = handle.current;
        const app = document.getElementById('app');
        const x0 = e.clientX;
        const w0 = box.current.getBoundingClientRect().width;
        try { el.setPointerCapture(e.pointerId); } catch { /* a pointer the browser doesn't track */ }
        el.classList.add('dragging');
        app.classList.add('resizing');
        const move = (ev) => set(w0 + sign * (ev.clientX - x0));
        const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            el.classList.remove('dragging');
            app.classList.remove('resizing');
            saveLayout();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
    };
    const onKeyDown = (e) => {
        const step = e.shiftKey ? 64 : 16;
        const w = box.current.getBoundingClientRect().width;
        if (e.key === 'ArrowLeft') set(w - sign * step);
        else if (e.key === 'ArrowRight') set(w + sign * step);
        else if (e.key === 'Home') { reset(); }
        else return;
        e.preventDefault();
        saveLayout();
    };
    return (
        <div id={id} ref={handle} className="resizer" role="separator" aria-orientation="vertical" aria-label={label}
            aria-valuenow={Number.isFinite(layout[sizeKey]) ? layout[sizeKey] : undefined} tabIndex={0}
            title="Drag to resize; double-click for the default width"
            onPointerDown={onPointerDown} onDoubleClick={reset} onKeyDown={onKeyDown} />
    );
}
