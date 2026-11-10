/*
 * tools.js — the tools the model can call: Read, Edit, Write, Glob, Grep, Bash,
 * `skill` while the user has imported skills (see skills.js), Delegate (a
 * sub-agent, see Agent.js) and ask_user (the page's question form).
 *
 * A call's name is matched without case or separators (`bash` runs Bash).
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

import { pauses } from './pause.js';
import { SKILL_TOOL, skillToolDef } from './skills.js';

export const DEFAULT_CWD = '/workspace';

const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_LINE = 2000;        // characters per line
const READ_MAX_BYTES = 20 * 1024 * 1024;
const GLOB_MAX = 1000;
const GREP_MAX = 500;
const GREP_MAX_LINE = 500;
const OUTPUT_MAX = 30000;          // truncateOutput's default
export const BASH_DEFAULT_MS = 30 * 60 * 1000;   // the emulated CPU is slow: builds and installs take long
export const BASH_MAX_MS = 2 * 60 * 60 * 1000;
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
    bashDef(BASH_DEFAULT_MS),
];

/* A shell's name: short, and safe to show. */
const SHELL_NAME = /^[\w.-]{1,40}$/;
export const DEFAULT_SHELL = 'main';

// A declaration, so TOOL_DEFS (above) can use it through bashDef.
function minutes(ms) { return `${+(ms / 60000).toFixed(2)} minute${ms === 60000 ? '' : 's'}`; }

/** The Bash definition. Its description names the default timeout, which the user can set. */
export function bashDef(defaultMs = BASH_DEFAULT_MS) {
    return {
        name: 'Bash',
        description: 'Runs a command with /bin/sh in the VM, in a shell session. A shell keeps its working directory and exported variables (export NAME=value) between calls; other variables and functions do not carry over. Output is stdout and stderr merged. Several Bash calls in one message run at the same time; give them different shells when they should not share a directory or variables (a server in one, tests in another). If parallel calls in one shell change its directory or variables, the last to finish wins. With run_in_background the call returns at once with where to find the output and exit code, and the command keeps running with no timeout until it ends or you kill it.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command string.' },
                timeout: { type: 'integer', description: `Maximum runtime in milliseconds; the command is killed when it runs out. Default: ${defaultMs} (${minutes(defaultMs)}). Maximum: ${BASH_MAX_MS} (2 hours).` },
                run_in_background: { type: 'boolean', description: 'Return immediately and leave the command running. Default: false.' },
                shell: { type: 'string', description: 'The shell session to run in: up to 40 letters, digits, dots, dashes or underscores. A new name opens a new shell, which starts in your current directory with your exported variables. Default: your own shell.' },
            },
            required: ['command'],
        },
    };
}

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

export const ASK_TOOL = 'ask_user';

/* Offered when createTools() gets an `ask` function (the page's question form).
 * Sub-agents never get it: the user isn't reading along with them. */
export const ASK_DEF = {
    name: ASK_TOOL,
    description: 'Pauses to ask the user one or more clarifying questions, and returns their answers. Use it when the request is ambiguous or a decision is genuinely theirs (a choice of approach, a destructive step), not for facts you can find out yourself. Put related questions in one call. Give each question 2 to 4 short suggested options; the user can also type an answer of their own unless allow_custom_input is false.',
    input_schema: {
        type: 'object',
        properties: {
            questions: {
                type: 'array',
                description: 'The questions, shown to the user together as a form.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Short key the answer comes back under, e.g. auth_method.' },
                        header: { type: 'string', description: 'Short title for the question, e.g. Auth.' },
                        question: { type: 'string', description: 'The full question.' },
                        options: { type: 'array', items: { type: 'string' }, description: '2 to 4 suggested answers.' },
                        multi_select: { type: 'boolean', description: 'The user may pick several options. Default: false.' },
                        allow_custom_input: { type: 'boolean', description: 'The user may type their own answer. Default: true.' },
                    },
                    required: ['id', 'question', 'options'],
                },
            },
        },
        required: ['questions'],
    },
};

const ASK_MAX_QUESTIONS = 10;
const ASK_MAX_OPTIONS = 8;

/**
 * The ask_user input as a list of questions: { id, header, question, options,
 * multi, custom }. Takes the batch form, and also one question given at the top
 * level ({ question, options, allow_custom_input }), which some models write.
 * @throws {ToolError} what is wrong with it
 */
export function askQuestions(input) {
    const list = Array.isArray(input?.questions) ? input.questions
        : typeof input?.question === 'string' ? [{ ...input, id: input.id ?? 'answer' }] : null;
    if (!list) throw new ToolError('Give "questions": a list of { id, question, options }.');
    if (!list.length || list.length > ASK_MAX_QUESTIONS) throw new ToolError(`Ask 1 to ${ASK_MAX_QUESTIONS} questions at a time.`);
    const seen = new Set();
    return list.map((q, i) => {
        if (!q || typeof q !== 'object') throw new ToolError(`Question ${i + 1} must be an object.`);
        if (typeof q.question !== 'string' || !q.question.trim()) throw new ToolError(`Question ${i + 1} has no "question" text.`);
        const options = q.options ?? [];
        if (!Array.isArray(options) || options.some((o) => typeof o !== 'string')) {
            throw new ToolError(`Question ${i + 1}: "options" must be a list of strings.`);
        }
        const custom = q.allow_custom_input !== false;
        const opts = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, ASK_MAX_OPTIONS);
        if (!opts.length && !custom) throw new ToolError(`Question ${i + 1} offers no options and no way to type an answer.`);
        let id = typeof q.id === 'string' && q.id.trim() ? q.id.trim().slice(0, 60) : `q${i + 1}`;
        while (seen.has(id)) id += '_';
        seen.add(id);
        return {
            id,
            header: typeof q.header === 'string' ? q.header.trim().slice(0, 40) : '',
            question: q.question.trim(),
            options: opts,
            multi: q.multi_select === true,
            custom,
        };
    });
}

/**
 * The tool result for the user's reply: { answers: { id: { picked:[...], text } } }
 * or { declined: true, note? }.
 */
export function formatAnswers(questions, reply) {
    if (!reply || reply.declined) {
        return `The user dismissed the question${questions.length > 1 ? 's' : ''} without answering${reply?.note ? `, saying: ${reply.note}` : ''}. `
            + 'Carry on with your best judgment and say what you assumed, or ask differently.';
    }
    const lines = questions.map((q) => {
        const a = reply.answers?.[q.id] || {};
        const parts = [...(a.picked || [])];
        if (a.text?.trim()) parts.push(`${a.text.trim()} (typed by the user)`);
        const label = q.header && q.header !== q.id ? `${q.id} (${q.header})` : q.id;
        return `- ${label}: ${parts.length ? parts.join('; ') : '(no answer)'}`;
    });
    return `The user answered:\n${lines.join('\n')}`;
}

/** Every tool name the page can offer, for settings. */
export const ALL_TOOL_NAMES = [...TOOL_DEFS.map((d) => d.name), SKILL_TOOL, DELEGATE_TOOL, ASK_TOOL];

/* Names compared without case or separators: bash, BASH, Ask-User, askUser. */
const nameKey = (name) => String(name ?? '').toLowerCase().replace(/[\s_-]+/g, '');

/** A tool name as the model wrote it, as one of `names`; the name itself if none matches. */
export function resolveToolName(name, names = ALL_TOOL_NAMES) {
    if (names.includes(name)) return name;
    const key = nameKey(name);
    return names.find((n) => nameKey(n) === key) ?? name;
}

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
        if (spec.type === 'array' && !Array.isArray(value)) return `"${key}" must be a list`;
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
 * Any tool's result, cut to `max` characters before it goes to the model, so one
 * call can't fill the context. Mostly the start is kept, and some of the end.
 */
export function limitToolOutput(text, max) {
    if (!(max > 0) || text.length <= max) return text;
    const tail = Math.floor(max / 4);
    const head = max - tail;
    return `${text.slice(0, head)}\n[... ${(text.length - head - tail).toLocaleString()} characters omitted: this result was `
        + `${text.length.toLocaleString()} characters, over the ${max.toLocaleString()}-character limit for one tool result. `
        + 'Read files in parts (offset, limit), and narrow command output (grep, head, tail, or into a file to read in parts).]\n'
        + `${text.slice(-tail)}`;
}

/* Exported variables a shell doesn't carry: the job's own, and the directory,
 * which the shell's cwd already holds. */
const ENV_SKIP = new Set(['PWD', 'OLDPWD', 'SHLVL', 'AGENT_DIR', '_']);

/** `export -p` output, less what ENV_SKIP names: what a shell carries to its next call. */
export function shellEnv(text) {
    // One entry per `export NAME=...`; a quoted value can span lines.
    return text.split(/\n(?=(?:export|declare -x) )/)
        .filter((entry) => {
            const m = entry.match(/^(?:export|declare -x) ([A-Za-z_]\w*)/);
            return m && !ENV_SKIP.has(m[1]);
        })
        .join('\n').replace(/\n*$/, '\n');
}

/** A valid environment variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A shell's `env` script with the user's variables (`vars`, name -> value) set
 * last, so they hold at the start of every command. Exports of names in
 * `managed` (every name the user has set this session, `vars`' included) are
 * dropped from the shell's own first: a variable the user changed or removed
 * mustn't come back from what an earlier command exported.
 */
export function withUserEnv(shellScript, vars, managed) {
    const kept = (shellScript || '').split(/\n(?=(?:export|declare -x) )/).filter((entry) => {
        const m = entry.match(/^(?:export|declare -x) ([A-Za-z_]\w*)/);
        return m && !managed.has(m[1]);
    });
    const mine = Object.entries(vars).filter(([k]) => ENV_NAME.test(k)).map(([k, v]) => `export ${k}=${shQuote(v)}`);
    const out = [...kept, ...mine].join('\n');
    return out ? `${out.replace(/\n*$/, '')}\n` : null;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write']);

/**
 * Bind the tools to a bridge.
 *
 * The bridge can be a promise of one, so the model can be connected while the VM
 * still boots: a call then waits up to `readyTimeoutMs` for it, and otherwise
 * returns an error result the model can act on, having run nothing.
 *
 * Shells: Bash runs in a named shell, which keeps a working directory and the
 * exported variables between calls; every other tool resolves relative paths
 * against the caller's own shell. The object returned uses the shell `main`;
 * `forShell(name)` gives the same tools with another default shell (a
 * sub-agent's), which starts as a copy of this one. Bash's `shell` input picks
 * any other, made the same way on first use.
 *
 * `skills` (a SkillLibrary, or anything with list() and load(id)) adds the `skill`
 * tool while it holds skills. That tool reads the skills volume from the page, so
 * it doesn't need or wait for the VM.
 *
 * `ask(questions, ctx)` adds the ask_user tool: it shows the questions (see
 * askQuestions) and resolves to the user's reply (see formatAnswers).
 *
 * `delegate(input, ctx)` adds the Delegate tool; it runs a sub-agent and resolves
 * to its report (see createDelegate in Agent.js). `isEnabled(name)` hides tools
 * the user turned off: they leave the list and refuse to run.
 *
 * `files`, if given, serves Read, Edit and Write of paths on the page's JS volumes
 * (the workspace and the skills) from the page, with no guest round trip and no
 * wait for a booting VM: { route(absPath) -> { volume, path } | null,
 * list(volume, dir), get(volume, path), put(volume, path, bytes) }, the VM's
 * volume operations. A path it doesn't route goes to the guest as before.
 *
 * `bashTimeoutMs()` is Bash's default timeout, read at each call and in its
 * description.
 *
 * `sync()`, if given, is awaited before and after every call that touches the VM
 * (linked folders are brought up to date then); its failures are ignored.
 *
 * `env()` gives the user's environment variables (name -> value), read at each
 * Bash call and set in every shell after its own exports (see withUserEnv).
 * @param {{exec:Function}|Promise<{exec:Function}>} bridgeOrPromise
 */
export function createTools(bridgeOrPromise, {
    cwd = DEFAULT_CWD, readyTimeoutMs = READY_TIMEOUT_MS, skills = null, delegate = null, ask = null, isEnabled = () => true,
    sync = null, files = null, bashTimeoutMs = () => BASH_DEFAULT_MS, env = () => ({}),
} = {}) {
    const syncQuietly = async () => { try { await sync?.(); } catch { /* the call still runs */ } };
    // Every variable name the user has set while these tools lived (see withUserEnv).
    const managedEnv = new Set();
    const userEnv = () => {
        let vars = {};
        try { vars = env() || {}; } catch { /* none */ }
        for (const k of Object.keys(vars)) managedEnv.add(k);
        return vars;
    };

    /* name -> { name, cwd, env }: env is the shell's exported variables, as a script. */
    const shells = new Map();
    const shellOf = (name, from = null) => {
        let sh = shells.get(name);
        if (!sh) {
            sh = { name, cwd: from?.cwd ?? cwd, env: from?.env ?? null };
            shells.set(name, sh);
        }
        return sh;
    };
    shellOf(DEFAULT_SHELL);

    const defaultTimeout = () => {
        const n = bashTimeoutMs();
        return Number.isInteger(n) && n >= 1000 ? Math.min(n, BASH_MAX_MS) : BASH_DEFAULT_MS;
    };
    const defs = () => {
        // Only the skills the user has left on (a SkillLibrary has enabled()).
        const skill = skills && skillToolDef(skills.enabled ? skills.enabled() : skills.list());
        const base = TOOL_DEFS.map((d) => (d.name === 'Bash' ? bashDef(defaultTimeout()) : d));
        return [...base, skill, delegate && DELEGATE_DEF, ask && ASK_DEF].filter((d) => d && isEnabled(d.name));
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
        // Timed on pauses.now(): time the browser had the page stopped doesn't count.
        const until = pauses.now() + readyTimeoutMs;
        const gaveUp = await Promise.race([
            bridgeReady.then(() => null),
            new Promise((resolve) => {
                const check = () => {
                    const left = until - pauses.now();
                    if (left <= 0) resolve('timeout');
                    else timer = setTimeout(check, left);
                };
                check();
            }),
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
    const abs = (p, sh) => {
        const full = p.startsWith('/') ? p : `${sh.cwd}/${p}`;
        const segments = full.split('/').filter((s) => s && s !== '.');
        return `/${segments.join('/')}`;
    };

    /* A path on a JS volume, served from the page. `..` is left to the guest,
     * which knows what the path's parents really are. */
    const route = (path) => {
        if (!files || path.split('/').includes('..')) return null;
        try { return files.route(path) || null; } catch { return null; }
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
        const r = await bridge.exec({ timeoutMs: FS_TIMEOUT_MS, ...opts, script: body });
        if (r.aborted) throw new ToolError('Stopped by the user.');
        if (r.timedOut) throw new ToolError(`Timed out after ${Math.round((opts?.timeoutMs || FS_TIMEOUT_MS) / 1000)} s.`);
        return r;
    };

    /* The volume's entry for a routed path: null if it doesn't exist. */
    const volumeEntry = async (r) => {
        const cut = r.path.lastIndexOf('/');
        const name = r.path.slice(cut + 1);
        if (!name) return { dir: true };   // the volume's root
        const list = await files.list(r.volume, r.path.slice(0, cut) || '/');
        return list?.find((e) => e.name === name) || null;
    };

    /** Fetch a whole file's bytes, with the guest (or the volume) explaining any failure. */
    const fetchFile = async (path, signal) => {
        const routed = route(path);
        if (routed) {
            const e = await volumeEntry(routed);
            if (!e) throw new ToolError(`File does not exist: ${path}`);
            if (e.dir) throw new ToolError(`Path is a directory, not a file: ${path}`);
            if (e.size > READ_MAX_BYTES) throw new ToolError(`File is too large to read: ${e.size} bytes`);
            const bytes = await files.get(routed.volume, routed.path);
            if (!bytes) throw new ToolError(`File does not exist: ${path}`);
            return bytes;
        }
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
        const routed = route(path);
        if (routed) {
            if ((await volumeEntry(routed))?.dir) throw new ToolError(`Path is a directory, not a file: ${path}`);
            const rc = await files.put(routed.volume, routed.path, bytes);
            // A parent that is a file, say.
            if (typeof rc === 'number' && rc < 0) throw new ToolError(`Could not write ${path} (error ${-rc}).`);
            return;
        }
        const q = shQuote(path);
        const parent = shQuote(path.replace(/\/[^/]*$/, '') || '/');
        const r = await script(`mkdir -p ${parent} && cat "$AGENT_DIR/data" >${q}`, { inputs: { data: bytes }, signal });
        if (r.rc !== 0) throw new ToolError(DEC.decode(r.out).trim() || `Could not write ${path}.`);
    };

    const handlers = {
        async Read({ path, offset, limit }, { signal }, sh) {
            const target = abs(path, sh);
            const bytes = await inOrder(target, () => fetchFile(target, signal));
            if (bytes.includes(0)) throw new ToolError(`Binary file (${bytes.length} bytes); use Bash to inspect it.`);
            return formatLines(DEC.decode(bytes), offset, limit);
        },

        async Edit({ path, old_string, new_string }, { signal }, sh) {
            if (old_string === '') throw new ToolError('old_string must not be empty; use Write to create a file.');
            if (old_string === new_string) throw new ToolError('old_string and new_string are identical.');
            const target = abs(path, sh);
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

        async Write({ path, content }, { signal }, sh) {
            const target = abs(path, sh);
            const bytes = ENC.encode(content);
            await inOrder(target, () => storeFile(target, bytes, signal));
            return `Wrote ${bytes.length} bytes to ${target}.`;
        },

        async Glob({ pattern, path = '.' }, { signal }, sh) {
            const root = abs(path, sh);
            const q = shQuote(root);
            const r = await script(
                `[ -d ${q} ] || { echo "Not a directory: "${q}; exit 3; }\nfind ${q} ${PRUNE} -type f -print 2>/dev/null; exit 0`,
                { cwd: sh.cwd, timeoutMs: SEARCH_TIMEOUT_MS, signal },
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

        async Grep({ pattern, path = '.', include }, { signal }, sh) {
            const target = shQuote(abs(path, sh));
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
                { cwd: sh.cwd, timeoutMs: SEARCH_TIMEOUT_MS, signal },
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

        async Bash({ command, timeout, run_in_background = false, shell }, { signal, onOutput }, own) {
            if (shell !== undefined && !SHELL_NAME.test(shell)) {
                throw new ToolError('shell must be 1 to 40 letters, digits, dots, dashes or underscores.');
            }
            const sh = shell ? shellOf(shell, own) : own;
            const envScript = withUserEnv(sh.env, userEnv(), managedEnv);
            const env = envScript ? { env: envScript } : {};
            if (run_in_background) {
                // Its own session, so it outlives this call and can be killed as a group.
                // It inherits the shell's exported variables.
                const r = await script(
                    `J=$(mktemp -d /tmp/agent-job.XXXXXX) || exit 1
cp "$AGENT_DIR/command" "$J/command"
setsid sh -c 'sh "$1/command" >"$1/out" 2>&1 </dev/null; echo $? >"$1/rc"' sh "$J" </dev/null >/dev/null 2>&1 &
echo "$! $J"`,
                    { cwd: sh.cwd, inputs: { command, ...env }, signal },
                );
                const [pid, dir] = DEC.decode(r.out).trim().split(' ');
                if (r.rc !== 0 || !dir) throw new ToolError(DEC.decode(r.out).trim() || 'Could not start the command.');
                return `Started in the background${shell ? ` from the shell ${shell}` : ''}.\nOutput: ${dir}/out\nExit code: ${dir}/rc (exists once it has finished)\nTo stop it: kill -TERM -${pid}`;
            }
            const timeoutMs = Math.min(Math.max(1000, timeout ?? defaultTimeout()), BASH_MAX_MS);
            const streamDec = new TextDecoder();
            const startedIn = sh.cwd;
            const startedEnv = sh.env;
            const r = await bridge.exec({
                script: command,
                cwd: startedIn,
                timeoutMs,
                inputs: env,
                outputs: ['env.after'],
                signal,
                onOutput: onOutput && ((chunk) => onOutput(streamDec.decode(chunk, { stream: true }))),
            });
            // Only a real change counts: a parallel call that didn't cd or export
            // mustn't undo one that did.
            if (r.cwd && r.cwd !== startedIn) sh.cwd = r.cwd;
            const after = r.files?.['env.after'];
            if (after) {
                const next = shellEnv(DEC.decode(after));
                if (next !== (startedEnv ?? next)) sh.env = next;
                else sh.env ??= next;
            }
            // Long output is cut by the agent (limitToolOutput), like every tool's result.
            let text = DEC.decode(r.out);
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

    /* One call, in the shell `sh` (the caller's own). */
    async function runTool(name, input, ctx, sh) {
        const def = defs().find((d) => d.name === name);
        if (!def) return notOffered(name);
        // The single-question form some models write: one entry of the batch.
        if (name === ASK_TOOL && input && typeof input === 'object' && !input.questions && typeof input.question === 'string') {
            input = { questions: [{ id: 'answer', ...input }] };
        }
        const problem = validateInput(def.input_schema, input);
        if (problem) return { content: `Invalid input: ${problem}.`, isError: true };
        try {
            if (name === ASK_TOOL) {
                const questions = askQuestions(input);
                return { content: formatAnswers(questions, await ask(questions, ctx)), isError: false };
            }
            if (name === SKILL_TOOL || name === DELEGATE_TOOL) {
                // Neither needs the VM: a sub-agent's own calls wait for it.
                try {
                    const content = name === SKILL_TOOL ? await skills.load(input.name) : await delegate(input, ctx);
                    return { content, isError: false };
                } catch (e) {
                    throw new ToolError(e.message);
                }
            }
            // A file on a JS volume needs no guest, so it doesn't wait for one.
            if (!(FILE_TOOLS.has(name) && route(abs(input.path, sh)))) {
                await waitForBridge(ctx);
                if (bootError) throw new ToolError(`The VM failed to boot (${bootError.message}), so no tool can run.`);
            }
            await syncQuietly();
            try {
                return { content: await handlers[name](input, ctx, sh), isError: false };
            } finally {
                await syncQuietly();
            }
        } catch (e) {
            const message = e instanceof ToolError ? e.message : `Tool failed: ${e.message}`;
            return { content: message, isError: true };
        }
    }

    /* The tools as one agent sees them: its default shell, and the tools it may not use. */
    const view = (shellName, exclude) => ({
        /** Read afresh for each turn: skills and settings change the list. */
        get defs() { return defs().filter((d) => !exclude.includes(d.name)); },
        get cwd() { return shellOf(shellName).cwd; },
        get shell() { return shellName; },

        /**
         * Run one tool call. Never throws for a tool failure: those are results the
         * model should see and recover from.
         * @returns {Promise<{content:string, isError:boolean}>}
         */
        run(name, input, ctx = {}) {
            name = resolveToolName(name);
            if (exclude.includes(name)) return Promise.resolve({ content: `The ${name} tool is not available here.`, isError: true });
            return runTool(name, input, ctx, shellOf(shellName));
        },

        /** The tool a call means: names match without case or separators (bash → Bash). */
        resolve(name) { return resolveToolName(name); },

        /**
         * The same tools, sharing the shells and file ordering, minus `exclude`:
         * what a sub-agent gets, so it can't delegate in turn.
         */
        without(...more) { return view(shellName, [...exclude, ...more]); },

        /** The same tools with `name` as the default shell, made from this one's if new. */
        forShell(name) {
            shellOf(name, shellOf(shellName));
            return view(name, exclude);
        },

        /** Every shell so far, for display. */
        shells() { return [...shells.values()].map((s) => ({ name: s.name, cwd: s.cwd })); },
    });
    return view(DEFAULT_SHELL, []);
}
