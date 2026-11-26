// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * A small MCP server over Streamable HTTP, for the tests and for driving the page:
 *   node -e "import('./tests/fixtures/mcpServer.mjs').then((m) => m.startMcpServer({ port: 8012 }))"
 * It keeps sessions (Mcp-Session-Id), allows any origin (CORS, the session header
 * exposed), wants `Authorization: Bearer <token>` when given a token, and has
 * three tools: `add` (answers with JSON), `slow_echo` (answers over an event
 * stream, after a ping request the client must answer) and `fail` (isError).
 */

import { createServer } from 'node:http';

const TOOLS = [
    { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
    { name: 'slow_echo', title: 'Echo, streamed', description: 'Echo the text back, over an event stream.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object' } },
];

export function startMcpServer({ port = 0, token = null, pageSize = 2 } = {}) {
    const sessions = new Set();
    const seen = { requests: [], cancelled: [], answers: [], deleted: 0 };
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };
    const server = createServer(async (req, res) => {
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
        if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, cors); res.end('unauthorized'); return; }
        const sid = req.headers['mcp-session-id'];
        if (req.method === 'DELETE') { sessions.delete(sid); seen.deleted++; res.writeHead(200, cors); res.end(); return; }
        let body = '';
        for await (const chunk of req) body += chunk;
        const msg = JSON.parse(body);
        const json = (obj, extra = {}) => { res.writeHead(200, { ...cors, 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
        if (msg.method === 'initialize') {
            const id = `s${Math.random().toString(36).slice(2)}`;
            sessions.add(id);
            json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0' }, instructions: 'Use add for sums.' } }, { 'Mcp-Session-Id': id });
            return;
        }
        if (!sessions.has(sid)) { res.writeHead(404, cors); res.end('no such session'); return; }
        if (msg.id === undefined || msg.result !== undefined || msg.error !== undefined) {
            // A notification, or the client's answer to our request.
            if (msg.method === 'notifications/cancelled') seen.cancelled.push(msg.params.requestId);
            if (msg.result !== undefined || msg.error !== undefined) seen.answers.push(msg);
            res.writeHead(202, cors);
            res.end();
            return;
        }
        seen.requests.push(msg.method);
        if (msg.method === 'tools/list') {
            const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
            const page = TOOLS.slice(start, start + pageSize);
            json({ jsonrpc: '2.0', id: msg.id, result: { tools: page, ...(start + pageSize < TOOLS.length ? { nextCursor: String(start + pageSize) } : {}) } });
            return;
        }
        if (msg.method === 'tools/call') {
            const { name, arguments: args } = msg.params;
            if (name === 'add') { json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args.a + args.b) }] } }); return; }
            if (name === 'fail') { json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } }); return; }
            if (name === 'slow_echo') {
                res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
                res.write(`: comment\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'ping' })}\n\n`);
                res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
                if (args.text === 'hang') return;   // never answers: for stopping
                setTimeout(() => {
                    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: args.text }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } })}\n\n`);
                    res.end();
                }, 20);
                return;
            }
            json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `no tool ${name}` } });
            return;
        }
        json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        resolve({ url: `http://127.0.0.1:${server.address().port}/mcp`, sessions, seen, close: () => server.close() });
    }));
}
