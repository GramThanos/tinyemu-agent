// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * settings.js — the page's settings (Settings → Agent, System prompt), kept in
 * localStorage, and what is derived from them: the system prompt a chat gets, the
 * thinking level per kind of provider, the context window, keeping the page awake.
 * Without storage the defaults apply and a change lasts until the page reloads.
 */

'use strict';

import { EMPTY_RETRIES, MAX_STEPS, NETWORK_RETRIES, SUBAGENT_MAX_STEPS } from '../../js/Agent.js';
import { BASH_DEFAULT_MS, BASH_MAX_MS } from '../../js/tools.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../js/compaction.js';
import { EFFORT_DEFAULT, EFFORTS } from '../../js/providerStore.js';
import { createKeepAwake } from '../../js/keepAwake.js';
import { emit } from './store.js';
import { readJSON, writeJSON } from './state.js';

export const SETTINGS = 'tinyemu-agent-settings';
export const COMPACT_LEVELS = [50, 60, 70, 80, 90, 95];   // % of the window that triggers a compaction
/* Number settings: [default, min, max]. */
export const LIMITS = {
    maxSteps: [MAX_STEPS, 1, 10000],             // model replies per message
    emptyRetries: [EMPTY_RETRIES, 0, 10],        // asking again after an empty reply
    networkRetries: [NETWORK_RETRIES, 0, 1000],  // asking again while the model can't be reached; 0: no limit
    bashTimeoutMin: [BASH_DEFAULT_MS / 60000, 1, BASH_MAX_MS / 60000],   // Bash's default timeout
    bashKeepLines: [2000, 0, 1000000],           // the last lines of a command's output the model gets; 0: all
    subMaxSteps: [SUBAGENT_MAX_STEPS, 1, 10000], // a sub-agent's replies
    subMaxConcurrent: [4, 0, 32],                // sub-agents at once; 0: no limit
    toolOutputMax: [30000, 1000, 2000000],       // characters of one tool result the model gets
    idlePauseMin: [10, 0, 1440],                 // a VM nobody works in is paused after this; 0: never
};
export const SETTINGS_DEFAULT = {
    disabledTools: [], disabledSkills: [], mentions: true, thinking: true, effort: {},
    pageFiles: true,      // in a VM, Read/Edit/Write of the JS volumes served from the page
    wakeLock: true,       // a Screen Wake Lock while a turn runs
    keepAudio: false,     // a quiet tone while a turn runs, so the tab isn't frozen (js/keepAwake.js)
    subAutoDelete: false, // a sub-agent's chat is deleted once it finished its task (chatOps.removeFinishedSub)
    compactAuto: true, compactAt: 80, contextWindow: null,
    systemPrompt: null,   // before modes: the edited prompt, moved into the build mode once (src/app/modes.js)
    ...Object.fromEntries(Object.entries(LIMITS).map(([k, [d]]) => [k, d])),
};
const inLimits = (key, n) => Number.isInteger(n) && n >= LIMITS[key][1] && n <= LIMITS[key][2];

export const settings = (() => {
    const saved = readJSON(SETTINGS);
    const s = { ...SETTINGS_DEFAULT, ...(saved && typeof saved === 'object' ? saved : {}) };
    if (!Array.isArray(s.disabledTools)) s.disabledTools = [];
    if (!Array.isArray(s.disabledSkills)) s.disabledSkills = [];
    if (!s.effort || typeof s.effort !== 'object') s.effort = {};
    if (!COMPACT_LEVELS.includes(s.compactAt)) s.compactAt = SETTINGS_DEFAULT.compactAt;
    if (!(Number.isInteger(s.contextWindow) && s.contextWindow >= 1000)) s.contextWindow = null;
    if (typeof s.systemPrompt !== 'string' || !s.systemPrompt.trim()) s.systemPrompt = null;
    if (typeof s.pageFiles !== 'boolean') s.pageFiles = true;
    delete s.bashJs;   // before environments: Bash in bash.js inside the VM's tools
    if (typeof s.wakeLock !== 'boolean') s.wakeLock = SETTINGS_DEFAULT.wakeLock;
    if (typeof s.keepAudio !== 'boolean') s.keepAudio = SETTINGS_DEFAULT.keepAudio;
    if (typeof s.subAutoDelete !== 'boolean') s.subAutoDelete = SETTINGS_DEFAULT.subAutoDelete;
    for (const key of Object.keys(LIMITS)) if (!inLimits(key, s[key])) s[key] = SETTINGS_DEFAULT[key];
    return s;
})();

/** Change settings, save them, and redraw what shows them. */
export function setSettings(patch) {
    Object.assign(settings, patch);
    writeJSON(SETTINGS, settings);
    emit('settings', 'ui');
}

/* A number setting's value from an input: kept in its limits, the default if not a number. */
export function setNumberSetting(key, text) {
    const [, min, max] = LIMITS[key];
    const n = parseInt(text, 10);
    setSettings({ [key]: Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : SETTINGS_DEFAULT[key] });
}

/* What each variable is, for the list under a mode's prompt (Settings → Modes).
 * Every name promptVars() (world.js) returns needs a line here. */
export const PROMPT_VAR_HELP = {
    MODE: 'the mode\'s name (Build, Plan, Sub-agent, or one of yours)',
    ARCH: 'the processor of the chat\'s environment (its TinyEMU machine)',
    OS_NAME: 'the chat\'s system (distribution and version, or bash.js)',
    MODEL_NAME: 'the chat\'s model\'s name, as its provider lists it (Claude Opus 5.5)',
    MODEL_ID: 'the chat\'s model\'s id (claude-opus-5-5)',
};

/* Each wire format has its own thinking scale (js/providerStore.js); in-browser
 * models have none. The choice is remembered per kind of provider. */
export const effortFor = (kind) => {
    const saved = settings.effort[kind];
    return EFFORTS[kind]?.includes(saved) ? saved : EFFORT_DEFAULT[kind] ?? '';
};

/* The window: the Settings value, else what the model's listing reported, else a
 * guess. The source is shown, so a guess can be corrected. */
export function windowOf(p) {
    // The model's own setting (Settings → Models) is more specific than the one for all.
    if (p?.tuning?.windowSet && p.contextWindow) return { tokens: p.contextWindow, source: 'set for this model in Settings → Models' };
    if (settings.contextWindow) return { tokens: settings.contextWindow, source: 'set in Settings' };
    if (p?.contextWindow) return { tokens: p.contextWindow, source: 'reported by the model' };
    return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'assumed: the model didn\'t say; set it below' };
}
/* What every Agent (sub-agents included) reads at each check. */
export const contextOptions = {
    auto: () => settings.compactAuto,
    threshold: () => settings.compactAt / 100,
    limit: (p) => windowOf(p).tokens,
};

export const TOOL_HINTS = {
    Read: 'read files in the VM',
    Edit: 'change part of a file',
    Write: 'create or overwrite files',
    Glob: 'find files by name',
    Grep: 'search file contents',
    Bash: 'run shell commands',
    skill: 'load one of your skills (offered while any is on in the Skills tab)',
    Delegate: 'hand a task to a sub-agent (each shows in a read-only tab)',
    ask_user: 'ask you questions, with suggested answers (main agent only)',
};
/* A tool's own number settings, shown under its toggle: [text before, key, text after]. */
export const TOOL_OPTIONS = {
    Bash: [
        ['default timeout', 'bashTimeoutMin', 'minutes (the model can ask for another, up to 120)'],
        ['keep the last', 'bashKeepLines', 'lines of a command’s output (0: all, up to the 2 MB a command may write)'],
    ],
    Delegate: [
        ['at most', 'subMaxConcurrent', 'sub-agents at once (0: no limit; more wait their turn)'],
        ['at most', 'subMaxSteps', 'steps each'],
    ],
};

/* ---- keeping the page running while the agent works ------------------------ */

export const KEEP_TEXT = {
    wakeLock: { held: 'the screen is kept on', unsupported: 'this browser has no Screen Wake Lock',
        denied: 'the browser refused the wake lock', hidden: 'the wake lock waits for this tab to be visible' },
    audio: { playing: 'the quiet tone is playing', waiting: 'the tone starts at your next click or key press',
        unsupported: 'this browser has no Web Audio' },
};
export const keepAwake = createKeepAwake({
    wakeLock: () => settings.wakeLock,
    audio: () => settings.keepAudio,
    onChange() { emit('settings'); },
});
