// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * SkillsSection.jsx — Settings → Skills: the library (js/skills.js), one for every
 * project. Import a skill folder (or drop folders here), turn a skill on or off
 * for the agent, open one to see its files, delete one. What an import or a
 * deletion did shows under the bar (skillsNote): the chat is behind the dialog.
 * Skill names, descriptions and files come from imported files: text only.
 */

import { useEffect, useRef, useState } from 'react';
import { SKILL_FILE, SKILLS_DIR } from '../../../js/skills.js';
import { useTopics } from '../../app/store.js';
import { asText, formatSize, UI } from '../../app/state.js';
import { setSettings, settings } from '../../app/settings.js';
import { skills } from '../../app/world.js';
import { readEntry } from '../../app/files.js';
import { skillsNote } from '../../app/dialogs.js';

const SKILL_PREVIEW_MAX = 2 * 1024 * 1024;
const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

async function importSkills(items) {
    skillsNote([], 'Importing…');
    const { imported, problems } = await skills.import(items);
    skillsNote(problems, imported.length
        ? `Imported ${imported.length === 1 ? 'the skill' : 'the skills'} ${imported.map((id) => `@${id}`).join(', ')} into ${SKILLS_DIR}.`
        : '');
}

/* One skill's view: its files on the left, the chosen one's text on the right. */
function SkillView({ id, onBack }) {
    const [list, setList] = useState([]);
    const [path, setPath] = useState(null);
    const [body, setBody] = useState('');
    useEffect(() => {
        let gone = false;
        skills.files(id).then((l) => {
            if (gone) return;
            setList(l);
            setPath(l.some((f) => f.path === SKILL_FILE) ? SKILL_FILE : l[0]?.path ?? null);
        }, (e) => { skillsNote([`Could not open ${id}: ${e.message}`]); onBack(); });
        return () => { gone = true; };
    }, [id, onBack]);
    // A slow read must not overwrite a newer choice: the effect's cleanup drops it.
    useEffect(() => {
        if (!path) { setBody(list.length ? '' : 'This skill has no files.'); return undefined; }
        let gone = false;
        skills.readFile(id, path).catch(() => null).then((bytes) => {
            if (gone) return;
            if (!bytes) { setBody(`Could not read ${SKILLS_DIR}/${id}/${path}.`); return; }
            const text = bytes.length <= SKILL_PREVIEW_MAX ? asText(bytes) : null;
            setBody(text ?? (bytes.length > SKILL_PREVIEW_MAX ? 'This file is too large to show here.' : 'This is a binary file, so it is not shown here.'));
        });
        return () => { gone = true; };
    }, [id, path, list]);
    return (
        <div id="skillView">
            <div id="skillViewBar">
                <button id="skillBack" title="Back to the list of skills" onClick={onBack}>← Skills</button>
                <span id="skillViewName">{`${SKILLS_DIR}/${id}`}</span>
            </div>
            <div id="skillViewBody">
                <nav id="skillFiles" aria-label="The skill's files">
                    {list.map((f) => {
                        const parts = f.path.split('/');
                        return (
                            <div key={f.path} className="sfile" tabIndex={0} role="button" aria-current={f.path === path}
                                onClick={() => setPath(f.path)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPath(f.path); } }}>
                                {/* Long paths wrap after a slash rather than inside a name. */}
                                <span className="fname">{parts.map((part, i) => (i < parts.length - 1 ? [`${part}/`, <wbr key={i} />] : part))}</span>
                                <span className="meta">{formatSize(f.size)}</span>
                            </div>
                        );
                    })}
                </nav>
                <pre id="skillFileBody">{body}</pre>
            </div>
        </div>
    );
}

function skillActions(s) {
    // On or off for the agent: an off skill isn't offered by the skill tool, can't be
    // loaded, and its @id isn't expanded. Its files stay.
    const on = !settings.disabledSkills.includes(s.id);
    const toggle = (e) => setSettings({ disabledSkills: [...settings.disabledSkills.filter((x) => x !== s.id), ...(e.target.checked ? [] : [s.id])] });
    const del = async () => {
        if (!confirm(`Delete the skill ${s.id} (${SKILLS_DIR}/${s.id})? This can't be undone.`)) return;
        // A skill imported again under this id starts on.
        setSettings({ disabledSkills: settings.disabledSkills.filter((x) => x !== s.id) });
        try { await skills.remove(s.id); skillsNote([], `Deleted @${s.id}.`); } catch (e) { skillsNote([`Could not delete ${s.id}: ${e.message}`]); }
    };
    return { on, toggle, del };
}

export default function SkillsSection() {
    useTopics('skills', 'settings');
    const [open, setOpen] = useState(null);
    const [dropping, setDropping] = useState(false);
    const depth = useRef(0);
    const pick = useRef(null);
    useEffect(() => { skillsNote(); skills.refresh().catch(() => {}); }, []);
    const list = skills.list();
    // A skill removed while open (here or from the guest) closes its view.
    const back = useRef(() => setOpen(null)).current;
    useEffect(() => { if (open && !list.some((s) => s.id === open)) setOpen(null); });
    const note = UI.skillsNote;
    return (
        <div id="setSkills" className={`dlg-pane${dropping ? ' dropping' : ''}`} role="tabpanel"
            onDragEnter={(e) => { if (carriesFiles(e)) { depth.current++; setDropping(true); } }}
            onDragOver={(e) => { if (!carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDragLeave={(e) => { if (carriesFiles(e) && --depth.current <= 0) { depth.current = 0; setDropping(false); } }}
            onDrop={async (e) => {
                if (!carriesFiles(e)) return;
                e.preventDefault();
                depth.current = 0;
                setDropping(false);
                // Read the entries before any await: the drop's data goes away after.
                const entries = [...e.dataTransfer.items].map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null));
                if (!entries.every(Boolean)) { skillsNote(['Drop skill folders here; this browser did not pass them on as folders.']); return; }
                await importSkills((await Promise.all(entries.map((en) => readEntry(en, '')))).flat());
            }}>
            {open ? <SkillView id={open} onBack={back} /> : <>
                <div id="skillsBar">
                    <span id="skillsHint">One library for every project, at <code>/agent/skills</code> in each environment. Type <code>@</code> in a message to pick one to include; untick one to keep it from the agent.</span>
                    <button id="skillsImport" title="Import a skill folder, or a folder of skill folders (or drop them here)" onClick={() => pick.current.click()}>Import folder</button>
                    <input id="skillsPick" ref={pick} type="file" webkitdirectory="" multiple hidden onChange={(e) => {
                        const items = [...e.target.files].map((file) => ({ rel: file.webkitRelativePath || file.name, file }));
                        e.target.value = '';
                        importSkills(items);
                    }} />
                </div>
                {(note.problems.length > 0 || note.note) && (
                    <div id="skillsNote" role="status">
                        {note.problems.map((p) => <div key={p} className="bad">{p}</div>)}
                        {note.note && <div>{note.note}</div>}
                    </div>
                )}
                <div id="skillsList" role="list">
                    {!list.length && <div className="files-empty">No skills yet. A skill is a folder with a SKILL.md in it (name and description in its
                        frontmatter). Press Import folder, or drop skill folders here.</div>}
                    {list.map((s) => {
                        const { on, toggle, del } = skillActions(s);
                        return (
                            <div key={s.id} className={`skill${on ? '' : ' off'}`} role="listitem">
                                <label className="sid" title={on ? 'On: the agent can use this skill. Untick to turn it off.' : 'Off: the agent isn\'t offered this skill. Tick to turn it on.'}>
                                    <input type="checkbox" checked={on} onChange={toggle} aria-label={`Let the agent use the skill ${s.id}`} />
                                    {`@${s.id}`}
                                    {s.name !== s.id && <span className="sname">{` · ${s.name}`}</span>}
                                    {!on && <span className="sname"> (off)</span>}
                                </label>
                                <div className="sbuttons">
                                    <button title={`Show ${SKILLS_DIR}/${s.id}/SKILL.md and the skill's files`} onClick={() => setOpen(s.id)}>Open</button>
                                    <button title={`Delete ${SKILLS_DIR}/${s.id}`} onClick={del}>Delete</button>
                                </div>
                                <div className="sdesc">{s.description || '(no description in its SKILL.md)'}</div>
                            </div>
                        );
                    })}
                </div>
            </>}
        </div>
    );
}
