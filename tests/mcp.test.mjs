// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * MCP tests: the client and hub against a small Streamable HTTP server
 * (tests/fixtures/mcpServer.mjs) on this machine, and MCP tools in the tools layer.
 * Run: node tests/mcp.test.mjs
 */

import assert from 'node:assert/strict';

import {
    cleanSchema, checkMcpInput, formatToolResult, McpClient, McpHub, mcpToolName, parseHeaderLines, serverShape,
} from '../js/mcp.js';
import { createTools } from '../js/tools.js';
import { startMcpServer } from './fixtures/mcpServer.mjs';

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; } catch (e) {
        console.error(`FAIL ${name}\n`, e);
        process.exitCode = 1;
    }
}

const srv = await startMcpServer({ token: 'secret' });
const auth = { Authorization: 'Bearer secret' };

await test('the client initializes, keeps the session, and lists every page of tools', async () => {
    const c = new McpClient({ url: srv.url, headers: auth });
    const r = await c.connect();
    assert.equal(c.server.name, 'fixture');
    assert.equal(r.instructions, 'Use add for sums.');
    assert.ok(srv.sessions.has(c.session));
    const tools = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['add', 'slow_echo', 'fail']);
    await c.close();
    assert.equal(srv.sessions.has(c.session), false);
});

await test('a call answered with JSON, and one answered over an event stream', async () => {
    const c = new McpClient({ url: srv.url, headers: auth });
    await c.connect();
    assert.deepEqual(formatToolResult(await c.callTool('add', { a: 2, b: 3 })), { content: '5', isError: false });
    const answersBefore = srv.seen.answers.length;
    const r = formatToolResult(await c.callTool('slow_echo', { text: 'hi' }));
    assert.equal(r.isError, false);
    assert.match(r.content, /^hi\n\[image image\/png, about 3 bytes: not shown to the model\]$/);
    // The server's ping in the stream was answered.
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(srv.seen.answers.slice(answersBefore).some((m) => m.id === 'p1' && m.result));
    assert.deepEqual(formatToolResult(await c.callTool('fail', {})), { content: 'it broke', isError: true });
});

await test('a wrong token is an HTTP error; a lost session is set up again', async () => {
    await assert.rejects(new McpClient({ url: srv.url }).connect(), /HTTP 401/);
    const c = new McpClient({ url: srv.url, headers: auth });
    await c.connect();
    const old = c.session;
    srv.sessions.delete(old);   // the server restarted, say
    assert.equal(formatToolResult(await c.callTool('add', { a: 1, b: 1 })).content, '2');
    assert.notEqual(c.session, old);
});

await test('stopping a streamed call aborts it and tells the server', async () => {
    const c = new McpClient({ url: srv.url, headers: auth });
    await c.connect();
    const ctl = new AbortController();
    const p = c.callTool('slow_echo', { text: 'hang' }, ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(p);
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(srv.seen.cancelled.length >= 1);
});

await test('tool names fit the APIs, schemas are cleaned, inputs checked loosely', () => {
    assert.equal(mcpToolName('my server', 'get.file'), 'mcp__my_server__get_file');
    const long = mcpToolName('s', 'x'.repeat(100));
    assert.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long));
    assert.notEqual(long, mcpToolName('s', `${'x'.repeat(99)}y`));
    assert.deepEqual(cleanSchema({ $schema: 'x', properties: { a: {} } }), { type: 'object', properties: { a: {} } });
    assert.deepEqual(cleanSchema(undefined), { type: 'object', properties: {} });
    assert.equal(checkMcpInput({ required: ['a'] }, {}), 'missing required parameter "a"');
    assert.equal(checkMcpInput({ properties: {} }, { extra: 1 }), null);
    assert.equal(checkMcpInput({ properties: {}, additionalProperties: false }, { extra: 1 }), 'unknown parameter "extra"');
    assert.deepEqual(parseHeaderLines('Authorization: Bearer x\n\nbad line'), { pairs: [['Authorization', 'Bearer x']], problems: ['"bad line" is not "Name: value"'] });
    assert.equal(serverShape({}).enabled, true);
});

await test('a card shows an MCP call\'s arguments in short', async () => {
    const { toolArgText } = await import('../js/Agent.js');
    assert.equal(toolArgText({ name: 'mcp__calc__add', input: { a: 20, b: 22, s: 'x' } }), 'a=20 b=22 s="x"');
    assert.equal(toolArgText({ name: 'bash', input: { command: 'ls' } }), 'ls');
});

await test('the hub connects servers that are on, and their tools run through the tools layer', async () => {
    const servers = [
        serverShape({ id: 'a', name: 'calc', url: srv.url, headers: [['Authorization', 'Bearer secret']], disabledTools: ['fail'] }),
        serverShape({ id: 'b', name: 'nope', url: 'http://127.0.0.1:1/mcp' }),
        serverShape({ id: 'c', name: 'off', url: srv.url, enabled: false }),
    ];
    const hub = new McpHub({ servers: () => servers });
    await hub.sync();
    assert.equal(hub.status('a').status, 'ready');
    assert.equal(hub.status('b').status, 'failed');
    assert.match(hub.status('b').error, /reachable|CORS|fetch|ECONNREFUSED/i);
    assert.equal(hub.status('c').status, 'off');
    const names = hub.tools().map((t) => t.name);
    assert.deepEqual(names, ['mcp__calc__add', 'mcp__calc__slow_echo']);
    assert.match(hub.tools()[0].def.description, /^\[MCP server "calc", fixture\] Add two numbers\./);
    assert.equal(hub.tools()[1].def.input_schema.$schema, undefined);

    const extra = () => hub.tools().map((t) => ({
        name: t.name, def: t.def, via: 'mcp',
        check: (i) => checkMcpInput(t.def.input_schema, i),
        run: (input, ctx) => hub.call(t.server, t.tool, input, ctx.signal),
    }));
    const tools = createTools({ exec: async () => { throw new Error('no VM here'); } }, { extraTools: extra });
    assert.ok(tools.defs.some((d) => d.name === 'mcp__calc__add'));
    const out = {};
    assert.deepEqual(await tools.run('mcp__calc__add', { a: 4, b: 5 }, { out }), { content: '9', isError: false });
    assert.equal(out.via, 'mcp');
    // Loose names work for these too; a missing argument is caught before the server.
    assert.deepEqual(await tools.run('MCP__calc__add', { a: 1, b: 1 }), { content: '2', isError: false });
    assert.deepEqual(await tools.run('mcp__calc__add', { a: 1 }), { content: 'Invalid input: missing required parameter "b".', isError: true });
    // A tool turned off on the server's card isn't offered, nor run.
    assert.equal((await tools.run('mcp__calc__fail', {})).isError, true);
    assert.match((await tools.run('mcp__calc__fail', {})).content, /Unknown tool/);
    // Turning the server off takes its tools away.
    servers[0].enabled = false;
    await hub.sync();
    assert.equal(tools.defs.some((d) => d.name.startsWith('mcp__')), false);
});

await test('parallel calls wait for the connection being opened instead of replacing it', async () => {
    let inits = 0;
    const fetch = async (url, o) => {
        if (o?.body && JSON.parse(o.body).method === 'initialize') { inits++; await new Promise((r) => setTimeout(r, 30)); }
        return globalThis.fetch(url, o);
    };
    const servers = [serverShape({ id: 'a', name: 'calc', url: srv.url, headers: [['Authorization', 'Bearer secret']] })];
    const hub = new McpHub({ servers: () => servers, fetch });
    const rs = await Promise.all([1, 2, 3].map((n) => hub.call('a', 'add', { a: n, b: 1 })));
    assert.deepEqual(rs.map((r) => r.content), ['2', '3', '4']);
    assert.equal(inits, 1);
});

await test('two servers whose names match get tools of different names, each calling its own', async () => {
    const servers = [
        serverShape({ id: 'a', name: 'calc', url: srv.url, headers: [['Authorization', 'Bearer secret']], disabledTools: ['fail', 'slow_echo'] }),
        serverShape({ id: 'b', name: 'calc', url: srv.url, headers: [['Authorization', 'Bearer secret']], disabledTools: ['fail', 'slow_echo'] }),
    ];
    const hub = new McpHub({ servers: () => servers });
    await hub.sync();
    const tools = hub.tools();
    assert.deepEqual(tools.map((t) => t.name), ['mcp__calc__add', 'mcp__calc__add_2']);
    assert.deepEqual(tools.map((t) => t.def.name), ['mcp__calc__add', 'mcp__calc__add_2']);
    assert.deepEqual(tools.map((t) => t.server), ['a', 'b']);
});

await test('a server that never answers fails after the connect timeout', async () => {
    const fetch = (url, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)));
    const servers = [serverShape({ id: 'a', name: 'mute', url: 'http://127.0.0.1:9/mcp' })];
    const hub = new McpHub({ servers: () => servers, fetch, connectMs: 50 });
    const r = await hub.call('a', 'x', {});
    assert.equal(r.isError, true);
    assert.match(r.content, /not connected: no answer in/);
    // Stop ends the wait for a connection too.
    const stop = new AbortController();
    const hub2 = new McpHub({ servers: () => servers, fetch, connectMs: 60000 });
    const p = hub2.call('a', 'x', {}, stop.signal);
    stop.abort();
    assert.deepEqual(await p, { content: 'Stopped by the user.', isError: true });
    hub2.state.get('a').client.close();
});

srv.close();
console.log(process.exitCode ? `some tests FAILED (${passed} passed)` : `all ${passed} tests passed`);
