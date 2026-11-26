// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Mode and to-do tests: the mode store (built-in modes, the user's, the prompt
 * from before modes), each mode's tool policy through the tools layer, and the
 * TodoWrite / TodoRead tools with a per-agent store.
 * Run: node tests/modes.test.mjs
 */

import assert from 'node:assert/strict';

import {
    BUILTIN_MODES, DEFAULT_MODE, isDefault, MODES_KEY, ModeStore, modePolicy, modeShape, newModeId, SUB_MODE,
} from '../js/modes.js';
import { createTools, formatTodos, TODO_READ, TODO_WRITE, todoList, ToolError, ASK_TOOL, DELEGATE_TOOL } from '../js/tools.js';
import { renderPrompt, toolArgText } from '../js/Agent.js';

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; } catch (e) {
        console.error(`FAIL ${name}\n`, e);
        process.exitCode = 1;
    }
}
const memory = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const noBridge = { exec: async () => { throw new Error('no VM here'); } };

await test('the built-in modes: build first and offered, plan without Edit and Write, sub-agent hidden without Delegate', () => {
    const { modes, migrated } = new ModeStore({ storage: memory() }).load();
    assert.equal(migrated, false);
    assert.deepEqual(modes.map((m) => m.id), ['build', 'plan', SUB_MODE]);
    assert.equal(modes[0].id, DEFAULT_MODE);
    const [build, plan, sub] = modes;
    assert.ok(!build.hidden && !plan.hidden && sub.hidden && sub.sub);
    assert.equal(modePolicy(plan, 'Edit'), false);
    assert.equal(modePolicy(plan, 'Write'), false);
    assert.equal(modePolicy(plan, 'Bash'), undefined);
    assert.equal(modePolicy(sub, DELEGATE_TOOL), false);
    assert.equal(modePolicy(sub, ASK_TOOL), false);
    for (const m of modes) {
        assert.ok(m.builtin && isDefault(m), m.id);
        // Every built-in prompt says which model it is, and which mode.
        assert.match(m.prompt, /\{\{VAR_MODEL_NAME\}\}/);
        assert.match(m.prompt, /\{\{VAR_MODEL_ID\}\}/);
    }
    assert.match(renderPrompt(build.prompt, { MODEL_NAME: 'Claude Opus 5.5', MODEL_ID: 'claude-opus-5-5', MODE: 'Build' }), /running on Claude Opus 5\.5 \(model id claude-opus-5-5\)/);
});

await test('the edited prompt from before modes becomes the build mode\'s, once', () => {
    const storage = memory();
    const store = new ModeStore({ storage });
    const r = store.load({ systemPrompt: 'My old prompt' });
    assert.equal(r.migrated, true);
    assert.equal(r.modes[0].prompt, 'My old prompt');
    assert.equal(isDefault(r.modes[0]), false);
    store.save(r.modes);
    const again = store.load({ systemPrompt: 'My old prompt' });
    assert.equal(again.migrated, false);
    assert.equal(again.modes[0].prompt, 'My old prompt');
});

await test('the user\'s modes are kept after the built-in ones; a bad record is dropped, a missing built-in comes back', () => {
    const storage = memory();
    storage.setItem(MODES_KEY, JSON.stringify([
        { id: 'review', name: 'Review', prompt: 'Review things.', hidden: true, tools: { Bash: 'off', Write: 'maybe' } },
        { id: 'plan', name: 'Planner', prompt: 'P', tools: {} },
        { id: '../evil', name: 'x', prompt: 'y' },
        null,
    ]));
    const { modes } = new ModeStore({ storage }).load();
    assert.deepEqual(modes.map((m) => m.id), ['build', 'plan', SUB_MODE, 'review']);
    assert.equal(modes[1].name, 'Planner');
    assert.deepEqual(modes[1].tools, {});
    const review = modes[3];
    assert.equal(review.builtin, false);
    assert.equal(review.sub, false);
    assert.deepEqual(review.tools, { Bash: 'off' });
    assert.equal(newModeId('Review', modes), 'review-2');
    assert.equal(newModeId('  Code review! ', modes), 'code-review');
    // A user's mode can't make itself the sub-agent one.
    assert.equal(modeShape({ id: 'x', name: 'x', prompt: 'p', sub: true }).sub, false);
});

await test('a view\'s policy turns tools on or off over the defaults; excluded tools stay out', async () => {
    const disabled = new Set(['Grep']);
    const tools = createTools(noBridge, { isEnabled: (n) => !disabled.has(n), delegate: async () => 'r', ask: async () => ({}) });
    const names = (v) => v.defs.map((d) => d.name);
    assert.ok(!names(tools).includes('Grep'));
    const plan = BUILTIN_MODES.find((m) => m.id === 'plan');
    const planView = tools.withPolicy((n) => modePolicy(plan, n));
    assert.ok(!names(planView).includes('Edit') && !names(planView).includes('Write') && names(planView).includes('Read'));
    assert.match((await planView.run('Write', { path: '/workspace/a', content: 'x' })).content, /turned off/);
    // A mode can turn on what the defaults turn off.
    const on = tools.withPolicy((n) => (n === 'Grep' ? true : undefined));
    assert.ok(names(on).includes('Grep'));
    // The policy carries into another shell; without() still wins over it.
    const sub = on.forShell('s1').without(DELEGATE_TOOL, ASK_TOOL).withPolicy((n) => (n === DELEGATE_TOOL ? true : undefined));
    assert.ok(!names(sub).includes(DELEGATE_TOOL) && !names(sub).includes(ASK_TOOL));
    assert.match((await sub.run(DELEGATE_TOOL, { description: 'd', prompt: 'p' })).content, /not available here/);
});

await test('TodoWrite keeps the list per agent, TodoRead reads it back; bad lists are refused', async () => {
    const lists = new Map();
    const todos = { get: (ctx) => lists.get(ctx.meta.chatId) || [], set: (ctx, list) => { lists.set(ctx.meta.chatId, list); } };
    const tools = createTools(noBridge, { todos });
    assert.ok(tools.defs.some((d) => d.name === TODO_WRITE) && tools.defs.some((d) => d.name === TODO_READ));
    const out = {};
    const a = { meta: { chatId: 'a' }, out };
    const r = await tools.run(TODO_WRITE, { todos: [{ content: '  Run   the tests ', status: 'in_progress' }, { content: 'Fix', status: 'pending' }] }, a);
    assert.equal(r.isError, false);
    assert.equal(out.via, 'page');
    assert.equal(r.content, 'To-do list (0 of 2 done):\n1. [~] Run the tests\n2. [ ] Fix');
    assert.deepEqual(lists.get('a'), [{ content: 'Run the tests', status: 'in_progress' }, { content: 'Fix', status: 'pending' }]);
    // Another agent has its own.
    assert.equal((await tools.run(TODO_READ, {}, { meta: { chatId: 'b' } })).content, 'The to-do list is empty.');
    assert.match((await tools.run('todo_read', {}, a)).content, /0 of 2 done/);
    assert.equal((await tools.run(TODO_WRITE, { todos: [{ content: 'x', status: 'done' }] }, a)).isError, true);
    assert.throws(() => todoList({ todos: 'x' }), ToolError);
    assert.throws(() => todoList({ todos: [{ content: '', status: 'pending' }] }), /no "content"/);
    assert.equal(formatTodos([{ content: 'a', status: 'completed' }]), 'To-do list (1 of 1 done):\n1. [x] a');
    // Without a store there are no to-do tools.
    assert.ok(!createTools(noBridge).defs.some((d) => d.name === TODO_WRITE));
    assert.equal(toolArgText({ name: TODO_WRITE, input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } }), '1 of 2 done · now: b');
});

console.log(process.exitCode ? `some tests FAILED (${passed} passed)` : `all ${passed} tests passed`);
