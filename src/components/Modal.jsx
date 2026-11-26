// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Modal.jsx — a <dialog> shown with showModal() while `open`, so it is modal and
 * Escape closes it (onClose). The page's dialogs are this; no library.
 */

import { useEffect, useRef } from 'react';

export default function Modal({ open, onClose, children, ...props }) {
    const el = useRef(null);
    useEffect(() => {
        const d = el.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        else if (!open && d.open) d.close();
    }, [open]);
    return (
        <dialog ref={el} {...props}
            onCancel={(e) => { e.preventDefault(); onClose?.(); }}
            onClose={() => { if (open) onClose?.(); }}>
            {open && children}
        </dialog>
    );
}
