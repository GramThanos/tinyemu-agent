// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Tool tests without a VM: the same scripts a guest would run are run by the
 * local POSIX shell against a temp directory, through a stand-in for GuestBridge.
 * Run: node tests/tools.test.mjs   (needs sh, find, grep on PATH)
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createTools, expandBraces, formatLines, globMatcher, shellEnv, shQuote, withUserEnv, truncateOutput, validateInput, TOOL_DEFS,
    ASK_TOOL, askQuestions, formatAnswers, lastLines, limitToolOutput, resolveToolName,
} from '../js/tools.js';
import { pauses } from '../js/pause.js';
import { PERIOD_S, toneSamples } from '../js/keepAwake.js';
import {
    commandWord, contextBreakdown, emptyFigures, figuresShape, figuresSummary, parseRateLimits, recordExchange,
    recordSubAgent, usageSummary,
} from '../js/figures.js';
import { parseHealth } from '../js/GuestBridge.js';
import { createJsBash } from '../js/bashjs.js';
import { parseToolCalls, stripThinking, VisibleTextFilter } from '../js/providers/toolProtocol.js';
import { WebLLMProvider } from '../js/providers/webllm.js';
import { apiError, listOpenAIModels, mergeCall, OpenAICompatProvider, openAIUsage } from '../js/providers/openai.js';
import {
    Agent, createDelegate, INTERRUPTED, isNetworkError, NETWORK_RETRIES, NETWORK_RETRY_MS, networkRetryDelay,
    renderPrompt, subagentPrompt, SUBAGENT_PROMPT, SYSTEM_PROMPT } from '../js/Agent.js';
import { DELEGATE_TOOL } from '../js/tools.js';
import { LinkedFolders } from '../js/LinkedFolders.js';
import {
    expandSkillMentions, groupSkillFiles, parseFrontmatter, parseSkillFile, SkillLibrary, SKILL_TOOL, SKILLS_VOLUME,
} from '../js/skills.js';
import { Fs9pStore } from '../deps/jsLab/lib/volumes/Fs9pStore.js';
import { agentConfig, distroLabel, parseManifest } from '../js/distros.js';
import { parseConfig, resolveConfigFiles, stringifyConfig } from '../deps/jsLab/lib/vm/TinyemuConfig.js';
import { compactedMessage, isContextOverflow, renderTranscript } from '../js/compaction.js';
import { ClaudeProvider } from '../js/providers/claude.js';

const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const SH = process.env.TEST_SH || 'sh';

/* Unix-style path of a Windows temp directory, as the local sh sees it. */
function shPath(dir) {
    if (process.platform !== 'win32') return dir;
    const r = spawnSync(SH, ['-c', 'cd "$1" && pwd', 'sh', posix(dir)], { encoding: 'utf8' });
    return r.stdout.trim() || posix(dir);
}

let requests = 0;

class LocalBridge {
    constructor(work) { this.work = work; }

    async exec({ script, cwd = '/', inputs = {}, outputs = [], onOutput }) {
        const dir = join(this.work, `req${++requests}`);
        mkdirSync(dir);
        for (const [k, v] of Object.entries(inputs)) writeFileSync(join(dir, k), v);
        writeFileSync(join(dir, 'script'), script);
        // Git Bash has no setsid; the guest's busybox does.
        // As GuestBridge's JOB: env in, then the script, then cwd and env out.
        const wrapper = `command -v setsid >/dev/null || setsid() { "$@"; }; cd "$1" 2>/dev/null || cd /; export AGENT_DIR="$2"; trap 'pwd >"$AGENT_DIR/cwd.after"; export -p >"$AGENT_DIR/env.after"' EXIT; [ -f "$AGENT_DIR/env" ] && . "$AGENT_DIR/env" >/dev/null 2>&1; . "$AGENT_DIR/script"`;
        const r = spawnSync(SH, ['-c', wrapper, 'sh', cwd, shPath(dir)], { encoding: 'buffer' });
        const out = Buffer.concat([r.stdout, r.stderr]);
        if (out.length) onOutput?.(new Uint8Array(out));
        const files = {};
        for (const name of outputs) {
            try { files[name] = new Uint8Array(readFileSync(join(dir, name))); } catch { files[name] = null; }
        }
        let after = null;
        try { after = readFileSync(join(dir, 'cwd.after'), 'utf8').trim(); } catch { /* none */ }
        return { rc: r.status, out: new Uint8Array(out), cwd: after, timedOut: false, aborted: false, overflow: false, files };
    }
}

const base = mkdtempSync(join(tmpdir(), 'agent-tools-'));
const work = join(base, 'work');
const root = join(base, 'root');
mkdirSync(work);
mkdirSync(join(root, 'src', 'deep'), { recursive: true });
mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\ngamma\n');
writeFileSync(join(root, 'src', 'main.ts'), 'const x = "needle";\n');
writeFileSync(join(root, 'src', 'deep', 'util.js'), 'needle();\nother();\n');
writeFileSync(join(root, 'src', 'notes.py'), 'needle = 1\n');
writeFileSync(join(root, 'node_modules', 'x', 'skip.js'), 'needle\n');
writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
writeFileSync(join(root, "it's quoted.txt"), 'ok\n');

const rootSh = shPath(root);
const tools = createTools(new LocalBridge(work), { cwd: rootSh });
const run = (name, input) => tools.run(name, input);

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; } catch (e) {
        console.error(`FAIL ${name}\n`, e);
        process.exitCode = 1;
    }
}

/* ---- pure helpers ------------------------------------------------------ */

await test('shQuote survives a single quote', () => {
    assert.equal(shQuote(`a'b`), `'a'\\''b'`);
});

await test('glob semantics', () => {
    const m = (p, s) => globMatcher(p)(s);
    assert.ok(m('**/*.ts', 'a.ts'));
    assert.ok(m('**/*.ts', 'x/y/a.ts'));
    assert.ok(!m('*.ts', 'x/a.ts'));
    assert.ok(m('src/**', 'src/x/y'));
    assert.ok(m('*.{ts,js}', 'a.js'));
    assert.ok(m('a?c', 'abc'));
    assert.ok(!m('a?c', 'a/c'));
    assert.ok(m('[ab].txt', 'b.txt'));
    assert.ok(!m('[!ab].txt', 'b.txt'));
    assert.ok(!m('a.txt', 'aXtxt'));
    assert.deepEqual(expandBraces('{a,b}{c,d}'), ['ac', 'ad', 'bc', 'bd']);
});

await test('formatLines numbers, pages and truncates', () => {
    assert.equal(formatLines('a\nb\n'), '     1\ta\n     2\tb');
    assert.match(formatLines('a\nb\nc\n', 2, 1), /^ {5}2\tb\n\[showing lines 2-2 of 3/);
    assert.match(formatLines('a\n', 9), /past the end/);
    assert.equal(formatLines(''), '(empty file)');
    assert.match(formatLines('x'.repeat(2500)), /line truncated/);
});

await test('truncateOutput keeps both ends', () => {
    const t = truncateOutput('a'.repeat(100) + 'b'.repeat(100), 20);
    assert.ok(t.startsWith('aaaaaaaaaa') && t.endsWith('bbbbbbbbbb') && t.includes('omitted'));
});

await test('validateInput rejects what the model can get wrong', () => {
    const { input_schema: s } = TOOL_DEFS.find((d) => d.name === 'Read');
    assert.equal(validateInput(s, { path: 'x' }), null);
    assert.match(validateInput(s, {}), /missing/);
    assert.match(validateInput(s, { path: 1 }), /string/);
    assert.match(validateInput(s, { path: 'x', limit: 1.5 }), /integer/);
    assert.match(validateInput(s, { path: 'x', nope: 1 }), /unknown/);
    assert.match(validateInput(s, null), /object/);
});

await test('tool-call parsing', () => {
    const r = parseToolCalls('Sure.\n<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>');
    assert.equal(r.text, 'Sure.');
    assert.deepEqual(r.calls, [{ name: 'Bash', input: { command: 'ls' } }]);
    assert.equal(parseToolCalls('<tool_call>{"name":"Read","arguments":{"path":"a"}}').calls[0].name, 'Read');
    assert.match(parseToolCalls('<tool_call>{oops}</tool_call>').calls[0].error, /Could not parse/);
    assert.equal(parseToolCalls('no calls').calls.length, 0);
    assert.equal(stripThinking('<think>hmm</think>\nHi'), 'Hi');
    assert.equal(stripThinking('<think>cut off'), '');
});

await test('visible-text filter hides markup split across chunks', () => {
    let seen = '';
    const f = new VisibleTextFilter((t) => { seen += t; });
    for (const c of ['Hel', 'lo <to', 'ol_call>{"na', 'me":"x"}</tool', '_call> a<b <thi', 'nk>x</think>done']) f.push(c);
    f.end();
    assert.equal(seen, 'Hello  a<b done');
});

/* ---- tools against a real shell ---------------------------------------- */

await test('Read numbers lines and honours offset and limit', async () => {
    const r = await run('Read', { path: 'a.txt', offset: 2, limit: 1 });
    assert.equal(r.isError, false);
    assert.match(r.content, /^ {5}2\tbeta\n\[showing lines 2-2 of 3/);
});

await test('Read reports missing files, directories and binaries', async () => {
    assert.match((await run('Read', { path: 'nope' })).content, /does not exist/);
    assert.match((await run('Read', { path: 'src' })).content, /directory/);
    const bin = await run('Read', { path: 'bin.dat' });
    assert.ok(bin.isError);
    assert.match(bin.content, /Binary/);
});

await test('paths are quoted, not interpreted', async () => {
    assert.match((await run('Read', { path: "it's quoted.txt" })).content, /ok/);
    await run('Read', { path: `x'; touch pwned; '` });
    assert.equal((await run('Read', { path: 'pwned' })).isError, true);
});

await test('Write creates parents and overwrites', async () => {
    const content = 'line "one" $HOME `x` \\n\nüñí\n';
    assert.equal((await run('Write', { path: 'new/dir/f.txt', content })).isError, false);
    assert.equal(readFileSync(join(root, 'new', 'dir', 'f.txt'), 'utf8'), content);
    await run('Write', { path: 'new/dir/f.txt', content: 'short' });
    assert.equal(readFileSync(join(root, 'new', 'dir', 'f.txt'), 'utf8'), 'short');
});

await test('Edit requires exactly one match', async () => {
    await run('Write', { path: 'e.txt', content: 'one two two $& \n' });
    assert.match((await run('Edit', { path: 'e.txt', old_string: 'zzz', new_string: 'y' })).content, /not found/);
    assert.match((await run('Edit', { path: 'e.txt', old_string: 'two', new_string: 'y' })).content, /2 times/);
    assert.match((await run('Edit', { path: 'e.txt', old_string: '', new_string: 'y' })).content, /empty/);
    assert.match((await run('Edit', { path: 'e.txt', old_string: 'one', new_string: 'one' })).content, /identical/);
    assert.equal((await run('Edit', { path: 'e.txt', old_string: 'one', new_string: '$1$&' })).isError, false);
    assert.equal(readFileSync(join(root, 'e.txt'), 'utf8'), '$1$& two two $& \n');
});

await test('Edit refuses a file that is not UTF-8', async () => {
    writeFileSync(join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    assert.match((await run('Edit', { path: 'latin.txt', old_string: 'c', new_string: 'd' })).content, /UTF-8/);
});

await test('Glob matches recursively and prunes', async () => {
    const r = await run('Glob', { pattern: '**/*.js' });
    assert.match(r.content, /src\/deep\/util\.js/);
    assert.doesNotMatch(r.content, /node_modules/);
    assert.doesNotMatch(r.content, /\/\.\//);
    assert.doesNotMatch((await run('Grep', { pattern: 'needle' })).content, /\/\.\//);
    assert.equal((await run('Glob', { pattern: '*.js', path: 'src/deep' })).content.split('\n').length, 1);
    assert.equal((await run('Glob', { pattern: '*.zzz' })).content, 'No files found.');
    assert.match((await run('Glob', { pattern: '*', path: 'a.txt' })).content, /Not a directory/);
});

await test('Grep finds lines, filters and prunes', async () => {
    const all = await run('Grep', { pattern: 'needle' });
    assert.match(all.content, /src\/main\.ts:1:/);
    assert.doesNotMatch(all.content, /node_modules/);
    const py = await run('Grep', { pattern: 'needle', include: '*.py' });
    assert.match(py.content, /notes\.py/);
    assert.doesNotMatch(py.content, /main\.ts/);
    const both = await run('Grep', { pattern: 'needle', include: '*.{py,ts}' });
    assert.match(both.content, /notes\.py/);
    assert.match(both.content, /main\.ts/);
    assert.match((await run('Grep', { pattern: 'beta', path: 'a.txt' })).content, /a\.txt:2:beta/);
    assert.equal((await run('Grep', { pattern: 'absent-text' })).content, 'No matches found.');
    assert.match((await run('Grep', { pattern: 'x', path: 'nope' })).content, /does not exist/);
    const bad = await run('Grep', { pattern: '(' });
    assert.ok(bad.isError);
    assert.match(bad.content, /Invalid regular expression/);
});

await test('Bash returns output, exit codes, and keeps the directory', async () => {
    const t = createTools(new LocalBridge(work), { cwd: rootSh });
    assert.equal((await t.run('Bash', { command: 'echo hi' })).content, 'hi\n');
    assert.equal((await t.run('Bash', { command: ': quiet' })).content, '(no output)');
    const failed = await t.run('Bash', { command: 'echo oops; exit 7' });
    assert.ok(failed.isError);
    assert.match(failed.content, /oops\n\[Exit code 7\.\]/);
    await t.run('Bash', { command: 'cd src' });
    assert.match((await t.run('Bash', { command: 'pwd' })).content, /\/src\n$/);
    assert.ok((await t.run('Read', { path: 'main.ts' })).content.includes('needle'));
});

await test('tool errors come back as results, never as exceptions', async () => {
    assert.ok((await run('Nope', {})).isError);
    assert.ok((await run('Read', { path: 5 })).isError);
    const broken = createTools({ exec: async () => { throw new Error('boom'); } });
    const r = await broken.run('Bash', { command: 'x' });
    assert.ok(r.isError);
    assert.match(r.content, /boom/);
});

/* ---- agent loop -------------------------------------------------------- */

function scripted(steps) {
    return {
        history: [],
        addUser(t) { this.history.push(['user', t]); },
        addToolResults(r) { this.history.push(['results', r]); },
        async step({ onText }) { const s = steps.shift(); if (s.text) onText(s.text); return s; },
    };
}

await test('Agent loops until the model stops and returns every result', async () => {
    const provider = scripted([
        { stop: 'tool_use', toolCalls: [
            { id: '1', name: 'Read', input: { path: 'a.txt' } },
            { id: '2', name: 'Read', input: { path: 'nope' } },
        ] },
        { stop: 'end', text: 'done' },
    ]);
    const texts = [];
    const r = await new Agent({ provider, tools, on: { text: (t) => texts.push(t) } }).send('go');
    assert.equal(r.stop, 'end');
    assert.deepEqual(texts, ['done']);
    const [, results] = provider.history[1];
    assert.deepEqual(results.map((x) => [x.id, x.isError]), [['1', false], ['2', true]]);
});

/* A bridge whose jobs stay running until the test releases them. */
function heldBridge() {
    const jobs = [];
    return {
        jobs,
        exec(job) {
            return new Promise((resolve) => {
                const finish = (extra = {}) => resolve({
                    rc: 0, out: new TextEncoder().encode(job.script), cwd: job.cwd,
                    timedOut: false, aborted: false, overflow: false, files: {}, ...extra,
                });
                job.signal?.addEventListener('abort', () => finish({ rc: 143, aborted: true }));
                jobs.push({ ...job, finish });
            });
        },
    };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

await test('stopping answers every running tool call', async () => {
    const ac = new AbortController();
    const provider = scripted([{ stop: 'tool_use', toolCalls: [
        { id: '1', name: 'Bash', input: { command: 'sleep 9' } },
        { id: '2', name: 'Bash', input: { command: 'sleep 9' } },
    ] }]);
    const bridge = heldBridge();
    const sent = new Agent({ provider, tools: createTools(bridge) }).send('go', ac.signal);
    await tick();
    assert.equal(bridge.jobs.length, 2);
    ac.abort();
    assert.equal((await sent).stop, 'aborted');
    const [, results] = provider.history[1];
    assert.deepEqual(results.map((x) => x.id), ['1', '2']);
    assert.ok(results.every((x) => x.isError && /Stopped/.test(x.content)));
});

await test('a step\'s calls run at once and results keep call order', async () => {
    const provider = scripted([
        { stop: 'tool_use', toolCalls: ['a', 'b', 'c'].map((c, i) => ({ id: String(i), name: 'Bash', input: { command: c } })) },
        { stop: 'end' },
    ]);
    const bridge = heldBridge();
    const started = [];
    const ended = [];
    const sent = new Agent({
        provider,
        tools: createTools(bridge),
        on: { toolStart: (c) => started.push(c.id), toolEnd: (c) => ended.push(c.id) },
    }).send('go');
    await tick();
    assert.deepEqual(bridge.jobs.map((j) => j.script), ['a', 'b', 'c']);   // none waited for another
    assert.deepEqual(started, ['0', '1', '2']);
    for (const i of [2, 0, 1]) { bridge.jobs[i].finish(); await tick(); }
    await sent;
    assert.deepEqual(ended, ['2', '0', '1']);
    const [, results] = provider.history[1];
    assert.deepEqual(results.map((x) => [x.id, x.content]), [['0', 'a'], ['1', 'b'], ['2', 'c']]);
});

await test('a parallel call that did not cd cannot undo one that did', async () => {
    const bridge = heldBridge();
    const t = createTools(bridge, { cwd: '/start' });
    const moved = t.run('Bash', { command: 'cd /elsewhere' });
    const stayed = t.run('Bash', { command: 'sleep 1' });
    await tick();
    bridge.jobs[0].finish({ cwd: '/elsewhere' });
    await moved;
    bridge.jobs[1].finish({ cwd: '/start' });
    await stayed;
    assert.equal(t.cwd, '/elsewhere');
});

await test('Read, Edit and Write of one file keep call order; other files do not wait', async () => {
    const t = createTools(new LocalBridge(work), { cwd: rootSh });
    await t.run('Write', { path: 'q.txt', content: 'one two' });
    const [, , read, other] = await Promise.all([
        t.run('Edit', { path: 'q.txt', old_string: 'one', new_string: '1' }),
        t.run('Edit', { path: 'q.txt', old_string: 'two', new_string: '2' }),
        t.run('Read', { path: 'q.txt' }),
        t.run('Read', { path: 'a.txt' }),
    ]);
    assert.match(read.content, /1 2/);
    assert.match(other.content, /alpha/);
    assert.equal(readFileSync(join(root, 'q.txt'), 'utf8'), '1 2');

    const bridge = heldBridge();
    const held = createTools(bridge, { cwd: '/x' });
    held.run('Write', { path: 'a', content: '1' });
    held.run('Write', { path: 'a', content: '2' });
    held.run('Write', { path: 'b', content: '3' });
    await tick();
    assert.equal(bridge.jobs.length, 2);   // the first `a` and `b`; the second `a` is queued
    assert.deepEqual(bridge.jobs.map((j) => new TextDecoder().decode(j.inputs.data)), ['1', '3']);
    bridge.jobs[0].finish();
    await tick();
    assert.equal(new TextDecoder().decode(bridge.jobs[2].inputs.data), '2');
    bridge.jobs[1].finish();
    bridge.jobs[2].finish();
});

await test('a failed file call does not block the next one', async () => {
    const t = createTools(new LocalBridge(work), { cwd: rootSh });
    const [missing, written] = await Promise.all([
        t.run('Edit', { path: 'later.txt', old_string: 'a', new_string: 'b' }),
        t.run('Write', { path: 'later.txt', content: 'x' }),
    ]);
    assert.match(missing.content, /does not exist/);
    assert.equal(written.isError, false);
});

await test('Bash run_in_background returns while the command keeps running', async () => {
    const t = createTools(new LocalBridge(work), { cwd: rootSh });
    assert.match((await t.run('Bash', { command: 'x', run_in_background: 'yes' })).content, /true or false/);
    const r = await t.run('Bash', { command: 'pwd; echo "it\'s" fine; sleep 2; exit 4', run_in_background: true });
    assert.equal(r.isError, false);
    const dir = r.content.match(/Output: (\S+)\/out/)[1];
    assert.match(r.content, /kill -TERM -\d+/);
    assert.equal((await t.run('Bash', { command: `[ -e ${dir}/rc ] || echo running` })).content, 'running\n');
    for (let i = 0; i < 100; i++) {
        if ((await t.run('Bash', { command: `[ -e ${dir}/rc ] && echo done` })).content === 'done\n') break;
        await new Promise((res) => setTimeout(res, 100));
    }
    const out = await t.run('Bash', { command: `cat ${dir}/out ${dir}/rc` });
    assert.equal(out.content, `${rootSh}\nit's fine\n4\n`);
    await t.run('Bash', { command: `rm -rf ${dir}` });
});

await test('WebLLM provider runs the text protocol through the loop', async () => {
    const replies = [
        ['<think>plan</think>Let me ', 'check.<tool_', 'call>{"name":"Read","arguments":{"path":"a.txt"}}</tool_call>'],
        ['<tool_call>{broken</tool_call>'],
        ['All done.'],
    ];
    const provider = new WebLLMProvider({ model: 'm', system: 'SYS', tools: TOOL_DEFS });
    provider.engine = {
        chat: { completions: { create: async () => (async function* () {
            for (const content of replies.shift()) yield { choices: [{ delta: { content } }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        })() } },
    };
    let shown = '';
    const r = await new Agent({ provider, tools, on: { text: (t) => { shown += t; } } }).send('go');
    assert.equal(r.stop, 'end');
    assert.equal(shown, 'Let me check.All done.');
    assert.match(provider.messages[0].content, /"name":"Grep"/);
    const responses = provider.messages.filter((m) => m.content.startsWith('<tool_response'));
    assert.match(responses[0].content, /1\talpha/);
    assert.match(responses[1].content, /error="true"[^]*Could not parse/);
    assert.ok(!provider.messages.some((m) => m.content.includes('<think>')));
});

await test('a call made while the VM boots waits for it, then runs', async () => {
    let up;
    const t = createTools(new Promise((resolve) => { up = resolve; }), { cwd: rootSh });
    let shown = '';
    const pending = t.run('Read', { path: 'a.txt' }, { onOutput: (s) => { shown += s; } });
    await new Promise((r) => setTimeout(r, 50));
    up(new LocalBridge(work));
    const r = await pending;
    assert.equal(r.isError, false);
    assert.match(r.content, /1\talpha/);
    assert.match(shown, /waiting for the VM/);
});

await test('a VM that is not ready in time gives the model an error, having run nothing', async () => {
    let ran = false;
    const late = new Promise((resolve) => setTimeout(() => resolve({ exec: async () => { ran = true; } }), 300));
    const t = createTools(late, { cwd: rootSh, readyTimeoutMs: 50 });
    const r = await t.run('Bash', { command: 'echo hi' });
    assert.equal(r.isError, true);
    assert.match(r.content, /still booting[^]*Nothing ran/);
    await late;
    assert.equal(ran, false);
});

await test('a failed boot, and Stop while waiting, end the call at once', async () => {
    const failed = createTools(Promise.reject(new Error('no kernel')), { cwd: rootSh });
    const r1 = await failed.run('Read', { path: 'a.txt' });
    assert.equal(r1.isError, true);
    assert.match(r1.content, /failed to boot \(no kernel\)/);

    const t = createTools(new Promise(() => {}), { cwd: rootSh });
    const stop = new AbortController();
    const pending = t.run('Bash', { command: ':' }, { signal: stop.signal });
    stop.abort();
    const r2 = await pending;
    assert.equal(r2.isError, true);
    assert.equal(r2.content, 'Stopped by the user.');
});

/* A fetch that answers with scripted responses: an array of SSE `data:` payloads
 * (objects, or raw strings; streamed in awkward chunks with CRLF line ends), or
 * { status, body, headers }. */
function fakeFetch(script) {
    const requests = [];
    const fetch = async (url, init = {}) => {
        requests.push({ url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
        const next = script.shift();
        if (!Array.isArray(next)) {
            return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: next.headers });
        }
        const text = next.map((d) => `data: ${typeof d === 'string' ? d : JSON.stringify(d)}\r\n\r\n`).join('');
        const bytes = new TextEncoder().encode(text);
        return new Response(new ReadableStream({
            start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
        }), { status: 200 });
    };
    return { fetch, requests };
}
const delta = (d, finish_reason = null) => ({ choices: [{ index: 0, delta: d, finish_reason }] });
async function withFetch(fetch, fn) {
    const saved = globalThis.fetch;
    globalThis.fetch = fetch;
    try { await fn(); } finally { globalThis.fetch = saved; }
}

await test('OpenAI-compatible provider streams, runs calls and keeps extra fields', async () => {
    const sig = { google: { thought_signature: 'SIG1' } };
    const { fetch, requests } = fakeFetch([
        [delta({ role: 'assistant', reasoning_content: 'Plan' }),
         delta({ content: 'Reading.' }),
         // arguments split across chunks; Gemini's signature rides on the call
         delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"pa' }, extra_content: sig }] }),
         delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
         delta({ tool_calls: [{ index: 1, type: 'function', function: { name: 'Bash', arguments: '{"command":"exit 3"}' } }] }),
         delta({ tool_calls: [{ index: 2, id: 'c3', type: 'function', function: { name: 'Read', arguments: '{"path":' } }] }, 'tool_calls'),
         '[DONE]'],
        [delta({ content: 'All ' }), delta({ content: 'done.' }, 'stop'), '[DONE]'],
    ]);
    await withFetch(fetch, async () => {
        const provider = new OpenAICompatProvider({ apiKey: 'KEY', baseURL: 'https://x.test/v1', model: 'm', system: 'SYS', tools: TOOL_DEFS });
        let shown = '', thought = '';
        const r = await new Agent({ provider, tools, on: { text: (t) => { shown += t; }, thinking: (t) => { thought += t; } } }).send('go');
        assert.equal(r.stop, 'end');
        assert.equal(shown, 'Reading.All done.');
        assert.equal(thought, 'Plan');
        for (const q of requests) {
            assert.equal(q.url, 'https://x.test/v1/chat/completions');
            assert.equal(q.headers.authorization, 'Bearer KEY');
            assert.equal(q.body.stream, true);
        }
        const msgs = requests[1].body.messages;
        assert.deepEqual(msgs[0], { role: 'system', content: 'SYS' });
        assert.ok(requests[0].body.tools.some((t) => t.function.name === 'Grep' && t.function.parameters.type === 'object'));
        const asst = msgs[2];
        assert.equal(asst.content, 'Reading.');
        assert.equal(asst.tool_calls[0].function.arguments, '{"path":"a.txt"}');
        assert.deepEqual(asst.tool_calls[0].extra_content, sig);
        assert.ok(asst.tool_calls[1].id, 'a call without an id gets one');
        const [read, bash, broken] = msgs.slice(3);
        assert.equal(read.tool_call_id, 'c1');
        assert.match(read.content, /1\talpha/);
        assert.equal(bash.tool_call_id, asst.tool_calls[1].id);
        assert.match(bash.content, /^Error: [^]*Exit code 3/);
        assert.match(broken.content, /^Error: The arguments were not valid JSON/);
    });
});

await test('OpenAI-compatible provider retries 503, drops a cut-off call, reports errors', async () => {
    const { fetch, requests } = fakeFetch([
        { status: 503, body: [{ error: { code: 503, message: 'The model is overloaded.' } }], headers: { 'retry-after': '0' } },
        [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"comm' } }] }, 'length'), '[DONE]'],
        { status: 400, body: [{ error: { code: 400, message: 'bad request' } }] },
    ]);
    await withFetch(fetch, async () => {
        const provider = new OpenAICompatProvider({ apiKey: 'KEY', baseURL: 'https://x.test/v1', model: 'm', system: 'SYS', tools: TOOL_DEFS });
        const r = await new Agent({ provider, tools }).send('go');
        assert.equal(r.stop, 'max_tokens');
        assert.equal(requests.length, 2);
        assert.equal(provider.messages.length, 2);   // system + user: the cut-off turn was not kept
        await assert.rejects(new Agent({ provider, tools }).send('again'), /API error 400: bad request/);
    });
});

await test('model listing keeps chat models, strips Gemini\'s prefix, needs no key locally', async () => {
    const { fetch, requests } = fakeFetch([
        { body: { object: 'list', data: [
            { id: 'models/gemini-3.8-flash', display_name: 'Gemini 3.8 Flash' },
            { id: 'models/gemini-embedding-2' },
            { id: 'models/gemini-3.8-flash-tts' },
            { id: 'models/gemini-2.5-pro' },
        ] } },
        { status: 401, body: { error: { message: 'Incorrect API key provided' } } },
    ]);
    await withFetch(fetch, async () => {
        const models = await listOpenAIModels({ baseURL: 'http://localhost:8080/v1', apiKey: '' });
        assert.deepEqual(models.map((m) => m.id), ['gemini-2.5-pro', 'gemini-3.8-flash']);
        assert.equal(models[1].label, 'Gemini 3.8 Flash (gemini-3.8-flash)');
        assert.equal(requests[0].url, 'http://localhost:8080/v1/models');
        assert.ok(!('authorization' in requests[0].headers));
        await assert.rejects(listOpenAIModels({ baseURL: 'https://x.test/v1', apiKey: 'bad' }), /API error 401: Incorrect API key/);
    });
});

await test('Agent gives up after maxSteps', async () => {
    const step = { stop: 'tool_use', toolCalls: [{ id: '1', name: 'Bash', input: { command: ':' } }] };
    const provider = scripted([step, step, step]);
    const r = await new Agent({ provider, tools, maxSteps: 2 }).send('go');
    assert.equal(r.stop, 'max_steps');
});

/* ---- skills ------------------------------------------------------------ */

/* The VM's volume operations, over the same in-memory store the engine uses. */
function fakeVM() {
    const store = new Fs9pStore(SKILLS_VOLUME, null);
    const enc = new TextEncoder();
    return {
        store,
        put(path, text) { store.putFile(path, enc.encode(text)); },
        async volumeList(vol, path) { return store.listDir(path); },
        async volumeGetFile(vol, path) { return store.getFile(path); },
        async volumePutFile(vol, path, data) { store.putFile(path, typeof data === 'string' ? enc.encode(data) : data); },
        async volumeDelete(vol, path) { if (store.removePath(path) < 0) throw new Error('no such path'); },
        async volumeMkdir(vol, path) { store._mkdirp(path); },
        async volumeFlush() {},
    };
}
const fakeFile = (text) => ({ arrayBuffer: async () => new TextEncoder().encode(text).buffer });

await test('parseSkillFile reads frontmatter and trims it off', () => {
    const { meta, body } = parseSkillFile('﻿---\r\nname: git-release\r\ndescription: "Cut a \\"release\\""\r\n'
        + 'other: x # a comment\r\n---\r\n\r\n# Steps\r\n\r\n1. tag\r\n\r\n');
    assert.deepEqual(meta, { name: 'git-release', description: 'Cut a "release"', other: 'x' });
    assert.equal(body, '# Steps\n\n1. tag');
    assert.equal(parseFrontmatter('description: >\n  one\n  two\nname: n').description, 'one two');
    assert.equal(parseFrontmatter('description: |\n  one\n  two\n').description, 'one\ntwo');
    assert.equal(parseFrontmatter('description: plain\n  continued').description, 'plain continued');
    assert.equal(parseFrontmatter("name: 'it''s'").name, "it's");
    assert.deepEqual(parseSkillFile('---\n---\nbody'), { meta: {}, body: 'body' });
    assert.deepEqual(parseSkillFile('no frontmatter\n'), { meta: {}, body: 'no frontmatter' });
});

await test('expandSkillMentions replaces known @ids only, on their own lines', async () => {
    const load = async (id) => `<${id} body>`;
    const ids = ['git', 'git-release', 'pdf.parser'];
    const r = await expandSkillMentions('use @git-release and @git, not me@git or @gitx or @nope; @pdf.parser.', ids, load);
    assert.equal(r.text, 'use \n<git-release body>\n and \n<git body>\n, not me@git or @gitx or @nope; \n<pdf.parser body>\n.');
    assert.deepEqual(r.used, ['git-release', 'git', 'pdf.parser']);
    assert.deepEqual(await expandSkillMentions('plain', ids, load), { text: 'plain', used: [] });
    assert.deepEqual(await expandSkillMentions('@git', [], load), { text: '@git', used: [] });
});

await test('groupSkillFiles finds every skill folder in a pick', () => {
    const f = fakeFile('');
    const { skills, problems } = groupSkillFiles([
        { rel: 'all/a/SKILL.md', file: f }, { rel: 'all/a/scripts/run.sh', file: f },
        { rel: 'all/a/examples/x/SKILL.md', file: f },   // belongs to a
        { rel: 'all/b/skill.md', file: f }, { rel: 'all/b' },
        { rel: 'all/README.md', file: f },               // in no skill
        { rel: 'all/bad name/SKILL.md', file: f },
    ]);
    assert.deepEqual(skills.map((s) => [s.id, s.files.map((x) => x.path)]), [
        ['a', ['/SKILL.md', '/scripts/run.sh', '/examples/x/SKILL.md']],
        ['b', ['/SKILL.md']],
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /bad name/);
    assert.match(groupSkillFiles([{ rel: 'x.txt', file: f }]).problems[0], /No SKILL\.md/);
    assert.match(groupSkillFiles([{ rel: 'SKILL.md', file: f }]).problems[0], /inside its skill's folder/);
});

await test('SkillLibrary scans, imports, removes and feeds the skill tool', async () => {
    const vm = fakeVM();
    vm.put('/old/SKILL.md', '---\nname: Old one\ndescription: Does old things.\n---\nOld body\n');
    vm.put('/notes/readme.txt', 'not a skill');
    const lib = new SkillLibrary();
    const seen = [];
    lib.onChange((list) => seen.push(list.map((s) => s.id)));
    lib.setVM(vm);
    assert.deepEqual(await lib.refresh(), [{ id: 'old', name: 'Old one', description: 'Does old things.' }]);

    const r = await lib.import([
        { rel: 'new/SKILL.md', file: fakeFile('---\nname: new\ndescription: New things.\n---\n\nNew body\n') },
        { rel: 'new/run.sh', file: fakeFile('echo hi') },
    ]);
    assert.deepEqual(r, { imported: ['new'], problems: [] });
    assert.equal(new TextDecoder().decode(vm.store.getFile('/new/run.sh')), 'echo hi');
    assert.deepEqual(lib.list().map((s) => s.id), ['new', 'old']);
    assert.deepEqual(seen, [['old'], ['new', 'old']]);

    const t = createTools(new Promise(() => {}), { skills: lib });   // a VM that never boots
    const def = t.defs.find((d) => d.name === SKILL_TOOL);
    assert.deepEqual(def.input_schema.properties.name.enum, ['new', 'old']);
    assert.match(def.description, /- old \(Old one\): Does old things\./);
    assert.deepEqual(await t.run('skill', { name: 'new' }), {
        content: '[Loaded skill: new]\nBase directory: /agent/skills/new\n\n---\n\nNew body', isError: false,
    });
    assert.match((await t.run('skill', { name: 'gone' })).content, /must be one of: new, old/);

    // Edited in the guest: the next load reads it afresh.
    vm.put('/new/SKILL.md', 'Changed body');
    assert.match((await t.run('skill', { name: 'new' })).content, /---\n\nChanged body$/);

    await lib.remove('new');
    await lib.remove('old');
    assert.equal(t.defs.some((d) => d.name === SKILL_TOOL), false);
    assert.deepEqual(t.defs, TOOL_DEFS);
});

await test('a skill turned off is not offered, loaded or expanded', async () => {
    const vm = fakeVM();
    vm.put('/a/SKILL.md', '---\ndescription: A.\n---\nA body');
    vm.put('/b/SKILL.md', '---\ndescription: B.\n---\nB body');
    const off = new Set(['b']);
    const lib = new SkillLibrary({ isEnabled: (id) => !off.has(id) });
    lib.setVM(vm);
    await lib.refresh();
    assert.deepEqual(lib.list().map((s) => s.id), ['a', 'b']);
    assert.deepEqual(lib.enabled().map((s) => s.id), ['a']);
    const t = createTools(new Promise(() => {}), { skills: lib });
    const def = () => t.defs.find((d) => d.name === SKILL_TOOL);
    assert.deepEqual(def().input_schema.properties.name.enum, ['a']);
    assert.equal(def().description.includes('- b'), false);
    assert.match((await t.run('skill', { name: 'b' })).content, /must be one of: a/);
    await assert.rejects(lib.load('b'), /turned off/);
    assert.deepEqual(await lib.expandMentions('use @a and @b'), { text: 'use \nA body\n and @b', used: ['a'] });
    // Read at each use: turning it back on applies at once; all off removes the tool.
    off.delete('b');
    assert.deepEqual(def().input_schema.properties.name.enum, ['a', 'b']);
    off.add('a').add('b');
    assert.equal(def(), undefined);
});

await test('SkillLibrary lists and reads a skill\'s files', async () => {
    const vm = fakeVM();
    vm.put('/s/zeta.txt', 'z');
    vm.put('/s/SKILL.md', 'body');
    vm.put('/s/a/b/deep.sh', 'echo');
    vm.put('/s/a/b/empty/.keep', '');
    vm.put('/other/x', 'secret');
    const lib = new SkillLibrary();
    lib.setVM(vm);
    assert.deepEqual(await lib.files('s'), [
        { path: 'SKILL.md', size: 4 }, { path: 'a/b/deep.sh', size: 4 },
        { path: 'a/b/empty/.keep', size: 0 }, { path: 'zeta.txt', size: 1 },
    ]);
    assert.equal(new TextDecoder().decode(await lib.readFile('s', 'a/b/deep.sh')), 'echo');
    assert.equal(await lib.readFile('s', 'missing'), null);
    // Paths stay inside the skill's folder.
    assert.equal(await lib.readFile('s', '../other/x'), null);
    assert.equal(await lib.readFile('s', '/other/x'), null);
    await assert.rejects(lib.files('../other'), /No skill named/);
});

await test('SkillLibrary refuses to import before the VM runs', async () => {
    const r = await new SkillLibrary().import([{ rel: 's/SKILL.md', file: fakeFile('x') }]);
    assert.deepEqual(r.imported, []);
    assert.match(r.problems[0], /still starting/);
});

await test('Agent hands the provider a new tool list when the skills change', async () => {
    const vm = fakeVM();
    const lib = new SkillLibrary();
    lib.setVM(vm);
    const t = createTools(new LocalBridge(work), { cwd: rootSh, skills: lib });
    const provider = scripted([{ stop: 'end' }, { stop: 'end' }, { stop: 'end' }]);
    const sets = [];
    provider.setTools = (defs) => sets.push(defs.map((d) => d.name));
    const agent = new Agent({ provider, tools: t });
    await agent.send('one');
    vm.put('/s/SKILL.md', 'body');
    await lib.refresh();
    await agent.send('two');
    await agent.send('three');
    assert.equal(sets.length, 2);
    assert.equal(sets[0].includes('skill'), false);
    assert.equal(sets[1].at(-1), 'skill');
});

await test('providers swap their tool lists', () => {
    const one = [TOOL_DEFS[0]];
    const oa = new OpenAICompatProvider({ apiKey: '', baseURL: 'http://x', model: 'm', system: 's', tools: TOOL_DEFS });
    oa.setTools(one);
    assert.deepEqual(oa.tools.map((x) => x.function.name), ['Read']);
    const wl = new WebLLMProvider({ model: 'm', system: 'SYS', tools: TOOL_DEFS });
    wl.setTools(one);
    assert.match(wl.messages[0].content, /^SYS/);
    assert.equal(wl.messages[0].content.includes(`"name":"Bash"`), false);
    assert.ok(wl.messages[0].content.includes(`"name":"Read"`));
});

/* ---- delegate, settings, usage --------------------------------------- */

/* A provider whose forks play their own scripts, recording what they were given. */
function forkable(steps, forkScripts) {
    const p = scripted(steps);
    p.forks = [];
    p.fork = ({ system, tools: defs }) => {
        const f = scripted(forkScripts.shift());
        f.system = system;
        f.defs = defs.map((d) => d.name);
        p.forks.push(f);
        return f;
    };
    return p;
}

await test('Delegate runs a sub-agent with the tools minus Delegate and returns its report', async () => {
    const used = [];
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c) });
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL), on: { usage: (u) => used.push(u) } });
    assert.ok(t.defs.some((d) => d.name === DELEGATE_TOOL));

    const provider = forkable([
        { stop: 'tool_use', toolCalls: [{ id: 'd1', name: 'Delegate', input: { description: 'read a', prompt: 'Read a.txt' } }] },
        { stop: 'end' },
    ], [[
        { stop: 'tool_use', text: 'Looking.', toolCalls: [
            { id: 's1', name: 'Read', input: { path: 'a.txt' } },
            { id: 's2', name: 'Delegate', input: { description: 'x', prompt: 'y' } },
        ] },
        { stop: 'end', text: 'a.txt starts with alpha.' },
    ]]);
    const progress = [];
    const r = await new Agent({ provider, tools: t, on: { toolOutput: (_, s) => progress.push(s) } }).send('go');
    assert.equal(r.stop, 'end');
    const [sub] = provider.forks;
    assert.match(sub.system, /You are a sub-agent/);
    assert.equal(sub.defs.includes(DELEGATE_TOOL), false);
    assert.equal(sub.defs.includes('Read'), true);
    assert.deepEqual(sub.history[0], ['user', 'Read a.txt']);
    const subResults = sub.history[1][1];
    assert.match(subResults[0].content, /1\talpha/);
    assert.deepEqual(subResults[1], { id: 's2', content: 'The Delegate tool is not available here.', isError: true });
    const main = provider.history[1][1][0];
    assert.deepEqual(main, { id: 'd1', content: 'a.txt starts with alpha.', isError: false });
    assert.equal(progress.join(''), 'Looking.\n▸ Read a.txt\n▸ Delegate x\n'
        + '  ✗ Delegate: The Delegate tool is not available here.\na.txt starts with alpha.');
});

await test('Delegate reports a sub-agent that stops early, and needs a forkable provider', async () => {
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c) });
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL), maxSteps: 1 });
    const call = { description: 'loop', prompt: 'p' };
    const step = { stop: 'tool_use', text: 'Partial findings.', toolCalls: [{ id: 's', name: 'Bash', input: { command: ':' } }] };
    // Out of steps: asked for its report once more, which is all the caller gets.
    const p1 = forkable([], [[step, { stop: 'end', text: 'Final report.' }]]);
    const r1 = await t.run('Delegate', call, { provider: p1 });
    assert.deepEqual(r1, { content: 'Final report.', isError: false });
    assert.match(p1.forks[0].history.at(-1)[1], /used all the steps[\s\S]*final report/);
    // When that fails too, the last thing it said is kept.
    const r1b = await t.run('Delegate', call, { provider: forkable([], [[step, { stop: 'refusal', detail: 'no' }]]) });
    assert.deepEqual(r1b, { content: 'Partial findings.\n\n[The sub-agent stopped early: no]', isError: false });
    const r2 = await t.run('Delegate', call, { provider: forkable([], [[{ stop: 'refusal', detail: 'no' }]]) });
    assert.deepEqual(r2, { content: 'The sub-agent stopped without a report: no', isError: true });
    const r3 = await t.run('Delegate', call, { provider: scripted([]) });
    assert.match(r3.content, /cannot start a sub-agent/);
    assert.equal(r3.isError, true);
});

await test('turned-off tools leave the list and refuse to run', async () => {
    const off = new Set(['Bash', DELEGATE_TOOL]);
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: async () => 'x', isEnabled: (n) => !off.has(n) });
    assert.deepEqual(t.defs.map((d) => d.name), ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    assert.deepEqual(await t.run('Bash', { command: 'echo hi' }), { content: 'The Bash tool is turned off.', isError: true });
    assert.deepEqual(await t.run('Nope', {}), { content: 'Unknown tool: Nope', isError: true });
    off.delete('Bash');
    assert.equal((await t.run('Bash', { command: 'echo hi' })).content, 'hi\n');
    assert.deepEqual(t.without('Read').defs.map((d) => d.name), ['Edit', 'Write', 'Glob', 'Grep', 'Bash']);
});

await test('usage reaches the agent, normalized from OpenAI-style responses', async () => {
    assert.deepEqual(openAIUsage({
        prompt_tokens: 100, completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 25 },
    }), { input: 40, cacheWrite: 0, cacheRead: 60, output: 40, thinking: 25 });
    assert.deepEqual(openAIUsage({ prompt_tokens: 5, completion_tokens: 2 }),
        { input: 5, cacheWrite: 0, cacheRead: 0, output: 2, thinking: null });

    const { fetch, requests } = fakeFetch([[
        delta({ content: 'Hi.' }, 'stop'),
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
        '[DONE]',
    ]]);
    await withFetch(fetch, async () => {
        const provider = new OpenAICompatProvider({ apiKey: '', baseURL: 'https://x.test/v1', model: 'm', system: 'S', tools: TOOL_DEFS });
        const got = [];
        await new Agent({ provider, tools, on: { usage: (u) => got.push(u) } }).send('hi');
        assert.deepEqual(got, [{ input: 10, cacheWrite: 0, cacheRead: 0, output: 3, thinking: null }]);
        assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
        assert.equal('reasoning_effort' in requests[0].body, false, 'no effort chosen, none sent');
    });
});

await test('the thinking level goes out as reasoning_effort, changes live and passes to forks', async () => {
    const { fetch, requests } = fakeFetch([
        [delta({ content: 'a' }, 'stop'), '[DONE]'],
        [delta({ content: 'b' }, 'stop'), '[DONE]'],
        [delta({ content: 'c' }, 'stop'), '[DONE]'],
    ]);
    await withFetch(fetch, async () => {
        const provider = new OpenAICompatProvider({ apiKey: '', baseURL: 'https://x.test/v1', model: 'm', system: 'S', tools: TOOL_DEFS, effort: 'low' });
        const agent = new Agent({ provider, tools });
        await agent.send('one');
        provider.setEffort('high');
        await agent.send('two');
        await new Agent({ provider: provider.fork({ system: 'sub', tools: TOOL_DEFS }), tools }).send('three');
        assert.deepEqual(requests.map((q) => q.body.reasoning_effort), ['low', 'high', 'high']);
    });
});

/* ---- linked folders -------------------------------------------------------- */

/* The File System Access API's directory handles, in memory. lastModified ticks
 * on every write, as a real disk's would. */
let diskClock = 1;
const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
class FakeFile {
    constructor(name, text = '') { this.kind = 'file'; this.name = name; this.data = new TextEncoder().encode(text); this.lastModified = diskClock++; }
    async getFile() {
        const data = this.data;
        return { size: data.length, lastModified: this.lastModified, arrayBuffer: async () => data.slice().buffer };
    }
    async createWritable() {
        const parts = [];
        return { write: async (b) => { parts.push(new Uint8Array(b)); }, close: async () => {
            this.data = new Uint8Array(Buffer.concat(parts)); this.lastModified = diskClock++;
        } };
    }
    set(text) { this.data = new TextEncoder().encode(text); this.lastModified = diskClock++; }
    text() { return new TextDecoder().decode(this.data); }
}
class FakeDir {
    constructor(name, tree = {}) {
        this.kind = 'directory';
        this.name = name;
        this.children = new Map();
        for (const [k, v] of Object.entries(tree)) this.children.set(k, typeof v === 'string' ? new FakeFile(k, v) : new FakeDir(k, v));
    }
    async *entries() { yield* [...this.children]; }
    async getDirectoryHandle(n, { create } = {}) {
        let c = this.children.get(n);
        if (!c) { if (!create) throw notFound(); c = new FakeDir(n); this.children.set(n, c); }
        return c;
    }
    async getFileHandle(n, { create } = {}) {
        let c = this.children.get(n);
        if (!c) { if (!create) throw notFound(); c = new FakeFile(n); this.children.set(n, c); }
        return c;
    }
    async removeEntry(n, { recursive = false } = {}) {
        const c = this.children.get(n);
        if (!c) throw notFound();
        if (c.kind === 'directory' && c.children.size && !recursive) throw Object.assign(new Error('not empty'), { name: 'InvalidModificationError' });
        this.children.delete(n);
    }
    async isSameEntry(o) { return o === this; }
    at(path) { return path.split('/').reduce((d, p) => d?.children.get(p), this); }
    /** Every file as { 'a/b.txt': text }, for comparing. */
    dump(prefix = '') {
        const out = {};
        for (const [k, v] of this.children) {
            if (v.kind === 'file') out[prefix + k] = v.text();
            else { out[`${prefix + k}/`] = ''; Object.assign(out, v.dump(`${prefix + k}/`)); }
        }
        return out;
    }
}
class MemoryLinkStore {
    constructor() { this.items = new Map(); }
    async all() { return [...this.items.values()].map((l) => ({ ...l, base: structuredClone(l.base) })); }
    async put(l) { this.items.set(l.id, { ...l, base: structuredClone(l.base) }); }
    async delete(id) { this.items.delete(id); }
}

function wsDump(vm, dir) {
    const out = {};
    const walk = (p, prefix) => {
        for (const e of vm.store.listDir(p) || []) {
            if (e.dir) { out[`${prefix + e.name}/`] = ''; walk(`${p}/${e.name}`, `${prefix + e.name}/`); }
            else out[prefix + e.name] = new TextDecoder().decode(vm.store.getFile(`${p}/${e.name}`));
        }
    };
    walk(dir, '');
    return out;
}

async function linked(tree, opts = {}) {
    const vm = fakeVM();
    vm.store._mkdirp('/work');
    const disk = new FakeDir('proj', tree);
    const store = new MemoryLinkStore();
    const links = new LinkedFolders({ volume: 'workspace', root: '/workspace', store, ...opts });
    const notices = [];
    links.on((type, text) => { if (type === 'notice') notices.push(text); });
    links.setVM(vm);
    return { vm, disk, store, links, notices };
}

await test('linking copies a folder into the open folder, under a free name', async () => {
    const { vm, disk, links } = await linked({ 'a.txt': 'alpha', src: { 'b.c': 'int b;', empty: {} } });
    vm.put('/work/proj/old', 'taken');
    const r = await links.link(disk, '/work');
    assert.deepEqual(r, { path: '/work/proj-2', files: 2, bytes: 11 });
    assert.deepEqual(wsDump(vm, '/work/proj-2'), { 'a.txt': 'alpha', 'src/': '', 'src/b.c': 'int b;', 'src/empty/': '' });
    assert.ok(links.at('/work/proj-2'));
    assert.equal(links.containing('/work/proj-2/src/b.c'), links.at('/work/proj-2'));
    await assert.rejects(links.link(disk, '/'), /already linked/);
    await assert.rejects(links.link(new FakeDir('x'), '/work/proj-2/src'), /inside another linked folder/);
    // Nothing changed, so a sync writes nothing to either side.
    const before = disk.at('a.txt').lastModified;
    await links.sync();
    assert.equal(disk.at('a.txt').lastModified, before);
});

await test('sync moves edits, new files and deletions both ways', async () => {
    const { vm, disk, links, notices } = await linked({ 'a.txt': 'alpha', 'b.txt': 'beta', d: { 'x.txt': 'x', deep: { 'y.txt': 'y' } } });
    await links.link(disk, '/work');
    const enc = new TextEncoder();
    // In the workspace: an edit keeping size and mtime (only `gen` shows it), a new
    // file in a new folder, and a deleted file.
    vm.store.write('/work/proj/a.txt', 0, enc.encode('ALPHA'));
    vm.put('/work/proj/new/n.txt', 'new');
    vm.store.removePath('/work/proj/b.txt');
    // On disk: an edit and a new file.
    disk.at('d/x.txt').set('x2');
    (await (await disk.getDirectoryHandle('d')).getFileHandle('z.txt', { create: true })).set('zed');
    await links.sync();
    const want = { 'a.txt': 'ALPHA', 'd/': '', 'd/x.txt': 'x2', 'd/z.txt': 'zed', 'd/deep/': '', 'd/deep/y.txt': 'y', 'new/': '', 'new/n.txt': 'new' };
    assert.deepEqual(disk.dump(), want);
    assert.deepEqual(wsDump(vm, '/work/proj'), want);
    assert.match(notices.at(-1), /Deleted from proj on your computer, as in \/workspace\/work\/proj: b\.txt\./);

    // A whole subtree removed in the workspace goes on disk too; one removed on disk goes here.
    vm.store.removePath('/work/proj/d/deep');
    await (await disk.getDirectoryHandle('new')).removeEntry('n.txt');
    await disk.removeEntry('new');
    await links.sync();
    const after = { 'a.txt': 'ALPHA', 'd/': '', 'd/x.txt': 'x2', 'd/z.txt': 'zed' };
    assert.deepEqual(disk.dump(), after);
    assert.deepEqual(wsDump(vm, '/work/proj'), after);
});

await test('a file changed on both sides keeps the disk version and saves the other beside it', async () => {
    const { vm, disk, links, notices } = await linked({ 'a.txt': 'base', 'same.txt': 's' });
    await links.link(disk, '/');
    vm.put('/proj/a.txt', 'from the workspace');
    disk.at('a.txt').set('from the disk');
    vm.put('/proj/same.txt', 'both');   // the same change on both sides is no conflict
    disk.at('same.txt').set('both');
    await links.sync();
    const want = { 'a.txt': 'from the disk', 'a.txt.workspace-conflict': 'from the workspace', 'same.txt': 'both' };
    assert.deepEqual(disk.dump(), want);
    assert.deepEqual(wsDump(vm, '/proj'), want);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /a\.txt in \/workspace\/proj changed both on your computer and in the workspace/);
    // A change against a deletion: the change wins.
    vm.store.removePath('/proj/same.txt');
    disk.at('same.txt').set('edited');
    await links.sync();
    assert.equal(wsDump(vm, '/proj')['same.txt'], 'edited');
});

await test('deleting or replacing the linked folder unlinks it and leaves the disk alone', async () => {
    const { vm, disk, links, store, notices } = await linked({ 'a.txt': 'alpha' });
    await links.link(disk, '/');
    vm.store.removePath('/proj');
    await links.sync();
    assert.equal(links.links.length, 0);
    assert.equal(store.items.size, 0);
    assert.deepEqual(disk.dump(), { 'a.txt': 'alpha' });
    assert.match(notices.at(-1), /Unlinked \/workspace\/proj: it was deleted from the workspace/);

    // rm -rf then mkdir of the same name must not look like "every file deleted".
    await links.link(disk, '/');
    vm.store.removePath('/proj');
    vm.store._mkdirp('/proj');
    await links.sync();
    assert.equal(links.links.length, 0);
    assert.deepEqual(disk.dump(), { 'a.txt': 'alpha' });
});

await test('unlink() keeps both copies, and a folder removed mid-sync deletes nothing on disk', async () => {
    const { vm, disk, links, store } = await linked({ 'a.txt': 'alpha', 'b.txt': 'beta' });
    await links.link(disk, '/');
    // Unlinking queues behind a running sync; after it, removing the folder is safe.
    vm.store.removePath('/proj/b.txt');
    const syncing = links.sync();
    assert.equal(await links.unlink('/proj'), true);
    await syncing;
    assert.equal(links.links.length, 0);
    assert.equal(store.items.size, 0);
    assert.deepEqual(wsDump(vm, '/proj'), { 'a.txt': 'alpha' }, 'the workspace copy stays');
    assert.equal(await links.unlink('/proj'), false, 'nothing linked there any more');

    // The folder goes (the guest's rm -rf) after the pass read the workspace: the
    // files it then sees as deleted must not be deleted on disk.
    const t = await linked({ 'a.txt': 'alpha', 'b.txt': 'beta' });
    await t.links.link(t.disk, '/');
    t.vm.store.removePath('/proj/b.txt');
    const scan = t.links._scanWs.bind(t.links);
    t.links._scanWs = async (link) => { const r = await scan(link); t.vm.store.removePath('/proj'); return r; };
    await t.links.sync();
    assert.deepEqual(t.disk.dump(), { 'a.txt': 'alpha', 'b.txt': 'beta' });
    t.links._scanWs = scan;
    await t.links.sync();
    assert.equal(t.links.links.length, 0, 'the next pass unlinks it');
    assert.deepEqual(t.disk.dump(), { 'a.txt': 'alpha', 'b.txt': 'beta' });
});

await test('a read-only link never writes to the disk', async () => {
    const { vm, disk, links, store } = await linked({ 'a.txt': 'alpha', 'b.txt': 'beta', 'c.txt': 'gamma', d: { 'x.txt': 'x' } });
    await links.link(disk, '/', 'read');
    assert.equal(links.at('/proj').mode, 'read');
    const stamps = () => JSON.stringify(disk.dump()) + [...disk.children.values()].map((f) => f.lastModified).join();
    const before = stamps();
    vm.put('/proj/a.txt', 'local edit');
    vm.put('/proj/new.txt', 'only here');
    vm.store.removePath('/proj/b.txt');
    vm.store.removePath('/proj/d');
    await links.sync();
    assert.equal(stamps(), before, 'nothing written or deleted on disk');
    assert.deepEqual(wsDump(vm, '/proj'), { 'a.txt': 'local edit', 'c.txt': 'gamma', 'new.txt': 'only here' });

    // Disk changes come in: over a clean file, and beside a locally edited one.
    disk.at('c.txt').set('GAMMA');
    disk.at('a.txt').set('disk edit');
    disk.at('b.txt').set('beta 2');     // deleted in the workspace, changed on disk: it returns
    await links.sync();
    const ws = wsDump(vm, '/proj');
    assert.equal(ws['c.txt'], 'GAMMA');
    assert.equal(ws['a.txt'], 'disk edit');
    assert.equal(ws['a.txt.workspace-conflict'], 'local edit');
    assert.equal(ws['b.txt'], 'beta 2');
    assert.equal(ws['new.txt'], 'only here');
    assert.equal(disk.at('a.txt.workspace-conflict'), undefined, 'the conflict copy stays in the workspace');

    // The local state survives a reload: a later disk edit still doesn't overwrite it silently.
    vm.put('/proj/c.txt', 'mine');
    await links.sync();
    for (const n of vm.store.tree.values()) n.gen = -1;
    const again = new LinkedFolders({ volume: 'workspace', root: '/workspace', store });
    again.setVM(vm);
    await again.load();
    disk.at('c.txt').set('theirs');
    await again.sync();
    assert.equal(wsDump(vm, '/proj')['c.txt.workspace-conflict'], 'mine');
    assert.equal(disk.at('c.txt').text(), 'theirs');
});

await test('makeZip writes an archive whose entries inflate back with matching CRCs', async () => {
    const { makeZip, crc32 } = await import('../js/zip.js');
    const { inflateRawSync } = await import('node:zlib');
    const enc = new TextEncoder();
    const text = enc.encode('hello zip '.repeat(200));
    const tiny = new Uint8Array([1, 2, 3]);
    const blob = await makeZip([
        { name: 'p', dir: true },
        { name: 'p/a.txt', data: text, mtime: 1700000000 },
        { name: 'p/ünï.bin', data: tiny },
        { name: 'p/empty', dir: true },
    ]);
    const b = Buffer.from(await blob.arrayBuffer());
    const eocd = b.length - 22;
    assert.equal(b.readUInt32LE(eocd), 0x06054b50);
    const n = b.readUInt16LE(eocd + 10);
    let off = b.readUInt32LE(eocd + 16);
    const got = {};
    for (let i = 0; i < n; i++) {
        assert.equal(b.readUInt32LE(off), 0x02014b50);
        const method = b.readUInt16LE(off + 10), crc = b.readUInt32LE(off + 16), csize = b.readUInt32LE(off + 20);
        const nl = b.readUInt16LE(off + 28), local = b.readUInt32LE(off + 42);
        const name = b.subarray(off + 46, off + 46 + nl).toString('utf8');
        const lnl = b.readUInt16LE(local + 26), lel = b.readUInt16LE(local + 28);
        const body = b.subarray(local + 30 + lnl + lel, local + 30 + lnl + lel + csize);
        const data = method === 8 ? inflateRawSync(body) : body;
        assert.equal(crc32(data), crc, name);
        got[name] = { method, size: data.length };
        off += 46 + nl;
    }
    assert.deepEqual(got, {
        'p/': { method: 0, size: 0 }, 'p/a.txt': { method: 8, size: text.length },
        'p/ünï.bin': { method: 0, size: 3 }, 'p/empty/': { method: 0, size: 0 },
    });
    assert.equal(crc32(enc.encode('123456789')), 0xcbf43926, 'the standard CRC-32 check value');
});

await test('links survive a reload, and the size cap stops a big folder', async () => {
    const { vm, disk, store, links } = await linked({ 'a.txt': 'alpha', 'b.txt': 'beta' });
    await links.link(disk, '/');
    // A reload: the store's change counters restart, the baseline comes from storage.
    for (const n of vm.store.tree.values()) n.gen = -1;
    const again = new LinkedFolders({ volume: 'workspace', root: '/workspace', store });
    again.setVM(vm);
    await again.load();
    assert.equal(again.links.length, 1);
    const stamps = [...disk.children.values()].map((f) => f.lastModified);
    await again.sync();
    assert.deepEqual([...disk.children.values()].map((f) => f.lastModified), stamps, 'no rewrite of unchanged files');
    vm.put('/proj/b.txt', 'BETA!');
    await again.sync();
    assert.equal(disk.at('b.txt').text(), 'BETA!');

    const small = await linked({ 'big.bin': 'x'.repeat(100) }, { maxBytes: 50 });
    await assert.rejects(small.links.link(small.disk, '/'), /more than 0 MB/);
    assert.equal(small.vm.store.listDir('/').length, 1, 'nothing was copied'); // just /work
});

await test('tools sync before and after VM calls only', async () => {
    const calls = [];
    const t = createTools(new LocalBridge(work), { cwd: rootSh, sync: async () => { calls.push('sync'); }, delegate: async () => 'r' });
    await t.run('Bash', { command: 'echo hi' });
    assert.deepEqual(calls, ['sync', 'sync']);
    await t.run('Delegate', { description: 'd', prompt: 'p' });
    assert.equal(calls.length, 2);
    const failing = createTools(new LocalBridge(work), { cwd: rootSh, sync: async () => { throw new Error('x'); } });
    assert.equal((await failing.run('Bash', { command: 'echo ok' })).content, 'ok\n');
});

/* ---- guest config ------------------------------------------------------------ */

await test('agentConfig drops the network and adds the JS volumes to a published distro', () => {
    // As TinyEMU-distros' Pages serves it: ${ASSET_BASE} already filled in.
    const base = 'https://example.github.io/TinyEMU-distros/debian-13-riscv64-lite';
    const text = `/* debian-13-riscv64-lite */
{
    version: 1,
    machine: "riscv64",
    memory_size: 256,
    bios: "${base}/bios.bin",
    kernel: "${base}/kernel.bin",
    cmdline: "console=hvc0 root=/dev/vda rw init=/bin/sh",
    drive0: { file: "${base}/blk.txt" },
    eth0: { driver: "user" },
}
`;
    const cfg = resolveConfigFiles(parseConfig(text), `${base}/config.cfg`);
    agentConfig()(cfg);
    assert.equal(cfg.eth0, undefined);
    assert.equal(cfg.kernel, `${base}/kernel.bin`);
    assert.equal(cfg.drive0.file, `${base}/blk.txt`);
    assert.deepEqual([cfg.fs0, cfg.fs1, cfg.fs2], [
        { file: 'js:agent', tag: 'agent' }, { file: 'js:workspace', tag: 'workspace' }, { file: 'js:skills', tag: 'skills' },
    ]);
    // It still reads as a config.
    assert.deepEqual(parseConfig(stringifyConfig(cfg)).fs2, { file: 'js:skills', tag: 'skills' });
});

await test('agentConfig keeps a distro\'s own 9p slot and places an unfilled ${ASSET_BASE}', () => {
    // A local build, served as unpacked: config.cfg still says ${ASSET_BASE}.
    const text = '{\n    machine: "pc",\n    kernel: "${ASSET_BASE}/kernel.bin",\n    drive0: { file: "${ASSET_BASE}/blk.txt" },\n'
        + '    fs0: { file: "root" },\n    eth1: { driver: "user" },\n}\n';
    const cfg = resolveConfigFiles(parseConfig(text), 'http://127.0.0.1:8000/distro/x/config.cfg');
    agentConfig(['a', 'b'])(cfg);
    assert.equal(cfg.kernel, 'http://127.0.0.1:8000/distro/x/kernel.bin');
    assert.equal(cfg.drive0.file, 'http://127.0.0.1:8000/distro/x/blk.txt');
    assert.equal(cfg.fs0.file, 'http://127.0.0.1:8000/distro/x/root');
    assert.deepEqual([cfg.fs1, cfg.fs2], [{ file: 'js:a', tag: 'a' }, { file: 'js:b', tag: 'b' }]);
    assert.equal(cfg.eth1, undefined);
});

await test('parseManifest lists the distros with absolute configs', () => {
    const url = 'https://example.github.io/TinyEMU-distros/manifest.json';
    const list = parseManifest({ distros: [
        { name: 'debian-13-riscv64-lite', arch: 'riscv64', description: 'lite', config: 'debian-13-riscv64-lite/config.cfg' },
        { name: 'alpine-3.20-x86', arch: 'x86', url: 'https://example.github.io/TinyEMU-distros/alpine-3.20-x86/config.cfg' },
        { name: '../etc', arch: 'x86' },
        { name: 'bad-scheme', url: 'javascript:alert(1)' },
        null,
    ] }, url);
    assert.deepEqual(list.map((d) => d.name), ['debian-13-riscv64-lite', 'alpine-3.20-x86']);
    assert.deepEqual(list[0], {
        name: 'debian-13-riscv64-lite', label: 'Debian 13 lite (riscv64)', arch: 'riscv64', description: 'lite',
        config: 'https://example.github.io/TinyEMU-distros/debian-13-riscv64-lite/config.cfg',
    });
    assert.deepEqual(parseManifest(null, url), []);
});

/* ---- context compaction ------------------------------------------------------ */

/* A scripted provider with a plain history, whose forks write summaries. Each step
 * reports `usage` (tokens in the context) when the script gives it. */
function compactable(steps, { summaries = [], contextWindow = 1000, maxOutput = 0 } = {}) {
    const p = {
        contextWindow, maxOutput,
        history: [],
        forks: [],
        addUser(t) { this.history.push({ role: 'user', text: t }); },
        addToolResults(r) { for (const x of r) this.history.push({ role: 'result', text: x.content }); },
        transcript() { return this.history.map((h) => ({ ...h })); },
        resetHistory(t) { this.history = [{ role: 'user', text: t }]; },
        async step({ onText, onUsage }) {
            const s = steps.shift();
            if (s.throw) throw new Error(s.throw);
            if (s.text) { onText(s.text); this.history.push({ role: 'assistant', text: s.text }); }
            if (s.usage) onUsage({ input: s.usage, cacheWrite: 0, cacheRead: 0, output: 0, thinking: null });
            return s;
        },
        fork({ system, tools: defs }) {
            const f = {
                system, defs, asked: [],
                addUser(t) { this.asked.push(t); },
                async step({ onText, onUsage }) {
                    const s = summaries.shift();
                    if (s instanceof Error) throw s;
                    onUsage({ input: 50, cacheWrite: 0, cacheRead: 0, output: 10, thinking: null });
                    onText(s);
                    return { stop: 'end' };
                },
            };
            p.forks.push(f);
            return f;
        },
    };
    return p;
}

await test('renderTranscript labels entries, cuts long ones and keeps the start and the latest', () => {
    const text = renderTranscript([
        { role: 'user', text: 'make a game' },
        { role: 'call', text: 'Bash {"command":"ls"}' },
        { role: 'result', text: 'x'.repeat(10000), isError: true },
        { role: 'assistant', text: 'done' },
    ], 1e6);
    assert.match(text, /^USER:\nmake a game\n\nTOOL CALL:\nBash \{"command":"ls"\}\n\nTOOL RESULT \(error\):\nx{2000}\n\[… 6000 characters cut …\]\nx{2000}\n\nAGENT:\ndone$/);
    const many = Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', text: `step ${i} ${'.'.repeat(80)}` }));
    const fit = renderTranscript([{ role: 'user', text: 'the original request' }, ...many], 1000);
    assert.ok(fit.length <= 1000, `${fit.length} characters`);
    assert.match(fit, /^USER:\nthe original request\n\n\[… \d+ earlier entries omitted to fit …\]/);
    assert.match(fit, /step 49 /);
    assert.equal(fit.includes('step 0 '), false);
});

await test('isContextOverflow recognises the APIs\' too-long errors only', () => {
    for (const m of [
        '400 prompt is too long: 210000 tokens > 200000 maximum',
        "This model's maximum context length is 128000 tokens",
        'ContextWindowSizeExceededError: prompt tokens exceed context window size',
        'Input is too long for requested model',
        'The input token count exceeds the model\'s context',
    ]) assert.ok(isContextOverflow(new Error(m)), m);
    for (const m of ['401 invalid x-api-key', 'rate limited', 'Failed to fetch']) assert.equal(isContextOverflow(new Error(m)), false, m);
});

await test('the agent compacts by itself before a message once the context passes the threshold', async () => {
    const p = compactable([
        { stop: 'end', text: 'first answer', usage: 850 },
        { stop: 'end', text: 'second answer', usage: 120 },
    ], { summaries: ['SUMMARY: the user wants a game'] });
    const events = [];
    const kinds = [];
    const agent = new Agent({
        provider: p, tools,
        on: {
            usage: (u, kind) => kinds.push(kind || 'main'),
            compactStart: (r) => events.push(`start:${r}`),
            compacted: (c) => events.push(`done:${c.reason}:${c.before}:${c.count}`),
        },
        context: { threshold: () => 0.8 },
    });
    await agent.send('one');
    assert.equal(agent.used, 850);
    assert.deepEqual(agent.contextInfo(), { used: 850, estimated: false, limit: 1000, trigger: 800, compactions: 0, last: null });
    await agent.send('two');
    assert.deepEqual(events, ['start:auto', 'done:auto:850:1']);
    // The summarizer saw the transcript, with no tools, and its usage is its own kind.
    assert.equal(p.forks.length, 1);
    assert.deepEqual(p.forks[0].defs, []);
    assert.match(p.forks[0].asked[0], /USER:\none\n\nAGENT:\nfirst answer/);
    assert.deepEqual(kinds, ['main', 'compaction', 'main']);
    // The history is the summary, then the new message.
    assert.equal(p.history[0].role, 'user');
    assert.match(p.history[0].text, /^\[Context compacted[^]*SUMMARY: the user wants a game[^]*The user's next message follows\.\]$/);
    assert.deepEqual(p.history.slice(1).map((h) => h.text), ['two', 'second answer']);
    // The next response measures the real size.
    assert.equal(agent.used, 120);
    assert.equal(agent.lastCompaction.measured, 120);
    assert.equal(agent.compactions, 1);
});

await test('a long turn compacts between its steps, and says to carry on', async () => {
    const call = { id: 'c', name: 'Bash', input: { command: 'echo hi' } };
    const p = compactable([
        { stop: 'tool_use', toolCalls: [call], usage: 500 },
        { stop: 'tool_use', toolCalls: [{ ...call, id: 'd' }], usage: 900 },
        { stop: 'end', text: 'finished', usage: 200 },
    ], { summaries: ['S'] });
    const r = await new Agent({ provider: p, tools }).send('go');
    assert.equal(r.stop, 'end');
    assert.equal(p.forks.length, 1);
    assert.match(p.history[0].text, /continue it from where the summary says it stopped/);
    // The latest tool result went into the summary, not past it.
    assert.equal(p.forks[0].asked[0].split('TOOL RESULT:\nhi\n').length - 1, 2);
    assert.deepEqual(p.history.slice(1).map((h) => h.role), ['assistant']);
});

await test('a context-overflow error compacts once and retries; other failures pass through', async () => {
    const p = compactable([
        { stop: 'end', text: 'a', usage: 100 },
        { throw: 'prompt is too long: 1200 tokens > 1000 maximum' },
        { stop: 'end', text: 'b', usage: 90 },
    ], { summaries: ['S'] });
    const agent = new Agent({ provider: p, tools });
    await agent.send('one');
    assert.equal((await agent.send('two')).stop, 'end');
    assert.equal(agent.lastCompaction.reason, 'overflow');
    assert.match(p.history[0].text, /USER|S/);

    const twice = compactable([{ throw: 'prompt is too long' }, { throw: 'prompt is too long' }], { summaries: ['S'] });
    await assert.rejects(new Agent({ provider: twice, tools }).send('x'), /prompt is too long/);
    const other = compactable([{ throw: '401 invalid key' }]);
    await assert.rejects(new Agent({ provider: other, tools }).send('x'), /401/);
    assert.equal(other.forks.length, 0);
});

await test('a failed or switched-off compaction leaves the history and the turn alone', async () => {
    const p = compactable([
        { stop: 'end', text: 'a', usage: 950 },
        { stop: 'end', text: 'b', usage: 960 },
    ], { summaries: [new Error('summary service down')] });
    const failures = [];
    const agent = new Agent({ provider: p, tools, on: { compactFailed: (e) => failures.push(e.message) } });
    await agent.send('one');
    assert.equal((await agent.send('two')).stop, 'end');
    assert.deepEqual(failures, ['summary service down']);
    assert.deepEqual(p.history.map((h) => h.text), ['one', 'a', 'two', 'b']);

    const off = compactable([{ stop: 'end', usage: 990 }, { stop: 'end', usage: 995 }]);
    const quiet = new Agent({ provider: off, tools, context: { auto: () => false } });
    await quiet.send('1');
    await quiet.send('2');
    assert.equal(off.forks.length, 0);
    assert.equal(quiet.compactions, 0);
});

await test('the trigger leaves room for a reply, and a manual compaction works any time', async () => {
    // 8192-token window, 2048 kept for the reply: 80% of 6144.
    const p = compactable([{ stop: 'end', text: 'hi', usage: 10 }], { contextWindow: 8192, maxOutput: 2048, summaries: ['S'] });
    const agent = new Agent({ provider: p, tools });
    assert.equal(agent.contextInfo().trigger, 4915);
    assert.equal(await agent.compact(), null, 'nothing to compact before any message');
    await agent.send('hello');
    const c = await agent.compact();
    assert.equal(c.reason, 'manual');
    assert.equal(agent.estimated, true);
    // The estimate counts the summary message and what every request carries: here the tools.
    assert.equal(agent.used, Math.ceil(compactedMessage('S', false).length / 4) + Math.ceil(JSON.stringify(tools.defs).length / 4));
    // Settings can override the window.
    const big = new Agent({ provider: p, tools, context: { limit: () => 100000 } });
    assert.equal(big.contextInfo().limit, 100000);
});

await test('providers render their history and reset it to one message', () => {
    const claude = new ClaudeProvider({ apiKey: 'k', model: 'm', system: 'S', tools: TOOL_DEFS, contextWindow: 200000 });
    claude.messages = [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'a.txt', is_error: false }] },
    ];
    assert.deepEqual(claude.transcript(), [
        { role: 'user', text: 'do it' },
        { role: 'assistant', text: 'ok' },
        { role: 'call', text: 'Bash {"command":"ls"}' },
        { role: 'result', text: 'a.txt', isError: false },
    ]);
    assert.equal(claude.fork({ system: 'x', tools: [] }).contextWindow, 200000);
    claude.resetHistory('summary');
    assert.deepEqual(claude.messages, [{ role: 'user', content: 'summary' }]);

    const oa = new OpenAICompatProvider({ apiKey: '', baseURL: 'http://x', model: 'm', system: 'SYS', tools: TOOL_DEFS, contextWindow: 32000 });
    oa.messages.push({ role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'Read', arguments: '{"path":"a"}' } }] },
        { role: 'tool', tool_call_id: '1', content: 'text' });
    assert.deepEqual(oa.transcript(), [
        { role: 'user', text: 'q' }, { role: 'call', text: 'Read {"path":"a"}' }, { role: 'result', text: 'text' },
    ]);
    assert.equal(oa.fork({ system: 'x', tools: [] }).contextWindow, 32000);
    oa.resetHistory('summary');
    assert.deepEqual(oa.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'summary' }]);

    const wl = new WebLLMProvider({ model: 'm', system: 'SYS', tools: TOOL_DEFS });
    assert.equal(wl.contextWindow, 8192);
    wl.messages.push({ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: '<tool_response>\nout\n</tool_response>' });
    assert.deepEqual(wl.transcript().map((e) => e.role), ['user', 'assistant', 'result']);
    wl.resetHistory('summary');
    assert.equal(wl.messages.length, 2);
    assert.equal(wl.fork({ system: 'only this', tools: [] }).messages[0].content, 'only this');
});

await test('model listings carry the context window where the server reports it', async () => {
    const { fetch } = fakeFetch([{ body: { data: [
        { id: 'a-model', context_length: 131072 },
        { id: 'b-model', top_provider: { context_length: 65536 } },
        { id: 'c-model' },
    ] } }]);
    await withFetch(fetch, async () => {
        const models = await listOpenAIModels({ baseURL: 'http://x/v1', apiKey: '' });
        assert.deepEqual(models.map((m) => [m.id, m.contextWindow]), [['a-model', 131072], ['b-model', 65536], ['c-model', null]]);
    });
});

await test('a compaction request sends no tools field', async () => {
    const { fetch, requests } = fakeFetch([[delta({ content: 'S' }, 'stop'), '[DONE]']]);
    await withFetch(fetch, async () => {
        const p = new OpenAICompatProvider({ apiKey: '', baseURL: 'https://x.test/v1', model: 'm', system: 'S', tools: [] });
        p.addUser('summarize');
        await p.step({ onText() {}, onThinking() {}, signal: null });
        assert.equal('tools' in requests[0].body, false);
    });
});

/* ---- editable system prompt ------------------------------------------------------ */

await test('providers replace their system prompt in place', () => {
    const claude = new ClaudeProvider({ apiKey: 'k', model: 'm', system: 'OLD', tools: TOOL_DEFS });
    claude.setSystem('NEW');
    assert.equal(claude.system, 'NEW');

    const oa = new OpenAICompatProvider({ apiKey: '', baseURL: 'http://x', model: 'm', system: 'OLD', tools: TOOL_DEFS });
    oa.addUser('q');
    oa.setSystem('NEW');
    assert.deepEqual(oa.messages, [{ role: 'system', content: 'NEW' }, { role: 'user', content: 'q' }]);

    const wl = new WebLLMProvider({ model: 'm', system: 'OLD', tools: TOOL_DEFS });
    wl.setSystem('NEW');
    assert.match(wl.messages[0].content, /^NEW\n\nYou have these tools:/);
    assert.ok(wl.messages[0].content.includes('"name":"Read"'), 'the tools stay described');
    wl.setTools([TOOL_DEFS[5]]);
    assert.match(wl.messages[0].content, /^NEW\n/);
    assert.equal(wl.messages[0].content.includes('"name":"Read"'), false);
});

await test('the agent gives the provider an edited system prompt at the next message', async () => {
    let prompt = 'FIRST';
    const provider = scripted([{ stop: 'end' }, { stop: 'end' }, { stop: 'end' }]);
    provider.system = 'FIRST';
    const sets = [];
    provider.setSystem = (s) => { sets.push(s); provider.system = s; };
    const agent = new Agent({ provider, tools, system: () => prompt });
    await agent.send('one');
    assert.deepEqual(sets, [], 'unchanged: nothing to send');
    prompt = 'SECOND';
    await agent.send('two');
    await agent.send('three');
    assert.deepEqual(sets, ['SECOND']);
    // Without the option, the provider keeps its own.
    const plain = scripted([{ stop: 'end' }]);
    plain.setSystem = () => { throw new Error('should not be called'); };
    await new Agent({ provider: plain, tools }).send('x');
});

await test('sub-agents start from the edited prompt plus their own role', async () => {
    assert.equal(SUBAGENT_PROMPT, subagentPrompt(SYSTEM_PROMPT));
    assert.match(subagentPrompt('Be terse.'), /^Be terse\.\n\nYou are a sub-agent:/);
    let current = 'Custom rules.';
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c) });
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL), system: () => subagentPrompt(current) });
    const provider = forkable([], [[{ stop: 'end', text: 'r1' }], [{ stop: 'end', text: 'r2' }]]);
    await t.run('Delegate', { description: 'a', prompt: 'p' }, { provider });
    current = 'Changed rules.';
    await t.run('Delegate', { description: 'b', prompt: 'p' }, { provider });
    assert.match(provider.forks[0].system, /^Custom rules\.\n\nYou are a sub-agent/);
    assert.match(provider.forks[1].system, /^Changed rules\.\n\nYou are a sub-agent/);
});

await test('the system prompt fills in the machine placeholders', () => {
    assert.match(SYSTEM_PROMPT, /\{\{VAR_ARCH\}\}/);
    assert.match(SYSTEM_PROMPT, /\{\{VAR_OS_NAME\}\}/);
    const r = renderPrompt(SYSTEM_PROMPT, { ARCH: 'riscv64', OS_NAME: 'Debian 13' });
    assert.match(r, /sandbox VM \(riscv64, Debian 13\)/);
    assert.doesNotMatch(r, /\{\{VAR_/);
    // An unknown or empty one stays visible rather than vanishing.
    assert.equal(renderPrompt('a {{VAR_NOPE}} {{VAR_ARCH}}', { ARCH: '' }), 'a {{VAR_NOPE}} {{VAR_ARCH}}');
    assert.equal(renderPrompt('on {{VAR_ARCH}}, {{VAR_ARCH}}', { ARCH: 'x86' }), 'on x86, x86');
});

/* ---- shells, Bash's default timeout, page-served files ---------------- */

await test('each Bash shell keeps its own directory and exported variables', async () => {
    const t = createTools(new LocalBridge(work), { cwd: rootSh });
    // A call that moves the shell says so, as a model easily loses track of it.
    const moved = await t.run('Bash', { command: 'cd src; export GREETING=hello; PLAIN=x' });
    assert.equal(moved.content, `[The working directory is now ${rootSh}/src: later Bash commands, and relative paths in Read, Edit, Write, Glob and Grep, start there.]`);
    assert.match((await t.run('Bash', { command: 'pwd; echo "$GREETING:$PLAIN"' })).content, /\/src\nhello:\n$/);
    // A new shell starts as a copy of the caller's, then goes its own way.
    const other = await t.run('Bash', { command: 'pwd; echo "$GREETING"; cd deep; export GREETING=bye', shell: 'side' });
    assert.match(other.content, /\/src\nhello\n\[The shell side is now in \S+\/src\/deep; its later commands start there\.\]$/);
    // A failing command after a cd still moved it, and says both.
    const failed = await t.run('Bash', { command: 'cd deep && false', shell: 'third' });
    assert.equal(failed.isError, true);
    assert.match(failed.content, /^\[Exit code 1\. The shell third is now in \S+\/src\/deep; its later commands start there\.\]$/);
    assert.match((await t.run('Bash', { command: 'pwd; echo $GREETING' })).content, /\/src\nhello\n$/);
    assert.match((await t.run('Bash', { command: 'pwd; echo $GREETING', shell: 'side' })).content, /\/src\/deep\nbye\n$/);
    assert.match((await t.run('Bash', { command: 'pwd', shell: 'no spaces' })).content, /shell must be/);
    assert.deepEqual(t.shells().map((s) => s.name), ['main', 'side', 'third']);
    // A value with a quote and a newline survives the round trip.
    await t.run('Bash', { command: `export TRICKY="it's
two lines"` });
    assert.equal((await t.run('Bash', { command: 'printf %s "$TRICKY"' })).content, "it's\ntwo lines");
});

await test('the user\'s environment variables are set in every shell, and follow changes', async () => {
    let vars = { API_URL: 'http://x.test/a b', QUOTE: "it's" };
    const t = createTools(new LocalBridge(work), { cwd: rootSh, env: () => vars });
    assert.equal((await t.run('Bash', { command: 'printf "%s|%s" "$API_URL" "$QUOTE"' })).content, "http://x.test/a b|it's");
    // A command's own export of one of them lasts for that command only; others carry on.
    await t.run('Bash', { command: 'export API_URL=mine; export OWN=kept' });
    assert.equal((await t.run('Bash', { command: 'printf "%s|%s" "$API_URL" "$OWN"' })).content, 'http://x.test/a b|kept');
    // Changed and removed in the settings: the shells follow at their next command.
    vars = { API_URL: 'http://y.test' };
    assert.equal((await t.run('Bash', { command: 'printf "%s|%s|%s" "$API_URL" "${QUOTE-unset}" "$OWN"' })).content, 'http://y.test|unset|kept');
    assert.equal((await t.run('Bash', { command: 'printf %s "$API_URL"', shell: 'other' })).content, 'http://y.test');
    // Names that aren't valid are never exported.
    vars = { 'BAD NAME': 'x', GOOD: '1' };
    assert.equal((await t.run('Bash', { command: 'printf %s "$GOOD"' })).content, '1');
});

await test('chats: titles from the first message, the chat to open, and a store round trip', async () => {
    const { MemoryChatStore, newChat, pickChat, titleFrom, DEFAULT_TITLE } = await import('../js/chats.js');
    assert.equal(titleFrom('  fix the   build\nand more'), 'fix the build');
    assert.equal(titleFrom(''), DEFAULT_TITLE);
    const long = titleFrom('please refactor the parser so that every token keeps its source position');
    assert.ok(long.length <= 40 && long.endsWith('…'), long);
    assert.ok(!/\s…$/.test(long), 'cut at a word, no space before the ellipsis');
    const a = newChat(1000), b = newChat(2000);
    b.updated = 5000;
    assert.notEqual(a.id, b.id);
    assert.equal(pickChat([a, b], a.id), a, 'the remembered one');
    assert.equal(pickChat([a, b], 'gone'), b, 'else the latest updated');
    assert.equal(pickChat([], null), null);
    const store = new MemoryChatStore();
    a.events.push({ k: 'user', text: 'hi', at: 1 });
    await store.put(a);
    a.events.push({ k: 'note', text: 'later' });   // the store keeps a copy, not the live object
    assert.deepEqual((await store.all())[0].events, [{ k: 'user', text: 'hi', at: 1 }]);
    await store.delete(a.id);
    assert.equal((await store.all()).length, 0);
});

await test('withUserEnv keeps the shell\'s other exports and puts the user\'s last', () => {
    const out = withUserEnv("export A='1'\nexport K='old'\n", { K: 'new' }, new Set(['K']));
    assert.equal(out, "export A='1'\nexport K='new'\n");
    assert.equal(withUserEnv(null, {}, new Set()), null);
});

await test('shellEnv drops what a shell must not carry', () => {
    const env = shellEnv("export A='1'\nexport PWD='/x'\nexport B='two\nlines'\nexport AGENT_DIR='/req/1'\nexport OLDPWD\n");
    assert.equal(env, "export A='1'\nexport B='two\nlines'\n");
});

await test('a sub-agent\'s shell is its own: its cd does not move the caller', async () => {
    const t = createTools(new LocalBridge(work), { cwd: rootSh });
    const sub = t.without(DELEGATE_TOOL).forShell('sub-agent-1');
    assert.equal(sub.shell, 'sub-agent-1');
    await sub.run('Bash', { command: 'cd src' });
    assert.ok((await sub.run('Read', { path: 'main.ts' })).content.includes('needle'));
    assert.equal(t.cwd, rootSh);
    assert.match((await t.run('Read', { path: 'main.ts' })).content, /does not exist/);
    assert.equal((await sub.run('Delegate', { description: 'x', prompt: 'y' })).isError, true);
});

await test('Bash takes its default timeout from the setting, in its description too', async () => {
    let ms = 5 * 60000;
    const bridge = heldBridge();
    const t = createTools(bridge, { bashTimeoutMs: () => ms });
    assert.match(t.defs.find((d) => d.name === 'Bash').input_schema.properties.timeout.description, /Default: 300000 \(5 minutes\)/);
    t.run('Bash', { command: 'a' });
    await tick();
    ms = 10 ** 9;   // above the maximum: clamped
    t.run('Bash', { command: 'b' });
    t.run('Bash', { command: 'c', timeout: 2000 });
    await tick();
    assert.deepEqual(bridge.jobs.map((j) => j.timeoutMs), [300000, 7200000, 2000]);
    for (const j of bridge.jobs) j.finish();
});

/* Volumes the page serves itself, over real stores. */
function pageVolumes() {
    const stores = { workspace: new Fs9pStore('workspace', null), skills: new Fs9pStore('skills', null) };
    const calls = [];
    return {
        stores,
        calls,
        route(path) {
            for (const [dir, volume] of [['/workspace', 'workspace'], ['/agent/skills', 'skills']]) {
                if (path === dir || path.startsWith(`${dir}/`)) return { volume, path: path.slice(dir.length) || '/' };
            }
            return null;
        },
        async list(v, p) { calls.push(['list', v, p]); return stores[v].listDir(p); },
        async get(v, p) { calls.push(['get', v, p]); return stores[v].getFile(p); },
        async put(v, p, b) { calls.push(['put', v, p]); return stores[v].putFile(p, b); },
    };
}

await test('Read, Edit and Write of the page\'s volumes skip the guest, and need no booted VM', async () => {
    const files = pageVolumes();
    const t = createTools(new Promise(() => {}), { files, readyTimeoutMs: 50 });   // the VM never comes up
    assert.match((await t.run('Write', { path: 'notes/a.txt', content: 'one two\n' })).content, /Wrote 8 bytes to \/workspace\/notes\/a.txt/);
    assert.equal(new TextDecoder().decode(files.stores.workspace.getFile('/notes/a.txt')), 'one two\n');
    assert.equal((await t.run('Edit', { path: '/workspace/notes/a.txt', old_string: 'two', new_string: '2' })).isError, false);
    assert.match((await t.run('Read', { path: 'notes/a.txt' })).content, /1\tone 2/);
    assert.match((await t.run('Read', { path: 'notes' })).content, /directory, not a file/);
    assert.match((await t.run('Read', { path: 'nope.txt' })).content, /does not exist/);
    assert.match((await t.run('Write', { path: 'notes', content: 'x' })).content, /directory/);
    await t.run('Write', { path: '/agent/skills/demo/SKILL.md', content: '---\nname: demo\n---\n' });
    assert.ok(files.stores.skills.getFile('/demo/SKILL.md'));
    // Anything else still needs the guest, and here waits for it in vain.
    assert.match((await t.run('Read', { path: '/etc/passwd' })).content, /still booting/);
    assert.match((await t.run('Read', { path: '/workspace/../etc/passwd' })).content, /still booting/);
    assert.match((await t.run('Bash', { command: 'ls' })).content, /still booting/);
});

await test('page-served writes keep per-file order', async () => {
    const files = pageVolumes();
    const t = createTools(new Promise(() => {}), { files });
    await t.run('Write', { path: 'q.txt', content: 'one two' });
    const [, , read] = await Promise.all([
        t.run('Edit', { path: 'q.txt', old_string: 'one', new_string: '1' }),
        t.run('Edit', { path: 'q.txt', old_string: 'two', new_string: '2' }),
        t.run('Read', { path: 'q.txt' }),
    ]);
    assert.match(read.content, /1 2/);
});

/* ---- empty replies, messages during a turn, the log -------------------- */

await test('an empty reply is asked for again, and stops as "empty" when it stays empty', async () => {
    const provider = scripted([{ stop: 'empty' }, { stop: 'end', text: 'there' }]);
    const notes = [];
    const r = await new Agent({ provider, tools, on: { retrying: (w) => notes.push(w) } }).send('hi');
    assert.equal(r.stop, 'end');
    assert.equal(notes.length, 1);

    const stubborn = scripted([{ stop: 'empty' }, { stop: 'empty' }, { stop: 'end', text: 'late' }]);
    const agent = new Agent({ provider: stubborn, tools, emptyRetries: 1 });
    const r2 = await agent.send('hi');
    assert.equal(r2.stop, 'empty');
    assert.match(r2.detail, /empty response 2 times/);
    // Try again: the same request, nothing added to the history.
    const r3 = await agent.retry();
    assert.equal(r3.stop, 'end');
    assert.deepEqual(stubborn.history, [['user', 'hi']]);
});

await test('OpenAI-style and WebLLM empty replies stay out of the history', async () => {
    const { fetch } = fakeFetch([[delta({ content: '' }, 'stop'), '[DONE]']]);
    await withFetch(fetch, async () => {
        const p = new OpenAICompatProvider({ apiKey: '', baseURL: 'http://x', model: 'm', system: 's', tools: TOOL_DEFS });
        p.addUser('hi');
        const r = await p.step({ onText() {}, onThinking() {} });
        assert.equal(r.stop, 'empty');
        assert.equal(p.messages.length, 2);
    });
    const w = new WebLLMProvider({ model: 'm', system: 'S', tools: [] });
    w.engine = { chat: { completions: { create: async () => (async function* () { yield { choices: [{ delta: { content: '<think>x</think>' }, finish_reason: 'stop' }] }; })() } } };
    w.addUser('hi');
    assert.equal((await w.step({ onText() {} })).stop, 'empty');
    assert.equal(w.messages.length, 2);
});

await test('Claude puts a message sent after tool results into the same user turn', () => {
    const c = new ClaudeProvider({ apiKey: 'k', model: 'claude-x', system: 's', tools: [] });
    c.addUser('first');
    c.addToolResults([{ id: 't1', content: 'ok', isError: false }]);
    c.addUser('also this');
    assert.equal(c.messages.length, 2);
    assert.deepEqual(c.messages[1].content.map((b) => b.type), ['tool_result', 'text']);
    c.addUser('separate');   // after a text block: still the same turn
    assert.equal(c.messages.length, 2);
});

await test('a message queued during a turn reaches the model at its next step', async () => {
    const bridge = heldBridge();
    const provider = scripted([
        { stop: 'tool_use', toolCalls: [{ id: '1', name: 'Bash', input: { command: 'slow' } }] },
        { stop: 'end', text: 'ok' },
        { stop: 'end', text: 'and the second' },
    ]);
    // The second reply waits until the test lets it go.
    let release;
    const gate = new Promise((r) => { release = r; });
    const step = provider.step.bind(provider);
    let n = 0;
    provider.step = async (args) => { if (++n === 2) await gate; return step(args); };
    const injected = [];
    const agent = new Agent({ provider, tools: createTools(bridge), on: { injected: (i) => injected.push(i.id) } });
    const sent = agent.send('go');
    await tick();
    const a = agent.queue('also do X');
    const b = agent.queue('never mind');
    assert.equal(agent.unqueue(b), true);
    bridge.jobs[0].finish();
    await tick();
    // Taken after the tool results, before the next step.
    assert.deepEqual(provider.history.map(([k]) => k), ['user', 'results', 'user']);
    assert.match(provider.history[2][1], /while you were working[^]*also do X/);
    assert.deepEqual(injected, [a]);
    // One queued as the model finishes starts another round in the same turn.
    const c = agent.queue('one more');
    release();
    const r = await sent;
    assert.equal(r.stop, 'end');
    assert.deepEqual(provider.history[3], ['user', 'one more']);
    assert.deepEqual(injected, [a, c]);
    assert.equal(agent.takePending().length, 0);
});

await test('the log records every exchange as plain JSON, with tool times', async () => {
    const entries = [];
    const provider = scripted([
        { stop: 'tool_use', text: 'Reading.', toolCalls: [{ id: '1', name: 'Read', input: { path: 'a.txt' } }] },
        { stop: 'end', text: 'done' },
    ]);
    let stats = null;
    await new Agent({ provider, tools, log: (e) => entries.push(e), on: { toolEnd: (c, r, s) => { stats = s; } } }).send('go');
    assert.deepEqual(entries.map((e) => [e.agent, e.type]), [['main', 'user'], ['main', 'response'], ['main', 'tool'], ['main', 'response']]);
    assert.equal(entries[1].text, 'Reading.');
    assert.deepEqual(entries[1].toolCalls, [{ id: '1', name: 'Read', input: { path: 'a.txt' } }]);
    assert.ok(Number.isInteger(entries[2].ms) && entries[2].ms >= 0);
    assert.match(entries[2].content, /alpha/);
    assert.ok(Number.isInteger(stats.ms));
    JSON.stringify(entries);   // nothing that can't be exported
});

await test('the step limit is read at each step, so a setting change applies mid-turn', async () => {
    let max = 5;
    const step = { stop: 'tool_use', toolCalls: [{ id: '1', name: 'Bash', input: { command: ':' } }] };
    const provider = scripted([step, step, step, step]);
    const r = await new Agent({ provider, tools, maxSteps: () => max, on: { toolEnd() { max = 2; } } }).send('go');
    assert.equal(r.stop, 'max_steps');
    assert.match(r.detail, /after 2 steps/);
});

await test('Delegate runs at most maxConcurrent sub-agents at once; the rest wait', async () => {
    let delegate;
    let limit = 1;
    const bridge = heldBridge();
    const t = createTools(bridge, { delegate: (i, c) => delegate(i, c) });
    const log = [];
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL), maxConcurrent: () => limit, log: (e) => log.push(e) });
    const subStep = (cmd) => [{ stop: 'tool_use', toolCalls: [{ id: cmd, name: 'Bash', input: { command: cmd } }] }, { stop: 'end', text: `did ${cmd}` }];
    const provider = forkable([], [subStep('one'), subStep('two')]);
    const out = [];
    const first = t.run('Delegate', { description: 'a', prompt: 'p' }, { provider, agent: 'main', callId: 'd1' });
    const second = t.run('Delegate', { description: 'b', prompt: 'p' }, { provider, onOutput: (s) => out.push(s) });
    await tick();
    assert.equal(bridge.jobs.length, 1);   // the second waits for a slot
    assert.match(out.join(''), /waiting/);
    bridge.jobs[0].finish();
    assert.equal((await first).content, 'did one');
    await tick();
    assert.equal(bridge.jobs.length, 2);
    bridge.jobs[1].finish();
    assert.equal((await second).content, 'did two');
    // Each sub-agent ran in its own shell and is named in the log.
    assert.deepEqual(log.filter((e) => e.type === 'start').map((e) => [e.agent, e.shell, e.parent, e.callId]),
        [['sub-agent 1', 'sub-agent-1', 'main', 'd1'], ['sub-agent 2', 'sub-agent-2', null, null]]);
    limit = 0;   // no limit
    const p2 = forkable([], [subStep('x'), subStep('y')]);
    const both = Promise.all([t.run('Delegate', { description: 'x', prompt: 'p' }, { provider: p2 }), t.run('Delegate', { description: 'y', prompt: 'p' }, { provider: p2 })]);
    await tick();
    assert.equal(bridge.jobs.length, 4);
    bridge.jobs[2].finish();
    bridge.jobs[3].finish();
    await both;
});

await test('a sub-agent waiting for a slot can be stopped', async () => {
    let delegate;
    const bridge = heldBridge();
    const t = createTools(bridge, { delegate: (i, c) => delegate(i, c) });
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL), maxConcurrent: 1 });
    const busy = [{ stop: 'tool_use', toolCalls: [{ id: 'b', name: 'Bash', input: { command: 'b' } }] }, { stop: 'end', text: 'r' }];
    const provider = forkable([], [busy]);
    const running = t.run('Delegate', { description: 'a', prompt: 'p' }, { provider });
    await tick();
    const stop = new AbortController();
    const waiting = t.run('Delegate', { description: 'b', prompt: 'p' }, { provider, signal: stop.signal });
    await tick();
    stop.abort();
    const r = await waiting;
    assert.equal(r.isError, true);
    assert.match(r.content, /Stopped/);
    bridge.jobs[0].finish();
    await running;
});

/* ---- tool names, ask_user, output limits, stopping one call ------------------- */

await test('tool names match without case or separators', async () => {
    assert.equal(resolveToolName('bash'), 'Bash');
    assert.equal(resolveToolName('BASH'), 'Bash');
    assert.equal(resolveToolName('AskUser'), ASK_TOOL);
    assert.equal(resolveToolName('ask-user'), ASK_TOOL);
    assert.equal(resolveToolName('Nope'), 'Nope');
    assert.equal((await run('read', { path: 'a.txt' })).isError, false);
    // The loop shows (and logs) the tool that ran.
    const provider = scripted([
        { stop: 'tool_use', toolCalls: [{ id: '1', name: 'read', input: { path: 'a.txt' } }] },
        { stop: 'end' },
    ]);
    const names = [];
    await new Agent({ provider, tools, on: { toolStart: (c) => names.push(c.name) } }).send('go');
    assert.deepEqual(names, ['Read']);
    assert.match(provider.history[1][1][0].content, /1\talpha/);
});

await test('ask_user takes a batch of questions, or one, and formats the answers', async () => {
    const qs = askQuestions({ questions: [
        { id: 'db', header: 'Database', question: 'Which?', options: ['PostgreSQL', ' SQLite ', 'SQLite'] },
        { id: 'db', question: 'Extras?', options: ['Redis'], multi_select: true, allow_custom_input: false },
    ] });
    assert.deepEqual(qs.map((q) => [q.id, q.options, q.multi, q.custom]), [
        ['db', ['PostgreSQL', 'SQLite'], false, true],
        ['db_', ['Redis'], true, false],
    ]);
    assert.throws(() => askQuestions({ questions: [] }), /1 to 10/);
    assert.throws(() => askQuestions({ questions: [{ id: 'x', question: 'q', options: [], allow_custom_input: false }] }), /no options/);
    assert.equal(askQuestions({ question: 'Proceed?', options: ['yes', 'no'] })[0].id, 'answer');
    const text = formatAnswers(qs, { answers: { db: { picked: ['SQLite'], text: '' }, db_: { picked: ['Redis'], text: 'Kafka' } } });
    assert.equal(text, 'The user answered:\n- db (Database): SQLite\n- db_: Redis; Kafka (typed by the user)');
    assert.match(formatAnswers(qs, { declined: true }), /dismissed the questions without answering/);

    const asked = [];
    const t = createTools(new LocalBridge(work), {
        cwd: rootSh,
        ask: async (questions, ctx) => { asked.push([questions, ctx.callId]); return { answers: { answer: { picked: ['yes'], text: '' } } }; },
    });
    assert.ok(t.defs.some((d) => d.name === ASK_TOOL));
    // The single-question form some models write is taken too.
    const r = await t.run('ask_user', { question: 'Proceed?', options: ['yes', 'no'] }, { callId: 'k' });
    assert.deepEqual(r, { content: 'The user answered:\n- answer: yes', isError: false });
    assert.equal(asked[0][1], 'k');
    assert.equal((await t.run('ask_user', { questions: 'x' })).isError, true);
    assert.equal(t.without(ASK_TOOL).defs.some((d) => d.name === ASK_TOOL), false);
});

await test('sub-agents get no ask_user, and only their final message', async () => {
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c), ask: async () => ({ declined: true }) });
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL, ASK_TOOL) });
    const provider = forkable([
        { stop: 'tool_use', toolCalls: [{ id: 'd', name: 'Delegate', input: { description: 'x', prompt: 'p' } }] },
        { stop: 'end' },
    ], [[
        { stop: 'tool_use', text: 'Working on it.', toolCalls: [{ id: 'a', name: 'ask_user', input: { question: 'q?', options: ['a', 'b'] } }] },
        { stop: 'end', text: 'Final.' },
    ]]);
    await new Agent({ provider, tools: t }).send('go');
    const [sub] = provider.forks;
    assert.equal(sub.defs.includes(ASK_TOOL), false);
    assert.equal(sub.history[1][1][0].content, 'The ask_user tool is not available here.');
    assert.deepEqual(provider.history[1][1][0], { id: 'd', content: 'Final.', isError: false });
});

await test('a sub-agent cut off at the output limit is asked for its report; an error is retried once', async () => {
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c) });
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL) });
    const call = { description: 'x', prompt: 'p' };
    const p = forkable([], [[{ stop: 'max_tokens', detail: 'The response hit the output limit.' }, { stop: 'end', text: 'Short report.' }]]);
    assert.deepEqual(await t.run('Delegate', call, { provider: p }), { content: 'Short report.', isError: false });
    assert.match(p.forks[0].history.at(-1)[1], /cut off: it hit the output limit/);
    // Asking twice more and still nothing: then it fails, saying why.
    const empty = { stop: 'max_tokens', detail: 'cut' };
    const r = await t.run('Delegate', call, { provider: forkable([], [[empty, empty, empty]]) });
    assert.deepEqual(r, { content: 'The sub-agent stopped without a report: cut', isError: true });

    let thrown = 0;
    const flaky = forkable([], [[]]);
    const fork = flaky.fork;
    flaky.fork = (o) => {
        const f = fork(o);
        f.step = async ({ onText }) => {
            if (!thrown++) throw new Error('503 overloaded');
            onText('Recovered.');
            return { stop: 'end' };
        };
        f.retried = 0;
        return f;
    };
    const r2 = await t.run('Delegate', call, { provider: flaky, onOutput: () => {} });
    assert.deepEqual(r2, { content: 'Recovered.', isError: false });
});

await test('a sub-agent\'s compaction keeps its task word for word', () => {
    assert.match(compactedMessage('sum', true, 'Find the bug in x.c'), /\[Your task, exactly as it was given to you:\]\nFind the bug in x\.c/);
    assert.equal(compactedMessage('sum', true).includes('Your task'), false);
});

await test('the delegate view sees each sub-agent start and end', async () => {
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c) });
    const seen = [];
    delegate = createDelegate({
        tools: t.without(DELEGATE_TOOL),
        view: (info) => {
            seen.push(['start', info.description, info.callId, info.parent]);
            return {
                meta: { chatId: 'sub' },
                hooks: { text: (x) => seen.push(['text', x]) },
                log: (e) => seen.push(['log', e.type]),
                done: (status, text) => seen.push(['done', status, text]),
            };
        },
    });
    const provider = forkable([
        { stop: 'tool_use', toolCalls: [{ id: 'd9', name: 'Delegate', input: { description: 'look', prompt: 'p' } }] },
        { stop: 'end' },
    ], [[{ stop: 'end', text: 'Seen.' }]]);
    await new Agent({ provider, tools: t, meta: { chatId: 'main' } }).send('go');
    assert.deepEqual(seen.filter((x) => x[0] !== 'log'), [['start', 'look', 'd9', { chatId: 'main' }], ['text', 'Seen.'], ['done', 'done', 'Seen.']]);
    assert.ok(seen.some((x) => x[0] === 'log' && x[1] === 'start'));
});

await test('a tool result is cut to the limit, and to a quarter of the window', async () => {
    assert.equal(limitToolOutput('short', 100), 'short');
    const cut = limitToolOutput('a'.repeat(300) + 'b'.repeat(100), 100);
    assert.ok(cut.startsWith('a'.repeat(75)) && cut.endsWith('b'.repeat(25)));
    assert.match(cut, /300 characters omitted: this result was 400 characters, over the 100-character limit/);
    const big = { stop: 'tool_use', toolCalls: [{ id: '1', name: 'Bash', input: { command: 'seq 1 3000' } }] };
    const p1 = scripted([big, { stop: 'end' }]);
    await new Agent({ provider: p1, tools, toolOutputMax: () => 500 }).send('go');
    assert.ok(p1.history[1][1][0].content.length < 800);
    // A small window caps it further: 1000 tokens -> 1000 characters.
    const p2 = scripted([big, { stop: 'end' }]);
    p2.contextWindow = 1000;
    await new Agent({ provider: p2, tools, toolOutputMax: 1e6 }).send('go');
    assert.match(p2.history[1][1][0].content, /over the 1,000-character limit/);
});

await test('one tool call can be stopped while the rest of the step goes on', async () => {
    const provider = scripted([
        { stop: 'tool_use', toolCalls: [
            { id: 'slow', name: 'Bash', input: { command: 'sleep 9' } },
            { id: 'ok', name: 'Bash', input: { command: 'fine' } },
        ] },
        { stop: 'end', text: 'went on' },
    ]);
    const bridge = heldBridge();
    const agent = new Agent({ provider, tools: createTools(bridge) });
    const sent = agent.send('go');
    await tick();
    assert.deepEqual(agent.runningCalls(), ['slow', 'ok']);
    assert.equal(agent.cancelTool('slow'), true);
    assert.equal(agent.cancelTool('nope'), false);
    bridge.jobs[1].finish();
    const r = await sent;
    assert.equal(r.stop, 'end');
    const [slow, ok] = provider.history[1][1];
    assert.equal(slow.isError, true);
    assert.match(slow.content, /The user stopped this tool call; the rest of your work goes on/);
    assert.deepEqual([ok.isError, ok.content], [false, 'fine']);
    // A tool that ignores the signal still answers at once.
    const stuck = scripted([{ stop: 'tool_use', toolCalls: [{ id: 'q', name: 'ask_user', input: { question: 'q', options: ['a'] } }] }, { stop: 'end' }]);
    const a2 = new Agent({ provider: stuck, tools: createTools(bridge, { ask: () => new Promise(() => {}) }) });
    const s2 = a2.send('go');
    await tick();
    a2.cancelTool('q');
    assert.equal((await s2).stop, 'end');
    assert.match(stuck.history[1][1][0].content, /^Stopped by the user\./);
});

await test('a turn cut off by a reload: calls left open are found, closed or resumed', async () => {
    const c = new ClaudeProvider({ apiKey: 'k', model: 'claude-x', system: 's', tools: [] });
    c.messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [
        { type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } },
        { type: 'tool_use', id: 't2', name: 'Delegate', input: { description: 'd', prompt: 'p' } }] }];
    assert.deepEqual(c.pendingCalls().map((x) => x.id), ['t1', 't2']);
    const o = new OpenAICompatProvider({ apiKey: '', baseURL: 'http://x', model: 'm', system: 'S', tools: [] });
    o.messages.push({ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'Bash', arguments: '{"command":"x"}' } },
        { id: 'b', type: 'function', function: { name: 'Read', arguments: '{"path":"y"}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'done' });
    assert.deepEqual(o.pendingCalls(), [{ id: 'b', name: 'Read', input: { path: 'y' } }]);
    o.addToolResults([{ id: 'b', content: 'r', isError: false }]);
    assert.deepEqual(o.pendingCalls(), []);

    // closePending answers them all "interrupted", running nothing.
    const plain = scripted([]);
    plain.pendingCalls = () => [{ id: 'x', name: 'Bash', input: {} }];
    assert.equal(new Agent({ provider: plain, tools }).closePending(), 1);
    assert.deepEqual(plain.history[0][1], [{ id: 'x', content: INTERRUPTED, isError: true }]);

    // resumePending: the runner answers what it can (text or a result), null is
    // "interrupted"; the note follows; the model goes on.
    const p = scripted([{ stop: 'end', text: 'carried on' }]);
    let open = [{ id: 'b1', name: 'bash', input: { command: 'x' } }, { id: 'd1', name: 'Delegate', input: { description: 'd', prompt: 'p' } }];
    p.pendingCalls = () => open;
    const origResults = p.addToolResults.bind(p);
    p.addToolResults = (r) => { open = []; origResults(r); };
    const ran = [];
    const r = await new Agent({ provider: p, tools }).resumePending(undefined, (call) => {
        ran.push(call.name);
        return call.name === DELEGATE_TOOL ? Promise.resolve('the report') : null;
    }, 'NOTE');
    assert.equal(r.stop, 'end');
    assert.deepEqual(ran, ['Bash', 'Delegate']);
    assert.deepEqual(p.history[0][1], [
        { id: 'b1', content: INTERRUPTED, isError: true },
        { id: 'd1', content: 'the report', isError: false },
    ]);
    assert.deepEqual(p.history[1], ['user', 'NOTE']);
});

await test('a request that fails after the page was paused is asked again once', async () => {
    let n = 0;
    const provider = scripted([]);
    provider.step = async ({ onText }) => {
        n++;
        if (n === 1) { pauses._add(60000); throw new TypeError('Failed to fetch'); }
        onText('back');
        return { stop: 'end' };
    };
    const why = [];
    const r = await new Agent({ provider, tools, on: { retrying: (w) => why.push(w) } }).send('go');
    assert.equal(r.stop, 'end');
    assert.equal(n, 2);
    assert.match(why[0], /paused while waiting for the model/);
    // Without a pause, the error stands.
    const p2 = scripted([]);
    p2.step = async () => { throw new Error('API error 400: bad request'); };
    await assert.rejects(new Agent({ provider: p2, tools }).send('go'), /bad request/);
});

await test('network failures are asked again on the 5/5/10/10/20 s schedule', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => networkRetryDelay(n)), [5000, 5000, 10000, 10000, 20000, 20000, 20000]);
    assert.deepEqual(NETWORK_RETRY_MS, [5000, 5000, 10000, 10000, 20000]);
    for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'Connection error.', 'fetch failed']) {
        assert.equal(isNetworkError(new TypeError(m)), true, m);
    }
    const conn = new Error('x');
    conn.name = 'APIConnectionError';
    assert.equal(isNetworkError(conn), true);
    assert.equal(isNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })), true);
    assert.equal(isNetworkError(Object.assign(new Error('terminated'), {})), true);
    // The server answered: not a network failure.
    assert.equal(isNetworkError(Object.assign(new Error('Connection error.'), { status: 500 })), false);
    assert.equal(isNetworkError(new Error('API error 401: invalid x-api-key')), false);
    assert.equal(isNetworkError(new Error('prompt is too long: 300000 tokens > 200000 maximum')), false);
});

await test('a turn waits out a lost connection, and the count starts over once it is back', async () => {
    let n = 0;
    const provider = scripted([]);
    // Fails 3 times, works, then fails 2 more times, then works.
    const plan = ['x', 'x', 'x', 'tool', 'x', 'x', 'end'];
    provider.step = async ({ onText }) => {
        const p = plan[n++];
        if (p === 'x') throw new TypeError('Failed to fetch');
        if (p === 'tool') return { stop: 'tool_use', toolCalls: [{ id: 't', name: 'Read', input: { path: 'a.txt' } }] };
        onText('back');
        return { stop: 'end' };
    };
    const seen = [];
    const logged = [];
    const agent = new Agent({
        provider, tools, networkRetryMs: [1, 2, 3], log: (e) => logged.push(e),
        on: { retrying: (why, info) => seen.push([info.attempt, info.delayMs, why.startsWith("Can't reach the model (Failed to fetch)")]) },
    });
    const r = await agent.send('go');
    assert.equal(r.stop, 'end');
    assert.equal(n, 7);
    assert.deepEqual(seen, [[1, 1, true], [2, 2, true], [3, 3, true], [1, 1, true], [2, 2, true]]);
    assert.equal(logged.filter((e) => e.type === 'error' && e.network).length, 5);
    // Nothing of a failed request went into the history: one tool result, no stray messages.
    assert.deepEqual(provider.history.map((h) => h[0]), ['user', 'results']);
});

await test('Stop ends a turn that is waiting for the connection', async () => {
    const provider = scripted([]);
    let n = 0;
    provider.step = async () => { n++; throw new TypeError('Failed to fetch'); };
    const ctl = new AbortController();
    const agent = new Agent({ provider, tools, networkRetryMs: [60000], on: { retrying: () => setTimeout(() => ctl.abort(), 5) } });
    const started = Date.now();
    const r = await agent.send('go', ctl.signal);
    assert.equal(r.stop, 'aborted');
    assert.equal(n, 1);
    assert.ok(Date.now() - started < 5000);
});

await test('a sub-agent waits out a lost connection instead of failing', async () => {
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c) });
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL), networkRetryMs: [1] });
    let n = 0;
    const sub = scripted([]);
    sub.step = async ({ onText }) => {
        if (n++ < 3) throw new TypeError('Failed to fetch');
        onText('The report.');
        return { stop: 'end' };
    };
    const provider = { fork: () => sub };
    const progress = [];
    const r = await t.run('Delegate', { description: 'd', prompt: 'p' }, { provider, onOutput: (s) => progress.push(s) });
    assert.deepEqual(r, { content: 'The report.', isError: false });
    assert.equal(n, 4);
    assert.ok(progress.join('').includes("↻ Can't reach the model (Failed to fetch); trying again in 0 s."));
});

await test('providers export and import their history', () => {
    const o = new OpenAICompatProvider({ apiKey: '', baseURL: 'http://x', model: 'm', system: 'SYS', tools: [] });
    o.addUser('hello');
    const h = o.exportHistory();
    const o2 = new OpenAICompatProvider({ apiKey: '', baseURL: 'http://x', model: 'm', system: 'OTHER', tools: [] });
    o2.importHistory(JSON.parse(JSON.stringify(h)));
    assert.deepEqual(o2.messages, [{ role: 'system', content: 'OTHER' }, { role: 'user', content: 'hello' }]);
    const c = new ClaudeProvider({ apiKey: 'k', model: 'claude-x', system: 's', tools: [] });
    assert.throws(() => c.importHistory(h), /not a Claude conversation/);
});

await test('the keep-running tone is quiet, but loud enough for Chrome to count, then silent', () => {
    const rate = 48000;
    const x = toneSamples(rate);
    assert.equal(x.length, rate * PERIOD_S);
    assert.ok(PERIOD_S < 30, 'within the 30 s Chrome uses for "played sound lately"');
    const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const dbfs = 20 * Math.log10(peak);
    assert.ok(dbfs > -72 && dbfs < -40, `peak ${dbfs.toFixed(1)} dBFS`);
    assert.equal(x[0], 0);                       // faded in: no click
    assert.ok(x.subarray(rate).every((v) => v === 0));   // then silence until the next tone
});

await test('the Context panel splits the window into parts that add up', () => {
    const defs = [
        { name: 'Bash', description: 'x'.repeat(400), input_schema: {} },
        { name: 'Read', description: 'y'.repeat(40), input_schema: {} },
        { name: 'skill', description: 'z'.repeat(200), input_schema: {} },
    ];
    const system = 's'.repeat(800);   // ~200 tokens
    const b = contextBreakdown({ used: 10000, limit: 100000, trigger: 80000, auto: true, system, defs });
    const by = Object.fromEntries(b.segments.map((p) => [p.key, p.tokens]));
    assert.equal(by.system, 200);
    assert.ok(by.tools > by.skills && by.skills > 0);
    assert.equal(by.messages, 10000 - by.system - by.tools - by.skills);
    assert.equal(by.buffer, 20000);
    assert.equal(by.free, 70000);
    assert.equal(b.segments.reduce((n, p) => n + p.tokens, 0), 100000);
    assert.deepEqual(b.tools.map((t) => t.name), ['Bash', 'Read']);   // the skill tool is its own row
    assert.equal(b.measured, true);
    // Off: no buffer, the rest is free. Past the trigger: no buffer left either.
    assert.equal(contextBreakdown({ used: 10000, limit: 100000, trigger: 80000, auto: false, system, defs }).segments.find((p) => p.key === 'buffer').tokens, 0);
    const over = contextBreakdown({ used: 90000, limit: 100000, trigger: 80000, auto: true, system, defs });
    assert.deepEqual(over.segments.slice(-2).map((p) => p.tokens), [10000, 0]);
    // Before any response, the conversation is estimated from its text.
    const est = contextBreakdown({ used: 0, limit: 100000, trigger: 80000, auto: true, system, defs, transcript: [{ text: 'm'.repeat(4000) }] });
    assert.equal(est.measured, false);
    assert.equal(est.segments[0].tokens, 1000);
});

await test('the Usage panel totals the parts, the cache hit rate and API time', () => {
    const t = (o) => ({ requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, thinkingKnown: false, ...o });
    const u = usageSummary({
        main: t({ requests: 3, input: 100, cacheWrite: 200, cacheRead: 700, output: 1000 }),
        sub: t({ requests: 1, input: 0, cacheRead: 0, output: 1000 }),
        compaction: t(),
    }, [{ type: 'response', ms: 1500 }, { type: 'tool', ms: 9999 }, { type: 'response', ms: 500 }]);
    assert.equal(u.total.requests, 4);
    assert.equal(u.tokens, 3000);
    assert.equal(u.cacheHit, 0.7);
    assert.equal(u.apiMs, 2000);
    assert.deepEqual(u.shares.map((p) => [p.key, p.share]), [['main', 2000 / 3000], ['sub', 1000 / 3000], ['compaction', 0]]);
    assert.equal(usageSummary({ main: t(), sub: t(), compaction: t() }).cacheHit, null);
});

await test('rate limits are read from Anthropic, OpenAI and OpenRouter headers', () => {
    const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
    const now = 1_000_000;
    const a = parseRateLimits(h({
        'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-requests-reset': '2026-11-15T10:00:00Z',
        'anthropic-ratelimit-input-tokens-limit': '40000', 'anthropic-ratelimit-input-tokens-remaining': '30000',
    }), now);
    assert.deepEqual(a.map((l) => [l.name, l.limit, l.remaining]), [['requests', 50, 49], ['input tokens', 40000, 30000]]);
    assert.equal(a[0].resetAt, Date.parse('2026-11-15T10:00:00Z'));
    const o = parseRateLimits(h({
        'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499', 'x-ratelimit-reset-requests': '1m30s',
        'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '29000', 'x-ratelimit-reset-tokens': '250ms',
    }), now);
    assert.deepEqual(o.map((l) => [l.name, l.resetAt - now]), [['requests', 90000], ['tokens', 250]]);
    const r = parseRateLimits(h({ 'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1794600000000' }), now);
    assert.deepEqual(r, [{ name: 'requests', limit: 20, remaining: 3, resetAt: 1794600000000 }]);
    assert.equal(parseRateLimits(h({})), null);
    assert.equal(parseRateLimits(null), null);
});

await test('the guest health after a job is parsed from /proc', () => {
    const hl = parseHealth('0.42 0.30 0.10 2/57 1234\nMemTotal:         126000 kB\nMemAvailable:      80000 kB\n');
    assert.deepEqual(hl, { load1: 0.42, load5: 0.3, load15: 0.1, running: 2, procs: 57, memTotalKB: 126000, memAvailableKB: 80000 });
    assert.equal(parseHealth(''), null);
    assert.equal(parseHealth('garbage'), null);
});

await test('commandWord names the command a Bash line runs', () => {
    assert.equal(commandWord('FOO=1 sudo /usr/bin/make -j4'), 'make');
    assert.equal(commandWord('cd /x && python3 a.py'), 'python3');
    assert.equal(commandWord('# note\nls -la'), 'ls');
    assert.equal(commandWord('cd /tmp'), 'cd');
    assert.equal(commandWord(''), '');
});

await test('running figures add up model, tool, sub-agent and break events', () => {
    const f = emptyFigures();
    const res = (o) => recordExchange(f, { type: 'response', agent: 'main', ...o }, 'main', 1000);
    res({ stop: 'tool_use', ms: 3000, firstMs: 1000, usage: { input: 10, cacheRead: 0, cacheWrite: 90, output: 200 },
        toolCalls: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    res({ stop: 'end', ms: 2000, firstMs: 1000, usage: { input: 5, cacheRead: 100, cacheWrite: 0, output: 100,
        limits: [{ name: 'requests', limit: 5, remaining: 4, resetAt: null }] } });
    recordExchange(f, { type: 'response', agent: 'sub-agent 1', stop: 'end', ms: 1000, usage: { input: 1, cacheRead: 0, output: 1 } });
    recordExchange(f, { type: 'tool', name: 'Bash', input: { command: 'cd /w && make' }, ms: 400, chars: 9000, capped: true, via: 'vm',
        health: { load1: 1 } });
    recordExchange(f, { type: 'tool', name: 'Bash', input: { command: 'make test' }, ms: 200, isError: true, stopped: true, via: 'vm' });
    recordExchange(f, { type: 'tool', name: 'Read', ms: 10, chars: 100, via: 'page' });
    recordExchange(f, { type: 'tool', name: 'Delegate', ms: 9999, via: 'model' });
    recordExchange(f, { type: 'compaction', agent: 'main', after: 50 });
    recordExchange(f, { type: 'error', network: true, attempt: 1, retryInMs: 5000 });
    recordExchange(f, { type: 'error', network: true, attempt: 2, retryInMs: 5000 });
    recordExchange(f, { type: 'error', message: 'API error 500' });
    recordExchange(f, { type: 'user', agent: 'sub-agent 1', text: '[You stopped... write your final report for the agent]' });
    recordSubAgent(f, 'done');
    recordSubAgent(f, 'bogus');
    assert.deepEqual(f.replies, { tool_use: 1, end: 2, error: 1 });
    assert.deepEqual(f.context.map((p) => [p[1], p[2]]), [[300, 0], [205, 0], [50, 1]]);   // only main's
    assert.deepEqual(f.cache, { requests: 3, cold: 2 });
    assert.deepEqual(f.steps, { withCalls: 1, calls: 3, maxParallel: 3 });
    assert.deepEqual(f.bash, { make: 2 });
    assert.deepEqual(f.via, { vm: 600, page: 10 });   // the sub-agent's own time isn't double-counted
    assert.equal(f.health.load1, 1);
    assert.equal(f.limits.list[0].remaining, 4);
    assert.deepEqual(f.breaks, { outages: 1, outageMs: 10000, pauses: 0, pauseMs: 0, resumes: 0 });
    assert.equal(f.subs.done, 1);
    assert.equal(f.subs.wrapUps, 1);
    const sm = figuresSummary(f);
    assert.equal(sm.replies, 4);
    assert.equal(sm.tokensPerSecond, 300 / 3);   // 300 tokens over 2 s + 1 s of streaming
    assert.equal(sm.firstMsAvg, 1000);
    assert.equal(sm.parallelAvg, 3);
    const bash = sm.tools.find((t) => t.name === 'Bash');
    assert.deepEqual([bash.calls, bash.failed, bash.stopped, bash.capped, bash.medianMs, bash.maxMs, bash.avgChars],
        [2, 1, 1, 1, 300, 400, 4500 + Math.round(String('').length / 2)]);
    // An older record gets the missing parts, and keeps what it has.
    const old = figuresShape({ replies: { end: 7 }, speed: { n: 1 } });
    assert.equal(old.replies.end, 7);
    assert.equal(old.speed.n, 1);
    assert.equal(old.speed.tokens, 0);
    assert.deepEqual(old.context, []);
});

await test('the agent logs the first-token time and each call\'s size, cut, stop and route', async () => {
    const logged = [];
    const provider = scripted([]);
    let n = 0;
    provider.step = async ({ onText, onUsage }) => {
        n++;
        await new Promise((r) => setTimeout(r, 20));
        if (n === 1) return { stop: 'tool_use', toolCalls: [{ id: 'r', name: 'Read', input: { path: 'a.txt' } }] };
        onText('ok');
        onUsage({ input: 1, output: 2 });
        return { stop: 'end' };
    };
    await new Agent({ provider, tools, toolOutputMax: 1000, log: (e) => logged.push(e) }).send('go');
    const tool = logged.find((e) => e.type === 'tool');
    assert.equal(tool.via, 'vm');
    assert.equal(tool.capped, false);
    assert.equal(tool.stopped, false);
    assert.ok(tool.chars > 0);
    const [r1, r2] = logged.filter((e) => e.type === 'response');
    assert.equal(r1.firstMs, null);   // no text: nothing streamed
    assert.ok(r2.firstMs >= 15 && r2.firstMs <= r2.ms);
});

/* A VM as bash.js uses it: the volume ops, over real stores. */
function volumeVM() {
    const stores = { workspace: new Fs9pStore('workspace', null), skills: new Fs9pStore('skills', null) };
    return {
        stores,
        volumeList: async (v, p) => stores[v].listDir(p),
        volumeGetFile: async (v, p) => stores[v].getFile(p),
        volumePutFile: async (v, p, b) => stores[v].putFile(p, b),
        volumeDelete: async (v, p) => stores[v].removePath(p),
        volumeMkdir: async (v, p) => { stores[v]._mkdirp(p); return 0; },
        volumeRename: async (v, a, b) => stores[v].rename(a, b),
    };
}
const MOUNTS = [['/workspace', 'workspace'], ['/agent/skills', 'skills']];

await test('bash.js runs commands on the page\'s volumes, with /tmp in memory', async () => {
    const vm = volumeVM();
    const js = createJsBash({ vm: () => vm, mounts: MOUNTS });
    const run = (command, extra = {}) => js.run({ command, shell: 'main', cwd: '/workspace', timeoutMs: 20000, ...extra });
    let r = await run('mkdir -p src && printf "b\\na\\nb\\n" > src/x.txt && sort -u src/x.txt | wc -l');
    assert.equal(r.rc, 0, r.out);
    assert.equal(r.out.trim(), '2');
    assert.equal(new TextDecoder().decode(vm.stores.workspace.getFile('/src/x.txt')), 'b\na\nb\n');
    r = await run('echo more >> src/x.txt; grep -c b src/x.txt; ls /; ls /agent');
    assert.equal(r.out, '2\nagent\ntmp\nworkspace\nskills\n');
    // A directory change and a function carry over, as in a shell.
    r = await run('cd src && greet() { echo "hi $1"; }');
    assert.equal(r.cwd, '/workspace/src');
    r = await run('greet you; pwd', { cwd: '/workspace/src' });
    assert.equal(r.out, 'hi you\n/workspace/src\n');
    // mv within a volume renames; across into /tmp it copies and deletes.
    r = await run('mv x.txt y.txt && mv y.txt /tmp/y.txt && cat /tmp/y.txt | head -1 && ls', { cwd: '/workspace/src' });
    assert.equal(r.rc, 0, r.out);
    assert.equal(r.out, 'b\n');
    assert.equal(vm.stores.workspace.getFile('/src/y.txt'), null);
    // Outside the volumes nothing exists, and no other program runs.
    r = await run('cat /etc/os-release');
    assert.notEqual(r.rc, 0);
    r = await run('python3 -V');
    assert.equal(r.rc, 127);
    assert.match(r.out, /command not found/);
    // The user's environment variables reach it.
    r = await run('echo $GREETING', { env: { GREETING: 'hello' } });
    assert.equal(r.out, 'hello\n');
    // An endless loop ends at bash.js's own guard (it runs on microtasks, so no
    // timer fires meanwhile) and fails.
    r = await run('while true; do :; done');
    assert.notEqual(r.rc, 0);
    assert.equal(r.timedOut, false);
    // A stop answers at once.
    const ctl = new AbortController();
    ctl.abort();
    r = await run('echo never', { signal: ctl.signal });
    assert.equal(r.aborted, true);
});

await test('the Bash tool goes to bash.js when the setting is on, and tells the model so', async () => {
    const vm = volumeVM();
    let on = false;
    const js = createJsBash({ vm: () => vm, mounts: MOUNTS });
    const bridge = new LocalBridge(work);
    const t = createTools(bridge, { cwd: '/workspace', jsBash: () => (on ? js : null) });
    const def = () => t.defs.find((d) => d.name === 'Bash');
    assert.match(def().description, /in the VM/);
    assert.ok(def().input_schema.properties.run_in_background);
    on = true;
    assert.match(def().description, /bash\.js/);
    assert.equal(def().input_schema.properties.run_in_background, undefined);
    const out = {};
    let r = await t.run('Bash', { command: 'echo hi > a.txt; cat a.txt' }, { out });
    assert.deepEqual(r, { content: 'hi\n', isError: false });
    assert.equal(out.via, 'page');
    r = await t.run('Bash', { command: 'false' });
    assert.deepEqual(r, { content: '[Exit code 1.]', isError: true });
    r = await t.run('Bash', { command: 'sleep 1', run_in_background: true });
    assert.equal(r.isError, true);
    assert.match(r.content, /unknown parameter "run_in_background"/);   // not offered in bash.js's schema
    // A cd moves the tools' shell too, so Read resolves against it.
    r = await t.run('Bash', { command: 'mkdir -p d && cd d' });
    assert.equal(t.cwd, '/workspace/d');
    assert.match(r.content, /^\[The working directory is now \/workspace\/d: /);
});

await test('distroLabel names a distro and its processor', () => {
    assert.equal(distroLabel('alpine-3.20-x86', 'x86'), 'Alpine 3.20 (x86)');
    assert.equal(distroLabel('debian-13-riscv64-lite', 'riscv64'), 'Debian 13 lite (riscv64)');
    assert.equal(distroLabel('x86', 'x86'), 'x86');
});

await test('a turn gives up after networkRetries failures in a row; 0 keeps trying', async () => {
    let count = 0;
    const p1 = scripted([]);
    p1.step = async () => { count++; throw new TypeError('Failed to fetch'); };
    const logged = [];
    const agent = new Agent({ provider: p1, tools, networkRetryMs: [1], networkRetries: () => 3, log: (e) => logged.push(e) });
    await assert.rejects(agent.send('go'), /gave up after 3 tries/);
    assert.equal(count, 4);   // the first ask, then three more
    assert.ok(logged.some((e) => e.type === 'error' && e.gaveUp));
    assert.equal(NETWORK_RETRIES, 15);
    // 0: no limit, until the connection is back.
    const p2 = scripted([]);
    let k = 0;
    p2.step = async ({ onText }) => { if (k++ < 30) throw new TypeError('Failed to fetch'); onText('ok'); return { stop: 'end' }; };
    assert.equal((await new Agent({ provider: p2, tools, networkRetryMs: [0], networkRetries: 0 }).send('go')).stop, 'end');
    assert.equal(k, 31);
});

await test('an HTTP error answer is not taken for a network failure', () => {
    const e = apiError(504, '{"error":{"message":"upstream request timed out"}}');
    assert.equal(e.status, 504);
    assert.match(e.message, /API error 504: upstream request timed out/);
    assert.equal(isNetworkError(e), false);
});

await test('lastLines keeps the end of long output', () => {
    assert.deepEqual(lastLines('a\nb\nc\n', 0), { text: 'a\nb\nc\n', total: null });
    assert.deepEqual(lastLines('a\nb\nc\n', 3), { text: 'a\nb\nc\n', total: null });
    assert.deepEqual(lastLines('a\nb\nc\n', 2), { text: 'b\nc\n', total: 3 });
    assert.deepEqual(lastLines('a\nb\nc', 1), { text: 'c', total: 3 });
});

await test('Bash gives the model only the last bashKeepLines lines, and says so', async () => {
    const t = createTools(new LocalBridge(work), { cwd: rootSh, bashKeepLines: () => 3 });
    let r = await t.run('Bash', { command: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo line$i; done' });
    assert.equal(r.isError, false);
    assert.match(r.content, /^line8\nline9\nline10\n\[Showing the last 3 of 10 lines of output/);
    r = await t.run('Bash', { command: 'echo short' });
    assert.equal(r.content, 'short\n');
    // A bridge that cut the output itself (the guest's out.tail) says how many lines there were.
    const cut = { exec: async () => ({ rc: 0, out: new TextEncoder().encode('y\nz\n'), outLines: 500, cwd: null, files: {} }) };
    r = await createTools(cut, { bashKeepLines: () => 2 }).run('Bash', { command: 'seq 500' });
    assert.match(r.content, /^y\nz\n\[Showing the last 2 of 500 lines/);
});

await test('the guest job keeps the last lines of a long output in out.tail', () => {
    // The step GuestBridge's JOB runs after the command, on a real sh.
    const dir = join(work, 'keep');
    mkdirSync(dir);
    writeFileSync(join(dir, 'out'), Array.from({ length: 10 }, (_, i) => `l${i + 1}\n`).join(''));
    writeFileSync(join(dir, 'keep'), '4');
    const step = 'D=$1; if [ -s "$D/keep" ]; then k=$(cat "$D/keep"); n=$(wc -l <"$D/out" 2>/dev/null || echo 0); '
        + 'if [ "$n" -gt "$k" ] 2>/dev/null; then tail -n "$k" "$D/out" >"$D/out.tail"; echo "$n" >"$D/out.lines"; fi; fi';
    spawnSync(SH, ['-c', step, 'sh', shPath(dir)]);
    assert.equal(readFileSync(join(dir, 'out.tail'), 'utf8'), 'l7\nl8\nl9\nl10\n');
    assert.equal(readFileSync(join(dir, 'out.lines'), 'utf8').trim(), '10');
});

await test('a new sub-agent never takes a shell that already exists', async () => {
    let delegate;
    const t = createTools(new LocalBridge(work), { cwd: rootSh, delegate: (i, c) => delegate(i, c) });
    // As after a reload: resumed sub-agents already have sub-agent-1 and sub-agent-2.
    t.forShell('sub-agent-1');
    t.forShell('sub-agent-2');
    const shells = [];
    delegate = createDelegate({ tools: t.without(DELEGATE_TOOL), view: (info) => { shells.push(info.shell); return {}; } });
    const parent = scripted([]);
    parent.fork = () => scripted([{ stop: 'end', text: 'done' }]);
    await delegate({ prompt: 'p', description: 'd' }, { provider: parent, tools: t });
    assert.deepEqual(shells, ['sub-agent-3']);
});

await test('streamed tool names: repeats, pieces and a name re-sent whole', () => {
    const known = new Set(['Bash', 'aa', 'Read']);
    const merge = (deltas, k = known) => { const c = {}; for (const d of deltas) mergeCall(c, d, k); return c.function.name; };
    assert.equal(merge([{ function: { name: 'Bash' } }, { function: { name: 'Bash', arguments: '{}' } }]), 'Bash');
    assert.equal(merge([{ function: { name: 'a' } }, { function: { name: 'a' } }]), 'aa');
    assert.equal(merge([{ function: { name: 'Re' } }, { function: { name: 'ad' } }]), 'Read');
    assert.equal(merge([{ function: { name: 'Ba' } }, { function: { name: 'Bash' } }]), 'Bash');
    // Without a tool list, a repeat stays a repeat (as before).
    assert.equal(merge([{ function: { name: 'Bash' } }, { function: { name: 'Bash' } }], null), 'Bash');
});

await test('a deletion on disk spares what changed there since the scan', async () => {
    const { vm, disk, links } = await linked({ 'a.txt': 'alpha', d: { 'x.txt': 'x' } });
    await links.link(disk, '/work');
    // Deleted in the workspace, the file and the whole folder...
    vm.store.removePath('/work/proj/a.txt');
    vm.store.removePath('/work/proj/d');
    // ...while on disk, after the pass looked, a.txt is edited and d gets a new file.
    const scan = links._scanDisk.bind(links);
    links._scanDisk = async (h) => {
        const r = await scan(h);
        disk.at('a.txt').set('edited');
        (await disk.at('d').getFileHandle('new.txt', { create: true })).set('new');
        return r;
    };
    await links.sync();
    links._scanDisk = scan;
    assert.deepEqual(disk.dump(), { 'a.txt': 'edited', 'd/': '', 'd/new.txt': 'new' });
    // The next pass brings both back into the workspace.
    await links.sync();
    assert.deepEqual(wsDump(vm, '/work/proj'), { 'a.txt': 'edited', 'd/': '', 'd/new.txt': 'new' });
    assert.deepEqual(disk.dump(), { 'a.txt': 'edited', 'd/': '', 'd/new.txt': 'new' });
});

rmSync(base, { recursive: true, force: true });
console.log(process.exitCode ? `some tests FAILED (${passed} passed)` : `all ${passed} tests passed`);
