// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * files.js — the Files tab's model: one of the JS volumes (the open chat's
 * project's /workspace) as folders to open, text files to preview, downloads
 * (folders as .zip), uploads of files and folders, deletes (a linked folder is
 * unlinked instead), and linking folders from the computer. components/FilesPane
 * draws it.
 *
 * It reads the volume's store directly (the project's VolumeHost), the same one
 * the guest sees over 9p, so it needs no guest round trip and shows changes from
 * either side at once. File and folder names come from the guest, so they only
 * ever go into the page as text.
 */

'use strict';

import { LinkError } from '../../js/LinkedFolders.js';
import { makeZip } from '../../js/zip.js';
import { emit } from './store.js';
import { asText, formatSize, S, saveBlob } from './state.js';
import { addMessage } from './sessions.js';
import { projectOf, rt, WORKSPACE, WORKSPACE_VOLUME } from './world.js';
import { choose } from './dialogs.js';

const PREVIEW_MAX = 2 * 1024 * 1024;
export const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
export const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const STARTING = 'The VM is starting; its files appear here once it runs.';

class FileModel {
    constructor() {
        this.volume = WORKSPACE_VOLUME;
        this.root = WORKSPACE;
        this.host = null;            // the project's VolumeHost
        this.links = null;           // its LinkedFolders: synced before each listing; its folders are marked
        this.path = '/';
        this.entries = null;         // the open folder's listing, or null (not yet, or no volume)
        this.emptyText = STARTING;
        this.preview = null;         // { path, title, text }
        this.selected = new Set();   // names ticked in the open folder
        this.busy = new Map();       // path -> what is happening to it (copying in, uploading, deleting…)
        this.tasks = new Map();      // running operations, shown in the bar: id -> text
        this.linkBusy = false;       // linking or copying a folder in
        this._taskSeq = 0;
        this._seq = 0;
    }

    changed() { emit('files'); }
    problem(text) { addMessage('problem', text); }
    note(text) { addMessage('note', text); }

    /** Point it at a project: its volume host and linked folders. */
    show(p) {
        const r = rt(p);
        this.host = r.volumes;
        this.links = r.links;
        return this.open('/');
    }

    /**
     * Show a running operation in the bar until done() (with a spinner); also
     * for the page's own (linking, copying in). Several can run at once: the
     * latest shows, with a count of the others.
     */
    task(text) {
        const id = ++this._taskSeq;
        this.tasks.set(id, text);
        this.changed();
        return {
            update: (t) => { if (this.tasks.has(id)) { this.tasks.set(id, t); this.changed(); } },
            done: () => { this.tasks.delete(id); this.changed(); },
        };
    }

    /* Mark paths busy (a spinner in their rows) while `fn` runs. */
    async _withBusy(paths, label, fn) {
        for (const p of paths) this.busy.set(p, label);
        this.changed();
        try {
            return await fn();
        } finally {
            for (const p of paths) this.busy.delete(p);
            this.changed();
        }
    }

    async refresh() {
        const seq = ++this._seq;   // a slow listing must not overwrite a newer one
        if (!this.host) return;
        // A refresh is an action: show what linked folders hold now, on either side.
        await this.links?.sync().catch(() => {});
        if (seq !== this._seq) return;
        let entries;
        try {
            entries = await this.host.volumeList(this.volume, this.path);
        } catch {
            if (seq === this._seq) this._list(null, STARTING);
            return;
        }
        if (seq !== this._seq) return;
        if (entries === null && this.path !== '/') {   // the folder went away
            this.path = parentOf(this.path);
            return this.refresh();
        }
        this._list(entries || [], 'This folder is empty. Drop files or folders here, or press Upload.');
    }

    _list(entries, emptyText) {
        this.entries = entries;
        this.emptyText = emptyText;
        // Keep only ticks for what is still here.
        const names = new Set((entries || []).map((e) => e.name));
        this.selected = new Set([...this.selected].filter((n) => names.has(n)));
        this.changed();
    }

    open(path) {
        if (path !== this.path) this.selected.clear();
        this.path = path;
        this.preview = null;
        this.changed();
        return this.refresh();
    }

    names() { return (this.entries || []).map((e) => e.name); }
    select(name, on) {
        if (on) this.selected.add(name); else this.selected.delete(name);
        this.changed();
    }
    selectAll(on) {
        this.selected = new Set(on ? this.names() : []);
        this.changed();
    }

    /* The rows to draw: folders first, then files; ".." first below the root. */
    rows() {
        const sorted = [...(this.entries || [])].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        if (this.path !== '/') sorted.unshift({ name: '..', dir: true, up: true });
        return sorted.map((e) => {
            const full = e.up ? parentOf(this.path) : join(this.path, e.name);
            const link = !e.up && e.dir ? this.links?.at(full) : null;
            // A folder still being linked or copied in shows a spinner, not its icon.
            const busy = e.up ? null : this.busy.get(full) || (this.links?.linking?.has(full) ? 'linking…' : null);
            return { ...e, full, link, busy };
        });
    }

    go(row) {
        if (row.up) this.open(parentOf(this.path));
        else if (row.dir) this.open(row.full);
        else this._preview(row.full);
    }

    async _preview(path) {
        const bytes = await this.host.volumeGetFile(this.volume, path).catch(() => null);
        if (!bytes) { this.problem(`Could not read ${this.root}${path}.`); return this.refresh(); }
        const text = bytes.length <= PREVIEW_MAX ? asText(bytes) : null;
        this.preview = {
            path,
            title: `${this.root}${path} · ${formatSize(bytes.length)}`,
            text: text ?? (bytes.length > PREVIEW_MAX
                ? 'This file is too large to preview. Download it to open it.'
                : 'This is a binary file. Download it to open it.'),
        };
        this.changed();
    }
    closePreview() { this.preview = null; this.changed(); }

    /*
     * Delete paths, except that a linked folder is unlinked instead: its files
     * stay in the workspace, as a plain folder, and on the computer. The unlink
     * comes first and waits for any sync in progress, so no sync can see a
     * linked folder half deleted and delete the same files on the computer.
     */
    async _remove(paths) {
        const unlinked = [];
        await this._withBusy(paths, 'deleting…', async () => {
            const t = this.task(paths.length === 1 ? `Deleting ${this.root}${paths[0]}…` : `Deleting ${paths.length} items…`);
            try {
                for (const path of paths) {
                    try {
                        if (this.links?.at(path)) {
                            this.busy.set(path, 'unlinking…');
                            t.update(`Unlinking ${this.root}${path}…`);
                            if (await this.links.unlink(path)) unlinked.push(path);
                            continue;
                        }
                        await this.host.volumeDelete(this.volume, path);
                    } catch (e) {
                        this.problem(`Could not delete ${this.root}${path}: ${e.message}`);
                    }
                    const p = this.preview?.path;
                    if (p && (p === path || p.startsWith(`${path}/`))) this.preview = null;
                }
            } finally {
                t.done();
            }
        });
        for (const path of unlinked) {
            this.note(`Unlinked ${this.root}${path}. Its files stay here, no longer synced, and the folder on your `
                + 'computer is unchanged. Delete it again to remove the copy from the workspace.');
        }
    }

    /* What a delete does to linked folders, for the confirmation. */
    _linkNote(paths) {
        if (!this.links) return '';
        const roots = paths.filter((p) => this.links.at(p));
        const inside = paths.some((p) => !this.links.at(p) && this.links.containing(p));
        let note = '';
        if (roots.length) {
            note += `\n\n${roots.length === 1 ? 'A linked folder is' : 'Linked folders are'} only unlinked, not deleted: `
                + 'the files stay in the workspace, and the folder on your computer stays as it is.';
        }
        if (inside) note += '\n\nThis is inside a linked folder, so it is also deleted on your computer (unless the link is read-only).';
        return note;
    }

    async deleteSelected() {
        const names = [...this.selected].sort();
        if (!names.length) return;
        const paths = names.map((n) => join(this.path, n));
        const shown = paths.slice(0, 10).map((p) => `  ${this.root}${p}${this.links?.at(p) ? '  (unlink)' : ''}`).join('\n')
            + (names.length > 10 ? `\n  … and ${names.length - 10} more` : '');
        const onlyLinks = paths.every((p) => this.links?.at(p));
        if (!confirm((onlyLinks
            ? `Unlink ${names.length === 1 ? 'this folder' : `these ${names.length} folders`}?`
            : `Delete ${names.length === 1 ? 'this' : `these ${names.length}`} from ${this.root}? `
              + 'Folders go with everything in them. This can\'t be undone.')
            + this._linkNote(paths) + `\n\n${shown}`)) return;
        await this._remove(paths);
        this.selected.clear();
        await this.refresh();
    }

    async downloadSelected() {
        const names = [...this.selected].sort();
        if (!names.length) return;
        if (names.length === 1) return this.download(join(this.path, names[0]));
        const folder = this.path === '/' ? this.root.split('/').filter(Boolean).pop() || 'workspace' : this.path.slice(this.path.lastIndexOf('/') + 1);
        return this._downloadZip(names.map((n) => join(this.path, n)), `${folder}.zip`);
    }

    /* A file as itself, a folder as <name>.zip. */
    async download(path, isDir = null) {
        const name = path.slice(path.lastIndexOf('/') + 1) || 'workspace';
        if (isDir ?? (await this.host.volumeList(this.volume, path).catch(() => null)) !== null) {
            return this._downloadZip([path], `${name}.zip`);
        }
        const bytes = await this.host.volumeGetFile(this.volume, path).catch(() => null);
        if (!bytes) { this.problem(`Could not read ${this.root}${path}.`); return; }
        saveBlob(new Blob([bytes]), name);
    }

    /* Zip files and folders (whole trees), named by their last path part. */
    async _downloadZip(paths, zipName) {
        const t = this.task(`Zipping ${zipName}…`);
        try {
            const entries = [];
            let bytes = 0;
            const add = async (path, name) => {
                const kids = await this.host.volumeList(this.volume, path);
                if (kids === null) {
                    const data = await this.host.volumeGetFile(this.volume, path);
                    if (!data) return;   // went away meanwhile
                    bytes += data.length;
                    entries.push({ name, data });
                    t.update(`Zipping ${zipName}: ${entries.length} files, ${formatSize(bytes)}…`);
                    return;
                }
                entries.push({ name, dir: true });
                for (const k of kids) {
                    if (k.dir) await add(join(path, k.name), `${name}/${k.name}`);
                    else {
                        const data = await this.host.volumeGetFile(this.volume, join(path, k.name));
                        if (!data) continue;
                        bytes += data.length;
                        entries.push({ name: `${name}/${k.name}`, data, mtime: k.mtime });
                        if (entries.length % 20 === 0) t.update(`Zipping ${zipName}: ${entries.length} files, ${formatSize(bytes)}…`);
                    }
                }
            };
            for (const p of paths) await add(p, p.slice(p.lastIndexOf('/') + 1) || 'workspace');
            const blob = await makeZip(entries, {
                onProgress: (i, n) => { if (i % 20 === 0 || i === n) t.update(`Compressing ${zipName}: ${i} of ${n}…`); },
            });
            saveBlob(blob, zipName);
        } catch (e) {
            this.problem(`Could not make ${zipName}: ${e.message}`);
        } finally {
            t.done();
        }
    }

    async delete(path) {
        const linkRoot = this.links?.at(path);
        if (!confirm(linkRoot ? `Unlink ${this.root}${path}?${this._linkNote([path])}`
            : `Delete ${this.root}${path}? This can't be undone.${this._linkNote([path])}`)) return;
        await this._remove([path]);
        this.preview = null;
        await this.refresh();
    }

    /**
     * Copy files into the volume.
     * @param {{rel: string, file?: File}[]} items  paths relative to `dir`; an
     *        item without a file is an (empty) folder
     */
    async upload(items, dir = this.path) {
        if (!items.length) return;
        if (!this.host) { this.problem('The VM is still starting; upload again once it runs.'); return; }
        const files = items.filter((i) => i.file);
        const total = files.reduce((n, i) => n + i.file.size, 0);
        const t = this.task(`Uploading ${files.length === 1 ? files[0].rel : `${files.length} files`} (${formatSize(total)})…`);
        // Top-level folders appear at once, with a spinner, while their files copy in.
        const tops = [...new Set(items.filter((i) => i.rel.includes('/')).map((i) => i.rel.split('/')[0]))].map((n) => join(dir, n));
        try {
            await this._withBusy(tops, 'uploading…', async () => {
                for (const top of tops) await this.host.volumeMkdir(this.volume, top).catch(() => {});
                if (tops.length && dir === this.path) await this.refresh();
                let done = 0, sent = 0;
                for (const { rel, file } of items) {
                    const path = join(dir, rel);
                    try {
                        if (file) {
                            await this.host.volumePutFile(this.volume, path, new Uint8Array(await file.arrayBuffer()));
                            sent += file.size;
                            if (++done < files.length) t.update(`Uploading ${done + 1} of ${files.length} (${formatSize(sent)} of ${formatSize(total)})…`);
                        } else {
                            await this.host.volumeMkdir(this.volume, path);
                        }
                    } catch (e) {
                        this.problem(`Could not upload ${rel}: ${e.message}`);
                    }
                }
            });
        } finally {
            t.done();
        }
        await this.refresh();
    }

    /* A drop of files and folders, onto the open folder or a folder row (dir).
     * Read the entries before any await: the drop's data goes away after. */
    async drop(dataTransfer, dir = this.path) {
        const entries = [...dataTransfer.items].map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null));
        const plain = [...dataTransfer.files];
        // Folders come as entries; take each item as an entry when the browser
        // gives one, else as a plain file. A folder without an entry would
        // arrive as an empty, unreadable "file", so say so instead.
        const items = [];
        const unreadable = [];
        await Promise.all(entries.map(async (entry, i) => {
            try {
                if (entry) items.push(...await readEntry(entry, ''));
                else if (plain[i]) items.push({ rel: plain[i].name, file: plain[i] });
            } catch {
                unreadable.push(entry?.name || plain[i]?.name || '?');
            }
        }));
        if (unreadable.length) this.problem(`Could not read ${unreadable.join(', ')} from the drop; try Upload folder.`);
        items.sort((a, b) => a.rel.localeCompare(b.rel));   // parents before children
        await this.upload(items, dir);
    }
}

export const files = new FileModel();

/* Flatten a dropped file or folder into [{rel, file}], with folders as their
 * own items so empty ones are kept. */
export async function readEntry(entry, prefix) {
    const rel = prefix + entry.name;
    if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        return [{ rel, file }];
    }
    const reader = entry.createReader();
    const children = [];
    // readEntries returns a batch at a time, then an empty one.
    for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        children.push(...batch);
    }
    const nested = await Promise.all(children.map((c) => readEntry(c, `${rel}/`)));
    return [{ rel }, ...nested.flat()];
}

/* ---- linked folders ------------------------------------------------------ */

/* The File System Access API, which linking needs, is in Chromium browsers only.
 * Elsewhere (Firefox, Safari) the button copies a folder in once instead: a page
 * there can read a picked folder but never write to it or see it change. */
export const canLink = !!window.showDirectoryPicker;

/* The one-time copy: a picked folder's files (webkitRelativePath starts with its
 * name) into dir/<its name>, or <name>-2 if that is taken. Empty folders inside
 * it don't come along: the picker lists files only. */
export async function copyFolderIn(picked, dir = files.path) {
    if (!picked.length) { addMessage('problem', 'That folder has no files in it, so there is nothing to copy.'); return; }
    const volumes = rt(projectOf(S.chat)).volumes;
    const top = picked[0].webkitRelativePath.split('/')[0] || 'folder';
    const taken = new Set(((await volumes.volumeList(WORKSPACE_VOLUME, dir)) || []).map((e) => e.name));
    let name = top;
    for (let n = 2; taken.has(name); n++) name = `${top}-${n}`;
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
    const items = picked.map((file) => ({ rel: `${name}/${file.webkitRelativePath.split('/').slice(1).join('/') || file.name}`, file }));
    const bytes = picked.reduce((n, f) => n + f.size, 0);
    files.busy.set(path, 'copying…');
    files.linkBusy = true;
    const task = files.task(`Copying ${top} in…`);
    try {
        await volumes.volumeMkdir(WORKSPACE_VOLUME, path);
        await files.refresh();
        await files.upload(items, dir);
        addMessage('note', `Copied ${top} from your computer into ${WORKSPACE}${path} (${picked.length} files, ${formatSize(bytes)}). `
            + 'It is a copy: this browser can\'t link folders, so changes on either side stay on that side. '
            + 'Download files from the Files tab to take them back.');
    } catch (e) {
        addMessage('problem', `Could not copy ${top}: ${e.message}`);
    } finally {
        task.done();
        files.busy.delete(path);
        files.linkBusy = false;
        files.refresh();
    }
}

/* Link a folder: asks which way changes go, then for the folder. False when this
 * browser can't link (the caller offers a copy instead). */
export async function pickAndLink() {
    if (!canLink) return false;
    const mode = await choose('Link a folder', 'Its files are copied into the workspace and kept in sync. '
        + 'Which way should changes go?', [
        { value: 'read', label: 'Read-only', hint: 'Changes on your computer come into the workspace; nothing in the workspace is ever written back.' },
        { value: 'readwrite', label: 'Read-write', hint: 'Changes go both ways: edits and deletions in the workspace happen on your computer too.' },
    ]);
    if (!mode) return true;
    let handle;
    try {
        handle = await window.showDirectoryPicker({ mode, id: 'tinyemu-agent-link' });
    } catch (e) {
        if (e?.name !== 'AbortError') addMessage('problem', `Could not open the folder picker: ${e.message}`);
        return true;
    }
    await linkFolder(handle, files.path, mode);
    return true;
}

export async function linkFolder(handle, dir = files.path, mode = 'readwrite') {
    files.linkBusy = true;
    const task = files.task(`Linking ${handle.name}…`);
    try {
        const r = await rt(projectOf(S.chat)).links.link(handle, dir, mode);
        addMessage('note', `Linked ${handle.name} from your computer at ${WORKSPACE}${r.path}, ${mode === 'read' ? 'read-only' : 'read-write'} `
            + `(${r.files} files, ${formatSize(r.bytes)}). `
            + (mode === 'read'
                ? 'Changes on your computer come in at each tool call, message and refresh; changes in the workspace stay there. '
                : 'Changes on either side are synced at each tool call, message and refresh; deleting a file there deletes it on your computer too. ')
            + 'Delete the folder in the workspace to unlink it: its files stay, and the folder on your computer is untouched.');
    } catch (e) {
        addMessage('problem', e instanceof LinkError ? e.message : `Could not link ${handle.name}: ${e.message}`);
    } finally {
        task.done();
        files.linkBusy = false;
        files.refresh();
    }
}

export async function reconnectLinks() {
    const ok = await rt(projectOf(S.chat)).links.reconnect();
    if (!ok) addMessage('problem', 'The browser still has no access to some linked folders; they stay as they were and are not synced.');
    files.refresh();
}
