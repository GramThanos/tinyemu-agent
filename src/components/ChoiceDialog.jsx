// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * ChoiceDialog.jsx — dialogs.choose(): a title, a text, and buttons that answer it
 * (Cancel and Escape answer null).
 */

import { UI } from '../app/state.js';
import Modal from './Modal.jsx';

export default function ChoiceDialog() {
    const c = UI.choice;
    return (
        <Modal open={!!c} className="choice" onClose={() => c?.resolve(null)}>
            {c && (
                <>
                    <h3>{c.title}</h3>
                    <p>{c.text}</p>
                    <div className="choices">
                        {c.options.map((o) => (
                            <button key={o.value} type="button" onClick={() => c.resolve(o.value)}>
                                {o.label}{o.hint && <small>{o.hint}</small>}
                            </button>
                        ))}
                        <button type="button" onClick={() => c.resolve(null)}>Cancel</button>
                    </div>
                </>
            )}
        </Modal>
    );
}
