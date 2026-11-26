// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * FilesPane.jsx — the Files tab: the open chat's project's /workspace
 * (src/app/files.js). Folders, a text preview, ticks for downloading or deleting
 * several, uploads (buttons or dropping files and folders, onto the folder or a
 * folder row), and linked folders. Names come from the guest: text only.
 */

import { useEffect, useRef, useState } from 'react';
import { subscribe, useTopics } from '../../app/store.js';
import { formatSize, S } from '../../app/state.js';
import { canLink, copyFolderIn, files, pickAndLink, reconnectLinks } from '../../app/files.js';
import { projectOf, rt } from '../../app/world.js';

const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const filesOf = (input) => { const list = [...input.files]; input.value = ''; return list; };

function Row({ r, target }) {
    const go = () => files.go(r);
    let meta = '';
    let metaTitle;
    if (r.busy) meta = r.busy;
    else if (r.link) {
        meta = r.link.needsPermission ? 'linked · needs Reconnect' : `linked${r.link.mode === 'read' ? ' read-only' : ''} · ${r.link.name}`;
        metaTitle = r.link.mode === 'read'
            ? `Copied from the folder ${r.link.name} on your computer, and updated when it changes; nothing is written back`
            : `Kept in sync with the folder ${r.link.name} on your computer, both ways`;
    } else if (!r.dir) meta = formatSize(r.size);
    const save = r.dir ? `Download ${r.name} as ${r.name}.zip` : `Download ${r.name}`;
    return (
        <div className={`file${r.dir ? ' dir' : ''}${target ? ' drop-target' : ''}`} role="listitem" tabIndex={0} data-drop-dir={r.dir ? r.full : undefined}
            onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(); }}>
            {r.up ? <span /> : (
                // A tick selects the row; it doesn't open it.
                <input type="checkbox" checked={files.selected.has(r.name)} aria-label={`Select ${r.name}`}
                    onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
                    onChange={(e) => files.select(r.name, e.target.checked)} />
            )}
            {r.busy ? <span className="spinner" title={r.busy} aria-hidden="true" />
                : <span aria-hidden="true">{r.link ? '🔗' : r.dir ? '📁' : '📄'}</span>}
            <span className="fname">{r.dir && !r.up ? `${r.name}/` : r.name}</span>
            <span className="meta" title={metaTitle}>{meta}</span>
            <span className="meta">{r.mtime ? new Date(r.mtime * 1000).toLocaleString() : ''}</span>
            {r.up ? <span /> : (
                <button type="button" className="fsave" title={save} aria-label={save}
                    onClick={(e) => { e.stopPropagation(); files.download(r.full, r.dir); }} onKeyDown={(e) => e.stopPropagation()}>↓</button>
            )}
        </div>
    );
}

export default function FilesPane({ active }) {
    useTopics('files');
    const pick = useRef(null);
    const pickDir = useRef(null);
    const linkPick = useRef(null);
    const selectAll = useRef(null);
    const depth = useRef(0);   // dragenter/leave fire for every child crossed
    const [dropping, setDropping] = useState(false);
    const [target, setTarget] = useState(null);   // the folder row a drop would go into

    // Shown: list the folder again (the agent may have changed it).
    useEffect(() => { if (active) files.refresh(); }, [active]);
    useEffect(() => subscribe('focus-files-pick', () => pick.current?.click()), []);
    useEffect(() => subscribe('focus-files-link', () => linkFolder()), []);

    const names = files.names();
    const n = files.selected.size;
    useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = n > 0 && n < names.length; });
    const tasks = [...files.tasks.values()];
    const links = rt(projectOf(S.chat)).links;
    const waiting = links.needingPermission.length;
    const crumbs = [['/', files.root]];
    let at = '';
    for (const part of files.path.split('/').filter(Boolean)) { at += `/${part}`; crumbs.push([at, part]); }

    async function linkFolder() {
        if (!(await pickAndLink())) linkPick.current?.click();
    }
    const clearDrop = () => { depth.current = 0; setDropping(false); setTarget(null); };
    const dropRow = (e) => e.target.closest?.('[data-drop-dir]')?.dataset.dropDir || null;
    return (
        <div id="filesPane" role="tabpanel" aria-labelledby="tabFiles" hidden={!active} className={dropping ? 'dropping' : undefined}
            onDragEnter={(e) => { if (carriesFiles(e)) { depth.current++; setDropping(true); } }}
            onDragOver={(e) => {
                if (!carriesFiles(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setTarget(dropRow(e));
            }}
            onDragLeave={(e) => { if (carriesFiles(e) && --depth.current <= 0) clearDrop(); }}
            onDrop={(e) => {
                if (!carriesFiles(e)) return;
                e.preventDefault();
                const dir = dropRow(e) || files.path;
                clearDrop();
                files.drop(e.dataTransfer, dir);
            }}>
            <div id="filesBar">
                <input id="filesAll" type="checkbox" ref={selectAll} aria-label="Select everything in this folder" title="Select everything in this folder"
                    disabled={!names.length} checked={n > 0 && n === names.length} onChange={(e) => files.selectAll(e.target.checked)} />
                <nav id="crumbs" aria-label="Folder">
                    {crumbs.map(([path, label], i) => [
                        i ? '/' : null,
                        <a key={path} tabIndex={0} onClick={() => files.open(path)} onKeyDown={(e) => { if (e.key === 'Enter') files.open(path); }}>{label}</a>,
                    ])}
                </nav>
                {tasks.length > 0 && (
                    <span id="filesStatus" role="status">
                        <span className="spinner" aria-hidden="true" />
                        {tasks.at(-1) + (tasks.length > 1 ? ` (+${tasks.length - 1} more)` : '')}
                    </span>
                )}
                {n > 0 && <button id="filesDownloadSelected" onClick={() => files.downloadSelected()}
                    title={n === 1 ? 'Download it (a folder as a .zip)' : 'Download the ticked files and folders as one .zip'}>{`Download (${n})`}</button>}
                {n > 0 && <button id="filesDeleteSelected" onClick={() => files.deleteSelected()}
                    title="Delete the ticked files and folders (linked folders are unlinked)">{`Delete (${n})`}</button>}
                {waiting > 0 && <button id="filesReconnect" onClick={reconnectLinks}
                    title="Give the browser access again to the linked folders on your computer">{`Reconnect (${waiting})`}</button>}
                <button id="filesLink" disabled={files.linkBusy} onClick={linkFolder}
                    title={canLink ? 'Link a folder on your computer into this folder: its files are copied here and kept in sync'
                        : 'Copy a folder from your computer into this folder. This browser can\'t give a page lasting access to a folder, so it is a one-time copy, not kept in sync (Chrome and Edge can link one).'}>
                    {canLink ? 'Link folder' : 'Copy folder in'}</button>
                <button id="filesRefresh" title="List the folder again" onClick={() => files.refresh()}>Refresh</button>
                <button id="filesUpload" title="Copy files from this computer into the folder (or drop files and folders here)" onClick={() => pick.current.click()}>Upload</button>
                <button id="filesUploadDir" title="Copy a folder from this computer into the folder (or drop it here)" onClick={() => pickDir.current.click()}>Upload folder</button>
                <input id="filesPick" ref={pick} type="file" multiple hidden
                    onChange={(e) => files.upload(filesOf(e.target).map((file) => ({ rel: file.name, file })))} />
                {/* webkitRelativePath starts with the picked folder's name. Empty folders
                    inside it don't come along: the picker lists files only. */}
                <input id="filesPickDir" ref={pickDir} type="file" webkitdirectory="" multiple hidden
                    onChange={(e) => files.upload(filesOf(e.target).map((file) => ({ rel: file.webkitRelativePath || file.name, file })))} />
                <input id="filesLinkPick" ref={linkPick} type="file" webkitdirectory="" multiple hidden
                    onChange={(e) => copyFolderIn(filesOf(e.target))} />
            </div>
            <div id="filesList" role="list">
                {!files.entries?.length
                    ? <div className="files-empty">{files.emptyText}</div>
                    : files.rows().map((r) => <Row key={r.name} r={r} target={!!target && r.dir && r.full === target} />)}
            </div>
            {files.preview && (
                <div id="filePreview">
                    <div id="previewBar">
                        <span id="previewName">{files.preview.title}</span>
                        <button onClick={() => files.download(files.preview.path)}>Download</button>
                        <button onClick={() => files.delete(files.preview.path)}>Delete</button>
                        <button onClick={() => files.closePreview()}>Close</button>
                    </div>
                    <pre id="previewBody">{files.preview.text}</pre>
                </div>
            )}
        </div>
    );
}
