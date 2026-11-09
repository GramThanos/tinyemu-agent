/*
 * FileBrowser.js — browse one of the VM's JS volumes (the agent's /workspace)
 * from the page: open folders, preview text files, download (folders as .zip),
 * upload files and folders, delete (a linked folder is unlinked instead).
 *
 * It reads the volume's store directly, the same one the guest sees over 9p,
 * so it needs no guest round trip and shows changes from either side at once.
 * File and folder names come from the guest, so they only ever go into the page
 * as text.
 */

'use strict';

import { makeZip } from './zip.js';

const PREVIEW_MAX = 2 * 1024 * 1024;

const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

export function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

/* Text unless it has a NUL early on or isn't valid UTF-8. */
export function asText(bytes) {
    if (bytes.subarray(0, 8192).includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

export class FileBrowser {
    /**
     * @param {object} o
     * @param {object} o.els       crumbs, list, refresh, upload, pick, preview,
     *                             previewName, previewBody, previewDownload,
     *                             previewDelete, previewClose, selectAll,
     *                             deleteSelected; optional: uploadDir and
     *                             pickDir (a folder picker), downloadSelected,
     *                             status (where running operations show)
     * @param {string} o.volume    the volume's name
     * @param {string} o.root      where the guest mounts it, for display
     * @param {(text:string)=>void} o.onProblem
     * @param {import('./LinkedFolders.js').LinkedFolders} [o.links]  synced before
     *                             each listing; its folders are marked
     */
    constructor({ els, volume, root, onProblem, onNote = null, links = null }) {
        this.els = els;
        this.volume = volume;
        this.root = root;
        this.onProblem = onProblem;
        this.onNote = onNote;
        this.links = links;
        this.vm = null;
        this.path = '/';
        this.previewPath = null;
        this.selected = new Set();   // names ticked in the open folder
        this.busy = new Map();       // path -> what is happening to it (copying in, uploading, deleting…)
        this._tasks = new Map();     // running operations, shown in els.status: id -> text
        this._taskSeq = 0;
        this._names = [];            // names listed in the open folder
        this._seq = 0;

        els.selectAll.onchange = () => {
            this.selected = new Set(els.selectAll.checked ? this._names : []);
            for (const box of els.list.querySelectorAll('input[type=checkbox]')) box.checked = els.selectAll.checked;
            this._updateSelection();
        };
        els.deleteSelected.onclick = () => this._deleteSelected();
        if (els.downloadSelected) els.downloadSelected.onclick = () => this._downloadSelected();

        els.refresh.onclick = () => this.refresh();
        els.upload.onclick = () => els.pick.click();
        els.pick.onchange = () => this._upload([...els.pick.files].map((file) => ({ rel: file.name, file })))
            .finally(() => { els.pick.value = ''; });
        if (els.uploadDir && els.pickDir) {
            els.uploadDir.onclick = () => els.pickDir.click();
            // webkitRelativePath starts with the picked folder's name. Empty folders
            // inside it don't come along: the picker lists files only.
            els.pickDir.onchange = () => this._upload([...els.pickDir.files]
                .map((file) => ({ rel: file.webkitRelativePath || file.name, file })))
                .finally(() => { els.pickDir.value = ''; });
        }
        this._setupDrop(els.pane);
        els.previewClose.onclick = () => this._closePreview();
        els.previewDownload.onclick = () => this._download(this.previewPath);
        els.previewDelete.onclick = () => this._delete(this.previewPath);
        this._render(null, 'The VM is starting; its files appear here once it runs.');
    }

    /**
     * Show a running operation in the bar until done() (with a spinner); also
     * for the page's own (linking, copying in). Several can run at once: the
     * latest shows, with a count of the others.
     */
    task(text) {
        const id = ++this._taskSeq;
        this._tasks.set(id, text);
        this._showTasks();
        return {
            update: (t) => { if (this._tasks.has(id)) { this._tasks.set(id, t); this._showTasks(); } },
            done: () => { this._tasks.delete(id); this._showTasks(); },
        };
    }

    _showTasks() {
        const el = this.els.status;
        if (!el) return;
        const texts = [...this._tasks.values()];
        el.hidden = !texts.length;
        el.replaceChildren();
        if (!texts.length) return;
        const spin = document.createElement('span');
        spin.className = 'spinner';
        spin.setAttribute('aria-hidden', 'true');
        el.append(spin, texts.at(-1) + (texts.length > 1 ? ` (+${texts.length - 1} more)` : ''));
    }

    /* Mark paths busy (a spinner in their rows) while `fn` runs. */
    async _withBusy(paths, label, fn) {
        for (const p of paths) this.busy.set(p, label);
        this._rerender();
        try {
            return await fn();
        } finally {
            for (const p of paths) this.busy.delete(p);
        }
    }

    /* Redraw the rows from the last listing (no volume round trip), for spinners. */
    _rerender() {
        if (this._entries) this._render(this._entries, this._emptyText);
    }

    /** Point the browser at a VM (its volumes exist once it has started). */
    setVM(vm) {
        this.vm = vm;
    }

    async refresh() {
        const seq = ++this._seq;   // a slow listing must not overwrite a newer one
        if (!this.vm) return;
        // A refresh is an action: show what linked folders hold now, on either side.
        await this.links?.sync().catch(() => {});
        if (seq !== this._seq) return;
        let entries;
        try {
            entries = await this.vm.volumeList(this.volume, this.path);
        } catch {
            if (seq === this._seq) this._render(null, 'The VM is starting; its files appear here once it runs.');
            return;
        }
        if (seq !== this._seq) return;
        if (entries === null && this.path !== '/') {   // the folder went away
            this.path = parentOf(this.path);
            return this.refresh();
        }
        this._render(entries || [], 'This folder is empty. Drop files or folders here, or press Upload.');
    }

    open(path) {
        if (path !== this.path) this.selected.clear();
        this.path = path;
        this._closePreview();
        return this.refresh();
    }

    /* The bar's select-all box and Delete button follow the ticked rows. */
    _updateSelection() {
        const { selectAll, deleteSelected } = this.els;
        const n = this.selected.size;
        selectAll.disabled = !this._names.length;
        selectAll.checked = n > 0 && n === this._names.length;
        selectAll.indeterminate = n > 0 && n < this._names.length;
        deleteSelected.hidden = n === 0;
        deleteSelected.textContent = `Delete (${n})`;
        if (this.els.downloadSelected) {
            this.els.downloadSelected.hidden = n === 0;
            this.els.downloadSelected.textContent = `Download (${n})`;
            this.els.downloadSelected.title = n === 1 ? 'Download it (a folder as a .zip)' : 'Download the ticked files and folders as one .zip';
        }
    }

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
                            this._rerender();
                            t.update(`Unlinking ${this.root}${path}…`);
                            if (await this.links.unlink(path)) unlinked.push(path);
                            continue;
                        }
                        await this.vm.volumeDelete(this.volume, path);
                    } catch (e) {
                        this.onProblem(`Could not delete ${this.root}${path}: ${e.message}`);
                    }
                    const p = this.previewPath;
                    if (p && (p === path || p.startsWith(`${path}/`))) this._closePreview();
                }
            } finally {
                t.done();
            }
        });
        for (const path of unlinked) {
            this.onNote?.(`Unlinked ${this.root}${path}. Its files stay here, no longer synced, and the folder on your `
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

    async _deleteSelected() {
        const names = [...this.selected].sort();
        if (!names.length) return;
        const paths = names.map((n) => join(this.path, n));
        const shown = paths.slice(0, 10).map((p) => `  ${this.root}${p}${this.links?.at(p) ? '  (unlink)' : ''}`).join('\n')
            + (names.length > 10 ? `\n  … and ${names.length - 10} more` : '');
        const onlyLinks = paths.every((p) => this.links?.at(p));
        if (!confirm((onlyLinks
            ? `Unlink ${names.length === 1 ? 'this folder' : `these ${names.length} folders`}?`
            : `Delete ${names.length === 1 ? 'this' : `these ${names.length}`} from ${this.root}? `
              + `Folders go with everything in them. This can't be undone.`)
            + this._linkNote(paths) + `\n\n${shown}`)) return;
        await this._remove(paths);
        this.selected.clear();
        await this.refresh();
    }

    async _downloadSelected() {
        const names = [...this.selected].sort();
        if (!names.length) return;
        if (names.length === 1) return this._download(join(this.path, names[0]));
        const folder = this.path === '/' ? this.root.split('/').filter(Boolean).pop() || 'workspace' : this.path.slice(this.path.lastIndexOf('/') + 1);
        return this._downloadZip(names.map((n) => join(this.path, n)), `${folder}.zip`);
    }

    _render(entries, emptyText) {
        const { crumbs, list } = this.els;
        crumbs.replaceChildren();
        const link = (label, path) => {
            const a = document.createElement('a');
            a.textContent = label;
            a.tabIndex = 0;
            a.onclick = () => this.open(path);
            a.onkeydown = (e) => { if (e.key === 'Enter') this.open(path); };
            return a;
        };
        crumbs.append(link(this.root, '/'));
        let at = '';
        for (const part of this.path.split('/').filter(Boolean)) {
            at += `/${part}`;
            crumbs.append('/', link(part, at));
        }

        list.replaceChildren();
        this._entries = entries;
        this._emptyText = emptyText;
        // Keep only ticks for what is still here.
        this._names = (entries || []).map((e) => e.name);
        this.selected = new Set(this._names.filter((n) => this.selected.has(n)));
        this._updateSelection();
        if (!entries?.length) {
            const empty = document.createElement('div');
            empty.className = 'files-empty';
            empty.textContent = emptyText;
            list.append(empty);
            return;
        }
        const sorted = [...entries].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        if (this.path !== '/') sorted.unshift({ name: '..', dir: true, up: true });
        for (const e of sorted) {
            const row = document.createElement('div');
            row.className = `file${e.dir ? ' dir' : ''}`;
            row.setAttribute('role', 'listitem');
            row.tabIndex = 0;
            // A tick selects the row; it doesn't open it.
            const tick = document.createElement(e.up ? 'span' : 'input');
            if (!e.up) {
                tick.type = 'checkbox';
                tick.checked = this.selected.has(e.name);
                tick.setAttribute('aria-label', `Select ${e.name}`);
                tick.onclick = (ev) => ev.stopPropagation();
                tick.onkeydown = (ev) => ev.stopPropagation();
                tick.onchange = () => {
                    if (tick.checked) this.selected.add(e.name);
                    else this.selected.delete(e.name);
                    this._updateSelection();
                };
            }
            const icon = document.createElement('span');
            const full = join(this.path, e.name);
            const link = !e.up && e.dir ? this.links?.at(full) : null;
            // A folder still being linked or copied in shows a spinner, not its icon.
            const busy = e.up ? null : this.busy.get(full) || (this.links?.linking?.has(full) ? 'linking…' : null);
            if (busy) {
                icon.className = 'spinner';
                icon.title = busy;
            } else {
                icon.textContent = link ? '🔗' : e.dir ? '📁' : '📄';
            }
            icon.setAttribute('aria-hidden', 'true');
            const name = document.createElement('span');
            name.className = 'fname';
            name.textContent = e.dir && !e.up ? `${e.name}/` : e.name;
            const size = document.createElement('span');
            size.className = 'meta';
            size.textContent = busy || (link
                ? (link.needsPermission ? 'linked · needs Reconnect'
                    : `linked${link.mode === 'read' ? ' read-only' : ''} · ${link.name}`)
                : e.dir ? '' : formatSize(e.size));
            if (link) {
                size.title = link.mode === 'read'
                    ? `Copied from the folder ${link.name} on your computer, and updated when it changes; nothing is written back`
                    : `Kept in sync with the folder ${link.name} on your computer, both ways`;
            }
            const when = document.createElement('span');
            when.className = 'meta';
            when.textContent = e.mtime ? new Date(e.mtime * 1000).toLocaleString() : '';
            // Download: a file as itself, a folder as a .zip.
            const save = document.createElement(e.up ? 'span' : 'button');
            if (!e.up) {
                save.type = 'button';
                save.className = 'fsave';
                save.textContent = '↓';
                save.title = e.dir ? `Download ${e.name} as ${e.name}.zip` : `Download ${e.name}`;
                save.setAttribute('aria-label', save.title);
                save.onclick = (ev) => { ev.stopPropagation(); this._download(full, e.dir); };
                save.onkeydown = (ev) => ev.stopPropagation();
            }
            row.append(tick, icon, name, size, when, save);
            const go = () => {
                if (e.up) this.open(parentOf(this.path));
                else if (e.dir) this.open(join(this.path, e.name));
                else this._preview(join(this.path, e.name));
            };
            row.onclick = go;
            row.onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
            // Dropping onto a folder row uploads into that folder.
            if (e.dir) row.dataset.dropDir = e.up ? parentOf(this.path) : join(this.path, e.name);
            list.append(row);
        }
    }

    async _preview(path) {
        const { preview, previewName, previewBody } = this.els;
        const bytes = await this.vm.volumeGetFile(this.volume, path).catch(() => null);
        if (!bytes) { this.onProblem(`Could not read ${this.root}${path}.`); return this.refresh(); }
        this.previewPath = path;
        previewName.textContent = `${this.root}${path} · ${formatSize(bytes.length)}`;
        const text = bytes.length <= PREVIEW_MAX ? asText(bytes) : null;
        previewBody.textContent = text ?? (bytes.length > PREVIEW_MAX
            ? 'This file is too large to preview. Download it to open it.'
            : 'This is a binary file. Download it to open it.');
        preview.hidden = false;
    }

    _closePreview() {
        this.previewPath = null;
        this.els.preview.hidden = true;
    }

    /* A file as itself, a folder as <name>.zip. */
    async _download(path, isDir = null) {
        const name = path.slice(path.lastIndexOf('/') + 1) || 'workspace';
        if (isDir ?? (await this.vm.volumeList(this.volume, path).catch(() => null)) !== null) {
            return this._downloadZip([path], `${name}.zip`);
        }
        const bytes = await this.vm.volumeGetFile(this.volume, path).catch(() => null);
        if (!bytes) { this.onProblem(`Could not read ${this.root}${path}.`); return; }
        saveBlob(new Blob([bytes]), name);
    }

    /* Zip files and folders (whole trees), named by their last path part. */
    async _downloadZip(paths, zipName) {
        const t = this.task(`Zipping ${zipName}…`);
        try {
            const entries = [];
            let bytes = 0;
            const add = async (path, name) => {
                const kids = await this.vm.volumeList(this.volume, path);
                if (kids === null) {
                    const data = await this.vm.volumeGetFile(this.volume, path);
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
                        const data = await this.vm.volumeGetFile(this.volume, join(path, k.name));
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
            this.onProblem(`Could not make ${zipName}: ${e.message}`);
        } finally {
            t.done();
        }
    }

    async _delete(path) {
        const linkRoot = this.links?.at(path);
        if (!confirm(linkRoot ? `Unlink ${this.root}${path}?${this._linkNote([path])}`
            : `Delete ${this.root}${path}? This can't be undone.${this._linkNote([path])}`)) return;
        await this._remove([path]);
        this._closePreview();
        await this.refresh();
    }

    /** Copy files into the volume (see _upload), as Upload and dropping do. */
    upload(items, dir = this.path) { return this._upload(items, dir); }

    /**
     * Copy files into the volume.
     * @param {{rel: string, file?: File}[]} items  paths relative to `dir`; an
     *        item without a file is an (empty) folder
     */
    async _upload(items, dir = this.path) {
        if (!items.length) return;
        if (!this.vm) { this.onProblem('The VM is still starting; upload again once it runs.'); return; }
        const files = items.filter((i) => i.file);
        const total = files.reduce((n, i) => n + i.file.size, 0);
        const t = this.task(`Uploading ${files.length === 1 ? files[0].rel : `${files.length} files`} (${formatSize(total)})…`);
        // Top-level folders appear at once, with a spinner, while their files copy in.
        const tops = [...new Set(items.filter((i) => i.rel.includes('/')).map((i) => i.rel.split('/')[0]))].map((n) => join(dir, n));
        try {
            await this._withBusy(tops, 'uploading…', async () => {
                for (const top of tops) await this.vm.volumeMkdir(this.volume, top).catch(() => {});
                if (tops.length && dir === this.path) await this.refresh();
                let done = 0, sent = 0;
                for (const { rel, file } of items) {
                    const path = join(dir, rel);
                    try {
                        if (file) {
                            await this.vm.volumePutFile(this.volume, path, new Uint8Array(await file.arrayBuffer()));
                            sent += file.size;
                            if (++done < files.length) t.update(`Uploading ${done + 1} of ${files.length} (${formatSize(sent)} of ${formatSize(total)})…`);
                        } else {
                            await this.vm.volumeMkdir(this.volume, path);
                        }
                    } catch (e) {
                        this.onProblem(`Could not upload ${rel}: ${e.message}`);
                    }
                }
            });
        } finally {
            t.done();
        }
        await this.refresh();
    }

    /* Drag and drop: files and whole folders, onto the pane (the open folder) or
     * onto a folder row (that folder). */
    _setupDrop(pane) {
        if (!pane) return;
        let depth = 0;   // dragenter/leave fire for every child crossed
        const target = (ev) => ev.target.closest?.('[data-drop-dir]');
        const clear = () => {
            depth = 0;
            pane.classList.remove('dropping');
            this.els.list.querySelector('.drop-target')?.classList.remove('drop-target');
        };
        const carriesFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');

        pane.addEventListener('dragenter', (ev) => {
            if (!carriesFiles(ev)) return;
            depth++;
            pane.classList.add('dropping');
        });
        pane.addEventListener('dragover', (ev) => {
            if (!carriesFiles(ev)) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
            const row = target(ev);
            const current = this.els.list.querySelector('.drop-target');
            if (current !== row) {
                current?.classList.remove('drop-target');
                row?.classList.add('drop-target');
            }
        });
        pane.addEventListener('dragleave', (ev) => {
            if (carriesFiles(ev) && --depth <= 0) clear();
        });
        pane.addEventListener('drop', async (ev) => {
            if (!carriesFiles(ev)) return;
            ev.preventDefault();
            const dir = target(ev)?.dataset.dropDir || this.path;
            // Read the entries before any await: the drop's data goes away after.
            const entries = [...ev.dataTransfer.items]
                .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null));
            const plain = [...ev.dataTransfer.files];
            clear();
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
            if (unreadable.length) this.onProblem(`Could not read ${unreadable.join(', ')} from the drop; try Upload folder.`);
            items.sort((a, b) => a.rel.localeCompare(b.rel));   // parents before children
            await this._upload(items, dir);
        });
    }
}

/* Hand a blob to the browser as a download. */
function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

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
