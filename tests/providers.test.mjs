// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Provider tests: the presets (cloud and local), and how the OpenAI-compatible
 * client copes with each API's differences, against a fake fetch: reasoning under
 * its own names and sent back, Mistral's content parts, Gemini's thought
 * signatures on tool calls streamed without `index`, OpenRouter's
 * reasoning_details, usage fields, and error bodies.
 * Run: node tests/providers.test.mjs
 */

import assert from 'node:assert/strict';

import { callIndex, errorMessage, listOpenAIModels, mergeDetails, OpenAICompatProvider, openAIUsage } from '../js/providers/openai.js';
import { baseURLOf, Connections, listModels, modelSettingsShape, modelTuning, offeredModels, PROVIDER_TYPES, providerShape, typeOf } from '../js/providerStore.js';
import { ClaudeProvider } from '../js/providers/claude.js';
import { WebLLMProvider } from '../js/providers/webllm.js';

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; } catch (e) {
        console.error(`FAIL ${name}\n`, e);
        process.exitCode = 1;
    }
}

/* A fetch that answers one request with an event stream of `chunks`, recording what was sent. */
function fakeStream(chunks, seen = []) {
    return async (url, opts) => {
        seen.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
        const text = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
        return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
}
const delta = (d, extra = {}) => ({ choices: [{ delta: d, ...extra }] });
const make = (o = {}) => new OpenAICompatProvider({ apiKey: 'k', baseURL: 'https://x/v1', model: 'm', system: 'S', tools: [], ...o });
const run = async (p) => {
    const out = { text: '', thinking: '', usage: null };
    const r = await p.step({ onText: (t) => { out.text += t; }, onThinking: (t) => { out.thinking += t; }, onUsage: (u) => { out.usage = u; } });
    return { ...out, r };
};

await test('presets: cloud ones have a fixed URL and want a key; local ones a default URL and none', () => {
    const cloud = ['openai', 'gemini', 'openrouter', 'mistral', 'groq', 'deepseek', 'xai', 'moonshot', 'together', 'fireworks', 'cerebras', 'deepinfra', 'huggingface'];
    const local = ['ollama', 'lmstudio', 'openwebui', 'llamacpp', 'vllm', 'localai', 'jan', 'koboldcpp', 'textgen', 'gpt4all'];
    for (const id of cloud) {
        const t = typeOf({ type: id });
        assert.ok(t && t.kind === 'openai' && t.key && !t.custom && /^https:\/\//.test(t.baseURL), id);
    }
    for (const id of local) {
        const t = typeOf({ type: id });
        assert.ok(t && t.local && t.custom && !t.key && /^http:\/\/localhost:\d+\//.test(t.defaultURL) && t.cors, id);
        const p = providerShape({ type: id });
        assert.equal(baseURLOf(p), t.defaultURL.replace(/\/$/, ''), id);
        // The URL can be changed, like a custom server's.
        assert.equal(baseURLOf(providerShape({ type: id, baseURL: 'http://box:9/v1/' })), 'http://box:9/v1');
    }
    assert.equal(new Set(PROVIDER_TYPES.map((t) => t.type)).size, PROVIDER_TYPES.length);
    assert.equal(typeOf({ type: 'gemini' }).baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai');
});

await test('OpenRouter names the app in its headers; a listing sends them, and a local server needs no key', async () => {
    const seen = [];
    globalThis.fetch = async (url, opts) => { seen.push({ url, headers: opts.headers }); return new Response(JSON.stringify({ data: [{ id: 'a/b', context_length: 1000 }] })); };
    const models = await listModels(providerShape({ type: 'openrouter', apiKey: 'k' }));
    assert.deepEqual(models, [{ id: 'a/b', label: 'a/b', contextWindow: 1000 }]);
    assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/models');
    assert.equal(seen[0].headers['X-Title'], 'TinyEMU Agent');
    assert.ok(seen[0].headers['HTTP-Referer']);
    await listModels(providerShape({ type: 'ollama' }));
    assert.equal(seen[1].url, 'http://localhost:11434/v1/models');
    assert.equal(seen[1].headers.authorization, undefined);
    await assert.rejects(listModels(providerShape({ type: 'mistral' })), /API key first/);
});

await test('Hugging Face\'s models list their context window per serving provider', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'org/m', providers: [{ context_length: 32768 }, { context_length: 131072 }, {}] }] }));
    assert.equal((await listOpenAIModels({ baseURL: 'https://h/v1', apiKey: 'k' }))[0].contextWindow, 131072);
});

await test('error bodies of every shape give the API\'s own message', () => {
    assert.equal(errorMessage(400, '[{"error":{"code":400,"message":"Please pass a valid API key"}}]'), 'API error 400: Please pass a valid API key');
    assert.equal(errorMessage(400, '{"code":"invalid-argument","error":"Incorrect API key provided."}'), 'API error 400: Incorrect API key provided.');
    assert.equal(errorMessage(401, '{"detail":"Invalid API Key"}'), 'API error 401: Invalid API Key');
    assert.equal(errorMessage(422, '{"detail":[{"msg":"field required"}]}'), 'API error 422: field required');
    assert.equal(errorMessage(401, '{"message":"Wrong API Key","code":"wrong_api_key"}'), 'API error 401: Wrong API Key');
    assert.equal(errorMessage(500, 'oops'), 'API error 500: oops');
});

await test('usage: cached tokens from OpenAI, Together and DeepSeek fields', () => {
    assert.equal(openAIUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 } }).cacheRead, 4);
    assert.equal(openAIUsage({ prompt_tokens: 10, cached_tokens: 3 }).cacheRead, 3);
    assert.deepEqual(openAIUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 6, completion_tokens: 2 }), { input: 4, cacheWrite: 0, cacheRead: 6, output: 2, thinking: null });
});

await test('reasoning_content (DeepSeek, Moonshot) shows as thinking and goes back on the message', async () => {
    const p = make();
    p.addUser('hi');
    globalThis.fetch = fakeStream([delta({ reasoning_content: 'let me ' }), delta({ reasoning_content: 'think' }),
        delta({ content: 'Answer' }), { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }, '[DONE]']);
    const out = await run(p);
    assert.equal(out.thinking, 'let me think');
    assert.equal(out.text, 'Answer');
    assert.equal(out.usage.output, 3);
    assert.deepEqual(p.messages.at(-1), { role: 'assistant', content: 'Answer', reasoning_content: 'let me think' });
    const seen = [];
    globalThis.fetch = fakeStream([delta({ content: 'ok' }), '[DONE]'], seen);
    p.addUser('more');
    await run(p);
    assert.equal(seen[0].body.messages[2].reasoning_content, 'let me think');
});

await test('reasoning (Groq, OpenRouter, Together) keeps its own name; OpenRouter\'s reasoning_details are merged and kept', async () => {
    const p = make();
    p.addUser('hi');
    globalThis.fetch = fakeStream([
        delta({ reasoning: 'a', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'a' }] }),
        delta({ reasoning: 'b', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'b', signature: 'sig' }] }),
        delta({ content: 'done' }), '[DONE]']);
    const out = await run(p);
    assert.equal(out.thinking, 'ab');
    const m = p.messages.at(-1);
    assert.equal(m.reasoning, 'ab');
    assert.equal(m.reasoning_content, undefined);
    assert.deepEqual(m.reasoning_details, [{ type: 'reasoning.text', index: 0, text: 'ab', signature: 'sig' }]);
    assert.deepEqual(mergeDetails([], [{ type: 'reasoning.encrypted', data: 'x' }]), [{ type: 'reasoning.encrypted', data: 'x' }]);
});

await test('Mistral\'s content parts: text is the reply, thinking parts are thinking', async () => {
    const p = make();
    p.addUser('hi');
    globalThis.fetch = fakeStream([
        delta({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }] }),
        delta({ content: [{ type: 'text', text: 'Hello' }] }), delta({ content: ' there' }), '[DONE]']);
    const out = await run(p);
    assert.equal(out.thinking, 'hmm');
    assert.equal(out.text, 'Hello there');
    assert.equal(p.messages.at(-1).content, 'Hello there');
});

await test('tool calls without index (Gemini): each named one starts a call; its thought signature stays on it', async () => {
    const sig = { google: { thought_signature: 'SIG1' } };
    assert.equal(callIndex([], { function: { name: 'a' } }), 0);
    assert.equal(callIndex([{ id: 'x' }], { extra_content: sig }), 0);
    assert.equal(callIndex([{ id: 'x' }], { id: 'y', function: { arguments: '{}' } }), 1);
    assert.equal(callIndex([{ id: 'x' }, {}], { index: 0 }), 0);
    const p = make();
    p.addUser('hi');
    globalThis.fetch = fakeStream([
        delta({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' }, extra_content: sig }] }),
        delta({ tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"/a"}' } }] }),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']);
    const out = await run(p);
    assert.equal(out.r.stop, 'tool_use');
    assert.deepEqual(out.r.toolCalls.map((c) => [c.id, c.name, c.input]), [['c1', 'bash', { command: 'ls' }], ['c2', 'read', { path: '/a' }]]);
    const m = p.messages.at(-1);
    assert.deepEqual(m.tool_calls[0].extra_content, sig);
    assert.equal(m.tool_calls[1].extra_content, undefined);
    // Sent back as it came, with the results after both calls.
    p.addToolResults([{ id: 'c1', content: 'x', isError: false }, { id: 'c2', content: 'y', isError: false }]);
    const seen = [];
    globalThis.fetch = fakeStream([delta({ content: 'ok' }), '[DONE]'], seen);
    await run(p);
    const sent = seen[0].body.messages;
    assert.deepEqual(sent[2].tool_calls[0].extra_content, sig);
    assert.deepEqual(sent.slice(3).map((x) => x.tool_call_id), ['c1', 'c2']);
});

await test('streamed tool calls with index still assemble in pieces (OpenAI)', async () => {
    const p = make();
    p.addUser('hi');
    globalThis.fetch = fakeStream([
        delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'bash', arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'and":"pwd"}' } }] }), '[DONE]']);
    const out = await run(p);
    assert.deepEqual(out.r.toolCalls, [{ id: 'c1', name: 'bash', input: { command: 'pwd' } }]);
});

await test('the thinking level is sent as reasoning_effort, every level, none when unset', async () => {
    for (const effort of ['none', 'minimal', 'xhigh', '']) {
        const seen = [];
        const p = make({ effort });
        p.addUser('hi');
        globalThis.fetch = fakeStream([delta({ content: 'ok' }), '[DONE]'], seen);
        await run(p);
        assert.equal(seen[0].body.reasoning_effort, effort || undefined);
    }
});

await test("a model's own settings: kept in range, over the listing, through listings and the model menu", () => {
    assert.deepEqual(modelSettingsShape({ label: ' Fast ', contextWindow: '32000', maxOutput: 0, temperature: 0.333, junk: 1 }),
        { label: 'Fast', contextWindow: 32000, temperature: 0.33 });
    assert.equal(modelSettingsShape({ contextWindow: 10, temperature: 9 }), null);
    const p = providerShape({ type: 'openai', apiKey: 'k', models: [{ id: 'g', label: 'G (g)', contextWindow: 128000 }], enabled: ['g'],
        modelSettings: { g: { contextWindow: 64000, maxOutput: 4096, temperature: 0.5, label: 'Mine' }, bad: { x: 1 } } });
    assert.deepEqual(Object.keys(p.modelSettings), ['g']);
    assert.deepEqual(modelTuning(p, 'g'), { contextWindow: 64000, maxOutput: 4096, temperature: 0.5, windowSet: true, tokenField: 'max_completion_tokens' });
    assert.deepEqual(modelTuning(providerShape({ type: 'groq', models: [{ id: 'x', contextWindow: 8000 }] }), 'x'),
        { contextWindow: 8000, maxOutput: null, temperature: null, windowSet: false, tokenField: 'max_tokens' });
    assert.deepEqual(offeredModels([p]).map((m) => [m.label, m.contextWindow]), [['Mine', 64000]]);
});

await test("the settings reach the requests: response size under each API's name, temperature, the window", async () => {
    const seen = [];
    globalThis.fetch = fakeStream([delta({ content: 'ok' }), '[DONE]'], seen);
    const cfg = providerShape({ id: 'o', type: 'openai', apiKey: 'k', models: [{ id: 'm', contextWindow: 100000 }], enabled: ['m'],
        modelSettings: { m: { maxOutput: 1000, temperature: 0.7, contextWindow: 50000 } } });
    const c = new Connections({ providers: () => [cfg], effort: () => '' });
    const conv = await c.conversation({ provider: 'o', model: 'm' }, { system: 's', tools: [] });
    assert.equal(conv.contextWindow, 50000);
    assert.equal(conv.tuning.windowSet, true);
    conv.addUser('hi');
    await run(conv);
    assert.equal(seen[0].body.max_completion_tokens, 1000);
    assert.equal(seen[0].body.max_tokens, undefined);
    assert.equal(seen[0].body.temperature, 0.7);
    // Changed while chats use it: the root and the given conversations take it.
    cfg.modelSettings = { m: { maxOutput: 2000 } };
    await c.retune({ provider: 'o', model: 'm' }, [conv]);
    conv.addUser('again');
    await run(conv);
    assert.equal(seen[1].body.max_completion_tokens, 2000);
    assert.equal(seen[1].body.temperature, undefined);
    // A cleared window goes back to the listed one.
    assert.equal(conv.contextWindow, 100000);
    assert.equal(conv.tuning.windowSet, false);
    // Other APIs: max_tokens; nothing set, nothing sent.
    const g = make();
    g.setTuning({ maxOutput: 300, tokenField: 'max_tokens' });
    g.addUser('x');
    globalThis.fetch = fakeStream([delta({ content: 'ok' }), '[DONE]'], seen);
    await run(g);
    assert.equal(seen[2].body.max_tokens, 300);
    const h = make();
    h.addUser('x');
    globalThis.fetch = fakeStream([delta({ content: 'ok' }), '[DONE]'], seen);
    await run(h);
    assert.ok(!('max_tokens' in seen[3].body) && !('temperature' in seen[3].body));
});

await test('Claude and in-browser models take the response size, and their forks keep it', () => {
    const cl = new ClaudeProvider({ apiKey: 'k', model: 'm', system: 's', tools: [], contextWindow: 200000 });
    assert.equal(cl.maxOutput, 64000);
    cl.setTuning({ maxOutput: 8000, contextWindow: 100000, windowSet: true });
    const f = cl.fork({ system: 's', tools: [] });
    assert.equal(f.maxOutput, 8000);
    assert.equal(f.contextWindow, 100000);
    const w = new WebLLMProvider({ model: 'x', system: 's', tools: [] });
    w.setTuning({ maxOutput: 512, temperature: 0.9, contextWindow: 4096 });
    assert.deepEqual([w.maxOutput, w.temperature, w.contextWindow], [512, 0.9, 4096]);
    w.setTuning({});
    assert.deepEqual([w.maxOutput, w.temperature, w.contextWindow], [2048, 0.2, 8192]);
});

console.log(process.exitCode ? `some tests FAILED (${passed} passed)` : `all ${passed} tests passed`);
