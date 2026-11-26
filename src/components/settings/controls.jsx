// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * controls.jsx — the inputs Settings' sections share: a number setting (kept to
 * its LIMITS, saved when left) and a checkbox setting.
 */

import { useEffect, useState } from 'react';
import { LIMITS, setNumberSetting, setSettings, settings } from '../../app/settings.js';

/* A number setting's input: shows the value, keeps it in its limits, saves it on change. */
export function NumberSetting({ k, size, step = 1 }) {
    const [, min, max] = LIMITS[k];
    const [text, setText] = useState(String(settings[k]));
    useEffect(() => setText(String(settings[k])), [k]);
    return (
        <input type="number" min={min} max={max} step={step} size={size} value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { setNumberSetting(k, text); setText(String(settings[k])); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    );
}

export const Check = ({ k, onChange }) => (
    <input type="checkbox" checked={settings[k]} onChange={(e) => { setSettings({ [k]: e.target.checked }); onChange?.(); }} />
);
