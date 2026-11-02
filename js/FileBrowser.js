/*
 * FileBrowser.js — browse one of the VM's JS volumes (the agent's /workspace)
 * from the page: open folders, preview text files, download, upload, delete.
 *
 * It reads the volume's store directly, the same one the guest sees over 9p,
 * so it needs no guest round trip and shows changes from either side at once.
 * File and folder names come from the guest, so they only ever go into the page
 * as text.
 */

'use strict';

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
     *                             deleteSelected
     * @param {string} o.volume    the volume's name
     * @param {string} o.root      where the guest mounts it, for display
     * @param {(text:string)=>void} o.onProblem
     * @param {import('./LinkedFolders.js').LinkedFolders} [o.links]  synced before
     *                             each listing; its folders are marked
     */
    constructor({ els, volume, root, onProblem, links = null }) {
        this.els = els;
        this.volume = volume;
        this.root = root;
        this.onProblem = onProblem;
        this.links = links;
        this.vm = null;
        this.path = '/';
        this.previewPath = null;
        this.selected = new Set();   // names ticked in the open folder
        this._names = [];            // names listed in the open folder
        this._seq = 0;

        els.selectAll.onchange = () => {
            this.selected = new Set(els.selectAll.checked ? this._names : []);
            for (const box of els.list.querySelectorAll('input[type=checkbox]')) box.checked = els.selectAll.checked;
            this._updateSelection();
        };
        els.deleteSelected.onclick = () => this._deleteSelected();

        els.refresh.onclick = () => this.refresh();
        els.upload.onclick = () => els.pick.click();
        els.pick.onchange = () => this._upload([...els.pick.files].map((file) => ({ rel: file.name, file })))
            .finally(() => { els.pick.value = ''; });
        this._setupDrop(els.pane);
        els.previewClose.onclick = () => this._closePreview();
        els.previewDownload.onclick = () => this._download(this.previewPath);
        els.previewDelete.onclick = () => this._delete(this.previewPath);
        this._render(null, 'The VM is starting; its files appear here once it runs.');
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
    }

    /* What a delete does to linked folders, for the confirmation. */
    _linkNote(paths) {
        if (!this.links) return '';
        const roots = paths.filter((p) => this.links.at(p));
        const inside = paths.some((p) => !this.links.at(p) && this.links.containing(p));
        let note = '';
        if (roots.length) note += `\n\nA linked folder is only unlinked: the folder on your computer stays as it is.`;
        if (inside) note += `\n\nThis is inside a linked folder, so it is also deleted on your computer.`;
        return note;
    }

    async _deleteSelected() {
        const names = [...this.selected].sort();
        if (!names.length) return;
        const shown = names.slice(0, 10).map((n) => `  ${this.root}${join(this.path, n)}`).join('\n')
            + (names.length > 10 ? `\n  … and ${names.length - 10} more` : '');
        if (!confirm(`Delete ${names.length === 1 ? 'this' : `these ${names.length}`} from ${this.root}? `
            + `Folders go with everything in them. This can't be undone.`
            + this._linkNote(names.map((n) => join(this.path, n))) + `\n\n${shown}`)) return;
        for (const name of names) {
            const path = join(this.path, name);
            try {
                await this.vm.volumeDelete(this.volume, path);
            } catch (e) {
                this.onProblem(`Could not delete ${this.root}${path}: ${e.message}`);
            }
            const p = this.previewPath;
            if (p && (p === path || p.startsWith(`${path}/`))) this._closePreview();
        }
        this.selected.clear();
        await this.refresh();
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
            const link = !e.up && e.dir ? this.links?.at(join(this.path, e.name)) : null;
            icon.textContent = link ? '🔗' : e.dir ? '📁' : '📄';
            icon.setAttribute('aria-hidden', 'true');
            const name = document.createElement('span');
            name.className = 'fname';
            name.textContent = e.dir && !e.up ? `${e.name}/` : e.name;
            const size = document.createElement('span');
            size.className = 'meta';
            size.textContent = link
                ? (link.needsPermission ? 'linked · needs Reconnect' : `linked · ${link.name}`)
                : e.dir ? '' : formatSize(e.size);
            if (link) size.title = `Kept in sync with the folder ${link.name} on your computer`;
            const when = document.createElement('span');
            when.className = 'meta';
            when.textContent = e.mtime ? new Date(e.mtime * 1000).toLocaleString() : '';
            row.append(tick, icon, name, size, when);
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

    async _download(path) {
        const bytes = await this.vm.volumeGetFile(this.volume, path).catch(() => null);
        if (!bytes) { this.onProblem(`Could not read ${this.root}${path}.`); return; }
        const url = URL.createObjectURL(new Blob([bytes]));
        const a = document.createElement('a');
        a.href = url;
        a.download = path.slice(path.lastIndexOf('/') + 1);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async _delete(path) {
        if (!confirm(`Delete ${this.root}${path}? This can't be undone.${this._linkNote([path])}`)) return;
        try {
            await this.vm.volumeDelete(this.volume, path);
        } catch (e) {
            this.onProblem(`Could not delete ${this.root}${path}: ${e.message}`);
        }
        this._closePreview();
        await this.refresh();
    }

    /**
     * Copy files into the volume.
     * @param {{rel: string, file?: File}[]} items  paths relative to `dir`; an
     *        item without a file is an (empty) folder
     */
    async _upload(items, dir = this.path) {
        if (!items.length) return;
        if (!this.vm) { this.onProblem('The VM is still starting; upload again once it runs.'); return; }
        for (const { rel, file } of items) {
            const path = join(dir, rel);
            try {
                if (file) await this.vm.volumePutFile(this.volume, path, new Uint8Array(await file.arrayBuffer()));
                else await this.vm.volumeMkdir(this.volume, path);
            } catch (e) {
                this.onProblem(`Could not upload ${rel}: ${e.message}`);
            }
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
            const items = entries.every(Boolean)
                ? (await Promise.all(entries.map((e) => readEntry(e, '')))).flat()
                : plain.map((file) => ({ rel: file.name, file }));
            await this._upload(items, dir);
        });
    }
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
