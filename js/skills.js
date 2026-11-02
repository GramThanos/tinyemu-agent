/*
 * skills.js — skills: folders of instructions, each with a SKILL.md, that the user
 * imports and the model loads on demand.
 *
 * Skills live in a third JS volume, `skills`, which the page keeps in IndexedDB
 * and the guest mounts at /agent/skills, so a skill's scripts and reference files
 * are there for the model's other tools. A skill's id is its folder's name.
 *
 * The page uses them two ways:
 *   - `@id` in a prompt is replaced by that skill's instructions before sending;
 *   - the `skill` tool lists every skill's description, and calling it returns
 *     the instructions, so the model can pull one in when a task matches.
 *
 * The list is read straight from IndexedDB at page load, so it is there before
 * the VM boots. Once the VM runs, its in-memory copy of the volume is the live
 * one (the guest can change it too), and every read and write goes through it.
 */

'use strict';

export const SKILLS_VOLUME = 'skills';
export const SKILLS_DIR = '/agent/skills';
export const SKILLS_STORAGE_KEY = 'tinyemu-agent-skills';
export const SKILL_FILE = 'SKILL.md';
export const SKILL_TOOL = 'skill';

/* A folder name usable as an id, a path segment and an `@mention`. */
const ID_RE = /^[\w][\w.-]*$/;

const DEC = new TextDecoder();

/**
 * Parse the frontmatter keys of a SKILL.md: `key: value` lines, quoted values,
 * and `>`/`|` block or indented continuation lines. Enough YAML for the
 * name/description that skills carry; anything else is kept as text.
 * @returns {Object<string,string>}
 */
export function parseFrontmatter(src) {
    const meta = {};
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^([\w-]+)[ \t]*:(?:[ \t]+(.*))?$/);
        if (!m) continue;
        let value = (m[2] || '').replace(/[ \t]+#.*$/, '').trim();
        const block = value.match(/^([>|])[+-]?$/);
        const rest = [];
        while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1] === '')) rest.push(lines[++i].trim());
        while (rest.length && rest[rest.length - 1] === '') rest.pop();
        if (block) {
            value = block[1] === '|' ? rest.join('\n') : rest.join(' ').replace(/ {2,}/g, ' ');
        } else {
            if (rest.length) value = [value, ...rest].filter(Boolean).join(' ');
            const q = value.match(/^(["'])([\s\S]*)\1$/);
            if (q) value = q[1] === '"' ? q[2].replace(/\\(["\\])/g, '$1') : q[2].replace(/''/g, "'");
        }
        meta[m[1]] = value;
    }
    return meta;
}

/** Split a SKILL.md into its frontmatter and its trimmed instructions. */
export function parseSkillFile(text) {
    const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const m = src.match(/^---[ \t]*\n((?:.*\n)*?)---[ \t]*(?:\n|$)/);
    if (!m) return { meta: {}, body: src.trim() };
    return { meta: parseFrontmatter(m[1]), body: src.slice(m[0].length).trim() };
}

/** What the `skill` tool returns. */
export function formatSkillLoad(id, body) {
    return `[Loaded skill: ${id}]\nBase directory: ${SKILLS_DIR}/${id}\n\n---\n\n${body}`;
}

/**
 * The `skill` tool's definition for these skills, or null when there are none:
 * an empty enum is not a valid schema. The skills are listed in the description,
 * which is the one place every provider passes on to the model.
 * @param {{id:string, name:string, description:string}[]} skills
 */
export function skillToolDef(skills) {
    if (!skills.length) return null;
    const list = skills.map((s) => `- ${s.id}${s.name !== s.id ? ` (${s.name})` : ''}: ${s.description || '(no description)'}`);
    return {
        name: SKILL_TOOL,
        description: 'Load specialized instructions or domain-specific workflows on demand. Use this tool when a user '
            + 'task aligns with one of the available skill descriptions below. A skill\'s other files are in its base '
            + `directory, ${SKILLS_DIR}/<id>, for the other tools to read or run.\n\nAvailable skills:\n${list.join('\n')}`,
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The exact ID of the skill to load into context.', enum: skills.map((s) => s.id) },
            },
            required: ['name'],
        },
    };
}

/**
 * Replace each `@id` of a known skill with its instructions, on lines of their
 * own. An `@` inside a word (an email address) is not a mention.
 * @param {string} text
 * @param {string[]} ids
 * @param {(id:string)=>Promise<string>} load  a skill's instructions
 * @returns {Promise<{text:string, used:string[]}>}
 */
export async function expandSkillMentions(text, ids, load) {
    if (!ids.length) return { text, used: [] };
    const alts = [...ids].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'));
    const re = new RegExp(`(?<![\\w@.])@(${alts.join('|')})(?![\\w-]|\\.\\w)`, 'g');
    const used = [...new Set([...text.matchAll(re)].map((m) => m[1]))];
    if (!used.length) return { text, used };
    const bodies = new Map();
    for (const id of used) bodies.set(id, await load(id));
    return { text: text.replace(re, (_, id) => `\n${bodies.get(id)}\n`), used };
}

/**
 * Work out which skills a set of picked or dropped files holds: every folder
 * with a SKILL.md is one, so a single skill's folder and a folder of skills
 * both work. A SKILL.md nested inside another skill belongs to that skill.
 * @param {{rel:string, file?:File}[]} items  paths relative to what was picked
 * @returns {{skills:{id:string, files:{path:string, file:File}[]}[], problems:string[]}}
 */
export function groupSkillFiles(items) {
    const files = items.filter((it) => it.file);
    const roots = files
        .filter((it) => it.rel.split('/').pop().toLowerCase() === SKILL_FILE.toLowerCase())
        .map((it) => it.rel.slice(0, Math.max(0, it.rel.lastIndexOf('/'))))
        .sort((a, b) => a.length - b.length);
    const outer = roots.filter((r, i) => !roots.slice(0, i).some((o) => o === '' || r.startsWith(`${o}/`)));
    const skills = [];
    const problems = [];
    for (const root of outer) {
        const id = root.split('/').pop();
        if (!root) { problems.push(`${SKILL_FILE} must be inside its skill's folder; import the folder instead.`); continue; }
        if (!ID_RE.test(id)) { problems.push(`"${id}" can't be a skill id: use letters, digits, _ . and -.`); continue; }
        skills.push({
            id,
            files: files.filter((it) => it.rel.startsWith(`${root}/`))
                .map((it) => {
                    let path = it.rel.slice(root.length);
                    // Keep the instructions at the name every reader looks for.
                    if (path.toLowerCase() === `/${SKILL_FILE.toLowerCase()}`) path = `/${SKILL_FILE}`;
                    return { path, file: it.file };
                }),
        });
    }
    if (!outer.length) problems.push(`No ${SKILL_FILE} found: a skill is a folder with a ${SKILL_FILE} in it.`);
    return { skills, problems };
}

export class SkillLibrary {
    constructor() {
        this.vm = null;
        this.skills = [];        // [{id, name, description}], sorted by id
        this._store = null;      // the volume as IndexedDB held it at page load
        this._listeners = new Set();
    }

    /** Read the skills saved in this browser, without a VM. */
    async loadSaved() {
        try {
            const { Fs9pStore } = await import('../engine/volumes/Fs9pStore.js');
            this._store = await Fs9pStore.fromSpec({ name: SKILLS_VOLUME, backend: 'indexeddb', storageKey: SKILLS_STORAGE_KEY });
            // Only read from here on; the VM's worker owns writing the volume.
            await this._store.backend.close();
        } catch (e) {
            console.warn('skills: could not read the saved skills', e);
        }
        return this.refresh();
    }

    /** Use the VM's copy of the volume from now on. */
    setVM(vm) { this.vm = vm; }

    onChange(fn) { this._listeners.add(fn); }

    /* The live volume where there is one, the page-load copy otherwise. */
    async _list(path) {
        if (this.vm) {
            const entries = await this.vm.volumeList(SKILLS_VOLUME, path).catch(() => undefined);
            if (entries !== undefined) return entries;
        }
        return this._store?.listDir(path) ?? null;
    }

    async _get(path) {
        if (this.vm) {
            const bytes = await this.vm.volumeGetFile(SKILLS_VOLUME, path).catch(() => undefined);
            if (bytes !== undefined) return bytes;
        }
        return this._store?.getFile(path) ?? null;
    }

    /** Scan for SKILL.md files again. @returns the skills */
    async refresh() {
        const found = [];
        for (const e of (await this._list('/')) || []) {
            if (!e.dir || !ID_RE.test(e.name)) continue;
            const bytes = await this._get(`/${e.name}/${SKILL_FILE}`);
            if (!bytes) continue;
            const { meta } = parseSkillFile(DEC.decode(bytes));
            found.push({ id: e.name, name: meta.name || e.name, description: meta.description || '' });
        }
        found.sort((a, b) => a.id.localeCompare(b.id));
        const changed = JSON.stringify(found) !== JSON.stringify(this.skills);
        this.skills = found;
        if (changed) for (const fn of this._listeners) fn(found);
        return found;
    }

    list() { return this.skills; }

    has(id) { return this.skills.some((s) => s.id === id); }

    /** A skill's instructions, read afresh: the guest may have edited them. */
    async body(id) {
        const bytes = ID_RE.test(id) ? await this._get(`/${id}/${SKILL_FILE}`) : null;
        if (!bytes) throw new Error(`No skill named "${id}".`);
        return parseSkillFile(DEC.decode(bytes)).body;
    }

    /**
     * Every file of a skill, as paths inside its folder: SKILL.md first, then the
     * rest in path order.
     * @returns {Promise<{path:string, size:number}[]>}
     */
    async files(id) {
        if (!ID_RE.test(id)) throw new Error(`No skill named "${id}".`);
        const out = [];
        const walk = async (dir) => {
            for (const e of (await this._list(`/${id}${dir}`)) || []) {
                const path = `${dir}/${e.name}`;
                if (e.dir) await walk(path);
                else out.push({ path: path.slice(1), size: e.size });
            }
        };
        await walk('');
        const rank = (p) => (p === SKILL_FILE ? 0 : 1);
        return out.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
    }

    /** One file of a skill, by its path inside the skill's folder, or null. */
    async readFile(id, path) {
        if (!ID_RE.test(id) || path.split('/').some((s) => s === '..' || s === '')) return null;
        return this._get(`/${id}/${path}`);
    }

    /** The `skill` tool's result for one skill. */
    async load(id) { return formatSkillLoad(id, await this.body(id)); }

    /** See expandSkillMentions(). */
    expandMentions(text) {
        return expandSkillMentions(text, this.skills.map((s) => s.id), (id) => this.body(id));
    }

    /**
     * Import skill folders, replacing any skill with the same id.
     * @param {{rel:string, file?:File}[]} items
     * @returns {Promise<{imported:string[], problems:string[]}>}
     */
    async import(items) {
        const { skills, problems } = groupSkillFiles(items);
        if (!skills.length) return { imported: [], problems };
        if (!this.vm) return { imported: [], problems: ['The VM is still starting; import the skills again once it runs.'] };
        const imported = [];
        for (const { id, files } of skills) {
            try {
                await this.vm.volumeDelete(SKILLS_VOLUME, `/${id}`).catch(() => {});
                for (const { path, file } of files) {
                    await this.vm.volumePutFile(SKILLS_VOLUME, `/${id}${path}`, new Uint8Array(await file.arrayBuffer()));
                }
                imported.push(id);
            } catch (e) {
                problems.push(`Could not import ${id}: ${e.message}`);
            }
        }
        await this.vm.volumeFlush(SKILLS_VOLUME).catch(() => {});
        await this.refresh();
        return { imported, problems };
    }

    async remove(id) {
        if (!this.vm) throw new Error('The VM is still starting; try again once it runs.');
        await this.vm.volumeDelete(SKILLS_VOLUME, `/${id}`);
        await this.vm.volumeFlush(SKILLS_VOLUME).catch(() => {});
        return this.refresh();
    }
}
