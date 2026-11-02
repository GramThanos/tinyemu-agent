/*
 * tools.js — the tools the model can call: Read, Edit, Write, Glob, Grep, Bash, and
 * `skill` while the user has imported skills (see skills.js).
 *
 * Everything acts on the guest filesystem through GuestBridge.exec(). Shell scripts
 * do only what needs the guest (file transfer, find, grep); parsing, matching and
 * formatting stay here, where they can be tested without a VM.
 *
 * Input comes from the model, so every call is validated against its schema first
 * and every value that reaches a script goes through shQuote(). The guest itself is
 * the sandbox: paths are not confined, since the whole VM is the agent's to use.
 */

'use strict';

import { SKILL_TOOL, skillToolDef } from './skills.js';

export const DEFAULT_CWD = '/workspace';

const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_LINE = 2000;        // characters per line
const READ_MAX_BYTES = 20 * 1024 * 1024;
const GLOB_MAX = 1000;
const GREP_MAX = 500;
const GREP_MAX_LINE = 500;
const OUTPUT_MAX = 30000;          // characters of Bash output returned to the model
const BASH_DEFAULT_MS = 120000;
const BASH_MAX_MS = 600000;
const FS_TIMEOUT_MS = 60000;       // Read/Write/Edit
const SEARCH_TIMEOUT_MS = 120000;  // Glob/Grep: a cold 9p tree fetches over the network
const READY_TIMEOUT_MS = 60000;    // how long a call waits for a VM that is still booting

/* Pseudo-filesystems and dependency/VCS directories, skipped by Glob and Grep. */
const PRUNE = `\\( -path /proc -o -path /sys -o -path /dev -o -path ${"'/mnt/agent'"} -o -name .git -o -name node_modules \\) -prune -o`;

export const TOOL_DEFS = [
    {
        name: 'Read',
        description: 'Reads a text file from the VM. Returns numbered lines (like `cat -n`), up to 2000 lines per call; use offset and limit to page through longer files.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative or absolute target path.' },
                offset: { type: 'integer', description: 'Line number to start reading from. Default: 1.' },
                limit: { type: 'integer', description: 'Maximum number of lines to read. Default: 2000.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'Edit',
        description: 'Replaces a string in an existing file. old_string must match exactly (including whitespace) and must occur exactly once; add surrounding lines to make it unique.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Target file path.' },
                old_string: { type: 'string', description: 'Exact existing text to replace. Must be unique within the file.' },
                new_string: { type: 'string', description: 'The replacement text.' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'Write',
        description: 'Creates a file, or completely overwrites an existing one. Creates parent directories as needed.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Target file path.' },
                content: { type: 'string', description: 'Complete content to write.' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'Glob',
        description: 'Lists file paths matching a glob pattern, relative to path, without reading contents. Supports *, ?, [...], {a,b} and **, e.g. **/*.ts. A pattern with no slash matches only directly inside path.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Match expression, e.g. **/*.ts' },
                path: { type: 'string', description: 'Root directory for the search. Default: the current working directory.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'Grep',
        description: 'Searches file contents with a POSIX extended regular expression. Returns path:line:text. Skips .git, node_modules and pseudo-filesystems.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regular expression or literal substring to match.' },
                path: { type: 'string', description: 'Target file or directory. Default: the current working directory.' },
                include: { type: 'string', description: 'File name filter, e.g. *.py or *.{ts,js}. Default: all files.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'Bash',
        description: 'Runs a command with /bin/sh in the VM.The working directory carries over between calls; environment variables do not. Output is stdout and stderr merged. Several Bash calls in one message run at the same time; if more than one changes directory, the last to finish wins. With run_in_background the call returns at once with where to find the output and exit code, and the command keeps running with no timeout until it ends or you kill it.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command string.' },
                timeout: { type: 'integer', description: 'Maximum runtime in milliseconds. Default: 120000. Maximum: 600000.' },
                run_in_background: { type: 'boolean', description: 'Return immediately and leave the command running. Default: false.' },
            },
            required: ['command'],
        },
    },
];

export const DELEGATE_TOOL = 'Delegate';

/* Offered when createTools() gets a `delegate` runner (see Agent.js). */
export const DELEGATE_DEF = {
    name: DELEGATE_TOOL,
    description: 'Hands a self-contained task to a sub-agent: a new conversation with the same model and the same tools (except Delegate) in the same VM. It sees only your prompt, not this conversation, so include everything it needs: the goal, the relevant paths and facts, and what to report back. It returns the sub-agent\'s final report. Use it for a piece of work that would fill your context with detail you don\'t need afterwards, such as a broad search or an independent subtask. Several Delegate calls in one message run at the same time; give them work that doesn\'t touch the same files.',
    input_schema: {
        type: 'object',
        properties: {
            description: { type: 'string', description: 'A short (3-5 word) label for the task, shown to the user.' },
            prompt: { type: 'string', description: 'The complete task for the sub-agent.' },
        },
        required: ['description', 'prompt'],
    },
};

/** Every tool name the page can offer, for settings. */
export const ALL_TOOL_NAMES = [...TOOL_DEFS.map((d) => d.name), SKILL_TOOL, DELEGATE_TOOL];

export class ToolError extends Error {}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Quote a string as one shell word. */
export function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** @returns {string|null} why `input` does not satisfy `schema`, or null if it does */
export function validateInput(schema, input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
    for (const key of schema.required || []) {
        if (input[key] === undefined) return `missing required parameter "${key}"`;
    }
    for (const [key, value] of Object.entries(input)) {
        const spec = schema.properties[key];
        if (!spec) return `unknown parameter "${key}"`;
        if (spec.type === 'string' && typeof value !== 'string') return `"${key}" must be a string`;
        if (spec.type === 'integer' && !Number.isInteger(value)) return `"${key}" must be an integer`;
        if (spec.type === 'boolean' && typeof value !== 'boolean') return `"${key}" must be true or false`;
        if (spec.enum && !spec.enum.includes(value)) return `"${key}" must be one of: ${spec.enum.join(', ')}`;
    }
    return null;
}

/** Expand {a,b} alternatives, innermost first: `*.{ts,js}` -> [`*.ts`, `*.js`]. */
export function expandBraces(pattern) {
    const m = pattern.match(/\{([^{}]*)\}/);
    if (!m || !m[1].includes(',')) return [pattern];
    const head = pattern.slice(0, m.index);
    const tail = pattern.slice(m.index + m[0].length);
    return m[1].split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

/** Compile a glob (without braces) to an anchored RegExp over '/'-separated paths. */
function globSegmentsToRegex(glob) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                const atStart = i === 0 || glob[i - 1] === '/';
                if (atStart && glob[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; continue; }
                if (atStart && i + 2 === glob.length) { re += '.*'; i += 1; continue; }
            }
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '[') {
            const end = glob.indexOf(']', i + 2);
            if (end < 0) { re += '\\['; continue; }
            let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
            if (body[0] === '!') body = '^' + body.slice(1);
            re += `[${body}]`;
            i = end;
        } else {
            re += c.replace(/[.+^$(){}|\\\]]/g, '\\$&');
        }
    }
    return new RegExp(re + '$');
}

/** @returns {(path:string)=>boolean} */
export function globMatcher(pattern) {
    const res = expandBraces(pattern).map(globSegmentsToRegex);
    return (path) => res.some((r) => r.test(path));
}

/** cat -n style slice of a file. */
export function formatLines(text, offset = 1, limit = READ_DEFAULT_LIMIT) {
    if (text === '') return '(empty file)';
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, offset);
    if (start > lines.length) return `(offset ${start} is past the end of the file: ${lines.length} lines)`;
    const end = Math.min(lines.length, start + Math.max(1, limit) - 1);
    const out = [];
    for (let n = start; n <= end; n++) {
        let line = lines[n - 1].replace(/\r$/, '');
        if (line.length > READ_MAX_LINE) line = line.slice(0, READ_MAX_LINE) + ' ...[line truncated]';
        out.push(`${String(n).padStart(6)}\t${line}`);
    }
    if (end < lines.length) out.push(`[showing lines ${start}-${end} of ${lines.length}; use offset to continue]`);
    return out.join('\n');
}

/** Keep the start and end of long output, which is where the useful parts tend to be. */
export function truncateOutput(text, max = OUTPUT_MAX) {
    if (text.length <= max) return text;
    const keep = Math.floor(max / 2);
    return `${text.slice(0, keep)}\n[... ${text.length - keep * 2} characters omitted ...]\n${text.slice(-keep)}`;
}

/**
 * Bind the tools to a bridge. The working directory lives here because Bash changes
 * it and every other tool resolves relative paths against it.
 *
 * The bridge can be a promise of one, so the model can be connected while the VM
 * still boots: a call then waits up to `readyTimeoutMs` for it, and otherwise
 * returns an error result the model can act on, having run nothing.
 *
 * `skills` (a SkillLibrary, or anything with list() and load(id)) adds the `skill`
 * tool while it holds skills. That tool reads the skills volume from the page, so
 * it doesn't need or wait for the VM.
 *
 * `delegate(input, ctx)` adds the Delegate tool; it runs a sub-agent and resolves
 * to its report (see createDelegate in Agent.js). `isEnabled(name)` hides tools
 * the user turned off: they leave the list and refuse to run.
 *
 * `sync()`, if given, is awaited before and after every call that touches the VM
 * (linked folders are brought up to date then); its failures are ignored.
 * @param {{exec:Function}|Promise<{exec:Function}>} bridgeOrPromise
 */
export function createTools(bridgeOrPromise, {
    cwd = DEFAULT_CWD, readyTimeoutMs = READY_TIMEOUT_MS, skills = null, delegate = null, isEnabled = () => true,
    sync = null,
} = {}) {
    const syncQuietly = async () => { try { await sync?.(); } catch { /* the call still runs */ } };
    const state = { cwd };
    const defs = () => {
        const skill = skills && skillToolDef(skills.list());
        return [...TOOL_DEFS, skill, delegate && DELEGATE_DEF].filter((d) => d && isEnabled(d.name));
    };
    let bridge = null;
    let bootError = null;
    const bridgeReady = Promise.resolve(bridgeOrPromise).then(
        (b) => { bridge = b; },
        (e) => { bootError = e; },
    );

    const waitForBridge = async ({ signal, onOutput }) => {
        if (bridge || bootError) return;
        onOutput?.('[waiting for the VM to finish booting]\n');
        let timer, onAbort;
        const gaveUp = await Promise.race([
            bridgeReady.then(() => null),
            new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), readyTimeoutMs); }),
            new Promise((resolve) => {
                onAbort = () => resolve('aborted');
                if (signal?.aborted) onAbort();
                else signal?.addEventListener('abort', onAbort, { once: true });
            }),
        ]);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (gaveUp === 'aborted') throw new ToolError('Stopped by the user.');
        if (gaveUp === 'timeout') {
            throw new ToolError(`The VM is still booting; waited ${Math.round(readyTimeoutMs / 1000)} s for it. `
                + 'Nothing ran. Try the call again shortly.');
        }
    };
    // Only `.` segments are removed: `..` depends on symlinks, so the guest resolves it.
    const abs = (p) => {
        const full = p.startsWith('/') ? p : `${state.cwd}/${p}`;
        const segments = full.split('/').filter((s) => s && s !== '.');
        return `/${segments.join('/')}`;
    };

    /* Calls can run at once, so Read, Edit and Write of one file queue up: an Edit's
     * read-modify-write can't lose another's change, and they apply in call order. */
    const fileQueues = new Map();
    const inOrder = (path, fn) => {
        const result = (fileQueues.get(path) || Promise.resolve()).then(fn);
        const tail = result.catch(() => {});
        fileQueues.set(path, tail);
        tail.then(() => { if (fileQueues.get(path) === tail) fileQueues.delete(path); });
        return result;
    };

    const script = async (body, opts) => {
        const r = await bridge.exec({ script: body, cwd: state.cwd, timeoutMs: FS_TIMEOUT_MS, ...opts });
        if (r.aborted) throw new ToolError('Stopped by the user.');
        if (r.timedOut) throw new ToolError(`Timed out after ${Math.round((opts?.timeoutMs || FS_TIMEOUT_MS) / 1000)} s.`);
        return r;
    };

    /** Fetch a whole file's bytes, with the guest explaining any failure. */
    const fetchFile = async (path, signal) => {
        const q = shQuote(path);
        const r = await script(
            `[ -e ${q} ] || { echo "File does not exist: "${q}; exit 3; }
[ -d ${q} ] && { echo "Path is a directory, not a file: "${q}; exit 3; }
[ -r ${q} ] || { echo "Permission denied: "${q}; exit 3; }
n=$(wc -c <${q})
[ "$n" -le ${READ_MAX_BYTES} ] || { echo "File is too large to read: $n bytes"; exit 3; }
cp ${q} "$AGENT_DIR/data"`,
            { outputs: ['data'], signal },
        );
        if (r.rc !== 0) throw new ToolError(DEC.decode(r.out).trim() || `Could not read ${path}.`);
        return r.files.data || new Uint8Array(0);
    };

    const storeFile = async (path, bytes, signal) => {
        const q = shQuote(path);
        const parent = shQuote(path.replace(/\/[^/]*$/, '') || '/');
        const r = await script(`mkdir -p ${parent} && cat "$AGENT_DIR/data" >${q}`, { inputs: { data: bytes }, signal });
        if (r.rc !== 0) throw new ToolError(DEC.decode(r.out).trim() || `Could not write ${path}.`);
    };

    const handlers = {
        async Read({ path, offset, limit }, { signal }) {
            const target = abs(path);
            const bytes = await inOrder(target, () => fetchFile(target, signal));
            if (bytes.includes(0)) throw new ToolError(`Binary file (${bytes.length} bytes); use Bash to inspect it.`);
            return formatLines(DEC.decode(bytes), offset, limit);
        },

        async Edit({ path, old_string, new_string }, { signal }) {
            if (old_string === '') throw new ToolError('old_string must not be empty; use Write to create a file.');
            if (old_string === new_string) throw new ToolError('old_string and new_string are identical.');
            const target = abs(path);
            return inOrder(target, async () => {
                const bytes = await fetchFile(target, signal);
                let text;
                try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
                catch { throw new ToolError('File is not valid UTF-8; Edit would corrupt it. Use Bash instead.'); }
                const parts = text.split(old_string);
                if (parts.length === 1) throw new ToolError(`old_string was not found in ${path}.`);
                if (parts.length > 2) throw new ToolError(`old_string occurs ${parts.length - 1} times in ${path}; include more context to make it unique.`);
                await storeFile(target, ENC.encode(parts.join(new_string)), signal);
                return `Edited ${target}.`;
            });
        },

        async Write({ path, content }, { signal }) {
            const target = abs(path);
            const bytes = ENC.encode(content);
            await inOrder(target, () => storeFile(target, bytes, signal));
            return `Wrote ${bytes.length} bytes to ${target}.`;
        },

        async Glob({ pattern, path = '.' }, { signal }) {
            const root = abs(path);
            const q = shQuote(root);
            const r = await script(
                `[ -d ${q} ] || { echo "Not a directory: "${q}; exit 3; }\nfind ${q} ${PRUNE} -type f -print 2>/dev/null; exit 0`,
                { timeoutMs: SEARCH_TIMEOUT_MS, signal },
            );
            const output = DEC.decode(r.out);
            if (r.rc === 3) throw new ToolError(output.trim());
            const prefix = root === '/' ? '/' : root + '/';
            const matches = globMatcher(pattern.replace(/^\.\//, ''));
            const hits = output.split('\n')
                .filter((p) => p.startsWith(prefix) && matches(p.slice(prefix.length)))
                .sort();
            if (!hits.length) return 'No files found.';
            const shown = hits.slice(0, GLOB_MAX);
            if (hits.length > GLOB_MAX) shown.push(`[${hits.length - GLOB_MAX} more; narrow the pattern]`);
            return shown.join('\n');
        },

        async Grep({ pattern, path = '.', include }, { signal }) {
            const target = shQuote(abs(path));
            const pat = shQuote(pattern);
            // `find -name` has no {a,b} and no directories; only the last path segment applies.
            const names = include ? expandBraces(include.replace(/^.*\//, '')) : [];
            const nameTest = names.length
                ? `\\( ${names.map((n) => `-name ${shQuote(n)}`).join(' -o ')} \\) `
                : '';
            const limit = GREP_MAX + 1;
            const r = await script(
                `[ -e ${target} ] || { echo "Path does not exist: "${target}; exit 3; }
echo | grep -E -e ${pat} >/dev/null 2>&1
[ $? -le 1 ] || { echo "Invalid regular expression: "${pat}; exit 3; }
if [ -d ${target} ]; then
    find ${target} ${PRUNE} -type f ${nameTest}-exec grep -nHE -e ${pat} {} + 2>/dev/null
else
    grep -nHE -e ${pat} ${target} 2>/dev/null
fi | head -n ${limit}
exit 0`,
                { timeoutMs: SEARCH_TIMEOUT_MS, signal },
            );
            const output = DEC.decode(r.out);
            if (r.rc === 3) throw new ToolError(output.trim());
            const lines = output.split('\n').filter(Boolean);
            if (!lines.length) return 'No matches found.';
            const shown = lines.slice(0, GREP_MAX)
                .map((l) => (l.length > GREP_MAX_LINE ? l.slice(0, GREP_MAX_LINE) + ' ...[truncated]' : l));
            if (lines.length > GREP_MAX) shown.push(`[results capped at ${GREP_MAX} lines; narrow the search]`);
            return shown.join('\n');
        },

        async Bash({ command, timeout = BASH_DEFAULT_MS, run_in_background = false }, { signal, onOutput }) {
            if (run_in_background) {
                // Its own session, so it outlives this call and can be killed as a group.
                const r = await script(
                    `J=$(mktemp -d /tmp/agent-job.XXXXXX) || exit 1
cp "$AGENT_DIR/command" "$J/command"
setsid sh -c 'sh "$1/command" >"$1/out" 2>&1 </dev/null; echo $? >"$1/rc"' sh "$J" </dev/null >/dev/null 2>&1 &
echo "$! $J"`,
                    { inputs: { command }, signal },
                );
                const [pid, dir] = DEC.decode(r.out).trim().split(' ');
                if (r.rc !== 0 || !dir) throw new ToolError(DEC.decode(r.out).trim() || 'Could not start the command.');
                return `Started in the background.\nOutput: ${dir}/out\nExit code: ${dir}/rc (exists once it has finished)\nTo stop it: kill -TERM -${pid}`;
            }
            const timeoutMs = Math.min(Math.max(1000, timeout), BASH_MAX_MS);
            const streamDec = new TextDecoder();
            const startedIn = state.cwd;
            const r = await bridge.exec({
                script: command,
                cwd: startedIn,
                timeoutMs,
                signal,
                onOutput: onOutput && ((chunk) => onOutput(streamDec.decode(chunk, { stream: true }))),
            });
            // Only a real `cd` counts: a parallel call that didn't move mustn't undo one that did.
            if (r.cwd && r.cwd !== startedIn) state.cwd = r.cwd;
            let text = truncateOutput(DEC.decode(r.out));
            const notes = [];
            if (r.aborted) notes.push('Stopped by the user.');
            else if (r.timedOut) notes.push(`Timed out after ${Math.round(timeoutMs / 1000)} s and was killed.`);
            else if (r.overflow) notes.push('Killed: the command produced too much output.');
            else if (r.rc !== 0) notes.push(`Exit code ${r.rc}.`);
            if (notes.length) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}[${notes.join(' ')}]`;
            if (r.rc !== 0 || r.aborted || r.timedOut) throw new ToolError(text);
            return text || '(no output)';
        },
    };

    const notOffered = (name) => ({
        content: ALL_TOOL_NAMES.includes(name) ? `The ${name} tool is turned off.` : `Unknown tool: ${name}`,
        isError: true,
    });

    const tools = {
        /** Read afresh for each turn: skills and settings change the list. */
        get defs() { return defs(); },
        get cwd() { return state.cwd; },

        /**
         * Run one tool call. Never throws for a tool failure: those are results the
         * model should see and recover from.
         * @returns {Promise<{content:string, isError:boolean}>}
         */
        async run(name, input, ctx = {}) {
            const def = defs().find((d) => d.name === name);
            if (!def) return notOffered(name);
            const problem = validateInput(def.input_schema, input);
            if (problem) return { content: `Invalid input: ${problem}.`, isError: true };
            try {
                if (name === SKILL_TOOL || name === DELEGATE_TOOL) {
                    // Neither needs the VM: a sub-agent's own calls wait for it.
                    try {
                        const content = name === SKILL_TOOL ? await skills.load(input.name) : await delegate(input, ctx);
                        return { content, isError: false };
                    } catch (e) {
                        throw new ToolError(e.message);
                    }
                }
                await waitForBridge(ctx);
                if (bootError) throw new ToolError(`The VM failed to boot (${bootError.message}), so no tool can run.`);
                await syncQuietly();
                try {
                    return { content: await handlers[name](input, ctx), isError: false };
                } finally {
                    await syncQuietly();
                }
            } catch (e) {
                const message = e instanceof ToolError ? e.message : `Tool failed: ${e.message}`;
                return { content: message, isError: true };
            }
        },

        /**
         * The same tools, sharing the working directory and file ordering, minus
         * `exclude`: what a sub-agent gets, so it can't delegate in turn.
         */
        without(...exclude) {
            return {
                get defs() { return defs().filter((d) => !exclude.includes(d.name)); },
                get cwd() { return state.cwd; },
                run: (name, input, ctx) => (exclude.includes(name)
                    ? Promise.resolve({ content: `The ${name} tool is not available here.`, isError: true })
                    : tools.run(name, input, ctx)),
            };
        },
    };
    return tools;
}
