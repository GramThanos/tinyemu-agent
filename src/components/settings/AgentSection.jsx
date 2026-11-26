// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * AgentSection.jsx — Settings → Agent: features, the loop's limits, and keeping
 * the page running while an agent works. Number settings keep to their LIMITS.
 */

import { KEEP_TEXT, keepAwake } from '../../app/settings.js';
import { Check, NumberSetting } from './controls.jsx';

export default function AgentSection() {
    const st = keepAwake.state();
    const keepParts = [KEEP_TEXT.wakeLock[st.wakeLock], KEEP_TEXT.audio[st.audio]].filter(Boolean);
    return (
        <div id="setAgent" className="dlg-pane page" role="tabpanel">
            <h2>Features</h2>
            <div className="toggles">
                <label><Check k="mentions" /> Replace <code>@skill</code> mentions in my messages with the skill&apos;s instructions</label>
                <label><Check k="thinking" /> Show the model&apos;s thinking in the chat</label>
                <label><Check k="pageFiles" /> In a VM, serve Read, Edit and Write of <code>/workspace</code> and
                    <code>/agent/skills</code> from the page, which is faster
                    <span className="hint">(off: those calls go through the VM, as for other paths)</span></label>
            </div>
            <h2>Agent</h2>
            <div className="toggles">
                <label>At most <NumberSetting k="maxSteps" size={6} /> steps per message
                    <span className="hint">(a step is one reply from the model; each reply can call several tools)</span></label>
                <label>Ask again <NumberSetting k="emptyRetries" size={3} /> times when the model
                    returns an empty response, before stopping</label>
                <label>Try <NumberSetting k="networkRetries" size={5} /> times in a row to reach the model when the
                    connection fails, before stopping <span className="hint">(0: keep trying until it is back or you stop it)</span></label>
                <label>Give the model at most <NumberSetting k="toolOutputMax" size={8} step={1000} /> characters of one
                    tool result <span className="hint">(and never more than a quarter of the context window)</span></label>
                <label>Pause a VM nobody works in after <NumberSetting k="idlePauseMin" size={4} /> minutes
                    <span className="hint">(0: never. Its state is saved; the next tool call resumes it)</span></label>
            </div>
            <h2>Keep running</h2>
            <p className="hint">A browser stops a page it thinks nobody is using: the computer goes to sleep, or a background
                tab gets frozen. The VMs stop with it, and the agent&apos;s work waits until you come back. These apply only
                while an agent works.</p>
            <div className="toggles">
                <label><Check k="wakeLock" onChange={() => keepAwake.refresh()} /> Keep the screen on while the agent works
                    <span className="hint">(Screen Wake Lock; only while this tab is visible)</span></label>
                <label><Check k="keepAudio" onChange={() => keepAwake.refresh()} /> Play a very quiet tone every 15 s while the agent works, so
                    the browser keeps this tab running in the background <span className="hint">(Chrome and Edge don&apos;t freeze a tab
                    that plays sound. It starts at your next click if the browser didn&apos;t allow sound yet)</span></label>
                <span className="hint" id="keepState">{st.active && keepParts.length ? `Now: ${keepParts.join('; ')}.` : ''}</span>
            </div>
            <details id="keepTips">
                <summary>Browser settings that help</summary>
                <ul>
                    <li><b>Chrome:</b> Settings → Performance (<code>chrome://settings/performance</code>). Under Memory Saver,
                        &quot;Always keep these sites active&quot; → Add <code>{location.origin}</code>. Energy Saver freezes busy
                        background tabs: turn it off, or keep the computer plugged in.</li>
                    <li><b>Edge:</b> Settings → System and performance. Under sleeping tabs, &quot;Never put these sites to sleep&quot; →
                        Add <code>{location.origin}</code>.</li>
                    <li><b>Firefox:</b> <code>about:config</code> → <code>browser.tabs.unloadOnLowMemory</code> = false.</li>
                    <li><b>Any browser:</b> a minimized window counts as a hidden tab. Give the agent its own window and keep
                        part of it in view.</li>
                </ul>
            </details>
        </div>
    );
}
