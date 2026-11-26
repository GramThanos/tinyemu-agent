// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * mcp.js — MCP servers (Model Context Protocol) as tools for the agent.
 *
 * A page can only reach a server over HTTP, so this speaks MCP's Streamable HTTP
 * transport, from the browser: every message is a POST of JSON-RPC to the
 * server's URL, answered with JSON or with an event stream (SSE) that ends with
 * the answer. The server must allow this page's origin (CORS), and expose its
 * `Mcp-Session-Id` header if it keeps sessions. stdio servers can't run in a
 * browser; put them behind an HTTP bridge. OAuth isn't done here: a server that
 * needs a token gets it as a header the user sets (Authorization: Bearer ...).
 *
 *   McpClient   one server: initialize, tools/list, tools/call, sessions
 *   McpHub      the servers set up in Settings → Integrations: connecting them,
 *               their tools as the agent's (`mcp__<server>__<tool>`), calls
 *
 * Header values (tokens) go only to their own server's URL.
 */

'use strict';

export const MCP_PROTOCOL = '2025-06-18';
/** How long connecting (initialize and tools/list) may take before the server counts as failed. */
export const CONNECT_MS = 30000;
const CLIENT_INFO = { name: 'tinyemu-agent', version: '1.0.0' };

export class McpError extends Error {
    constructor(message, { status = null, code = null } = {}) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
/* The server forgot our session (404 to a request that carried one): initialize again. */
class SessionExpired extends McpError {}

/** Read Server-Sent Events from a fetch response: yields each event's data. */
export async function* sseData(body, signal) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let data = [];
    try {
        for (;;) {
            if (signal?.aborted) return;
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.search(/\r?\n/)) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + (buf[nl] === '\r' ? 2 : 1));
                if (line === '') {
                    if (data.length) yield data.join('\n');
                    data = [];
                } else if (line.startsWith('data:')) {
                    data.push(line.slice(line[5] === ' ' ? 6 : 5));
                }
                // event:, id:, retry: and comments don't matter here.
            }
        }
        if (data.length) yield data.join('\n');
    } finally {
        reader.cancel().catch(() => {});
    }
}

export class McpClient {
    /**
     * @param {object} o
     * @param {string} o.url        the server's MCP endpoint
     * @param {object} [o.headers]  sent with every request (auth)
     * @param {Function} [o.fetch]
     */
    constructor({ url, headers = {}, fetch = globalThis.fetch?.bind(globalThis) }) {
        this.url = url;
        this.headers = headers;
        this.fetch = fetch;
        this.session = null;
        this.protocol = null;
        this.server = null;        // serverInfo
        this.instructions = null;
        this._seq = 0;
    }

    async connect(signal) {
        this.session = null;
        this.protocol = null;
        const r = await this._request('initialize', {
            protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO,
        }, signal);
        this.protocol = r.protocolVersion || MCP_PROTOCOL;
        this.server = r.serverInfo || null;
        this.instructions = r.instructions || null;
        this.capabilities = r.capabilities || {};
        await this._notify('notifications/initialized', undefined, signal);
        return r;
    }

    /** Every tool, following the pagination cursor. */
    async listTools(signal) {
        const tools = [];
        let cursor;
        for (let page = 0; page < 50; page++) {
            const r = await this._retrying('tools/list', cursor ? { cursor } : {}, signal);
            tools.push(...(r.tools || []));
            cursor = r.nextCursor;
            if (!cursor) break;
        }
        return tools;
    }

    callTool(name, args, signal) {
        return this._retrying('tools/call', { name, arguments: args || {} }, signal);
    }

    /** End the session, if the server keeps one (best effort). */
    async close() {
        if (!this.session) return;
        const session = this.session;
        this.session = null;
        try { await this.fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'Mcp-Session-Id': session } }); } catch { /* gone anyway */ }
    }

    async _retrying(method, params, signal) {
        try {
            return await this._request(method, params, signal);
        } catch (e) {
            if (!(e instanceof SessionExpired)) throw e;
            await this.connect(signal);
            return this._request(method, params, signal);
        }
    }

    _headers() {
        const h = { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        if (this.protocol) h['MCP-Protocol-Version'] = this.protocol;
        if (this.session) h['Mcp-Session-Id'] = this.session;
        return h;
    }

    async _post(message, signal) {
        const res = await this.fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(message), signal });
        const session = res.headers.get('Mcp-Session-Id');
        if (session) this.session = session;
        if (res.status === 404 && this.session && message.method !== 'initialize') {
            this.session = null;
            throw new SessionExpired('the server ended the session', { status: 404 });
        }
        if (!res.ok) {
            let text = '';
            try { text = (await res.text()).slice(0, 300); } catch { /* none */ }
            throw new McpError(`HTTP ${res.status}${text ? `: ${text}` : ''}`, { status: res.status });
        }
        return res;
    }

    async _notify(method, params, signal) {
        const res = await this._post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, signal);
        res.body?.cancel?.().catch?.(() => {});
    }

    async _request(method, params, signal) {
        const id = ++this._seq;
        const onAbort = () => {
            // Tell the server, so it can stop the work (the fetch itself is aborted too).
            if (method !== 'initialize') this._notify('notifications/cancelled', { requestId: id, reason: 'stopped by the user' }).catch(() => {});
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const res = await this._post({ jsonrpc: '2.0', id, method, params }, signal);
            const type = res.headers.get('Content-Type') || '';
            let reply = null;
            if (type.includes('text/event-stream')) {
                for await (const data of sseData(res.body, signal)) {
                    let msg;
                    try { msg = JSON.parse(data); } catch { continue; }
                    for (const m of Array.isArray(msg) ? msg : [msg]) {
                        if (m.id === id && ('result' in m || 'error' in m)) { reply = m; break; }
                        // A request from the server (sampling, elicitation, ping): not supported, say so.
                        if (m.method && m.id !== undefined) this._answer(m).catch(() => {});
                    }
                    if (reply) break;
                }
                if (!reply && signal?.aborted) throw new McpError('stopped');
            } else if (type.includes('application/json')) {
                const msg = await res.json();
                reply = (Array.isArray(msg) ? msg : [msg]).find((m) => m.id === id) || null;
            }
            if (!reply) throw new McpError(`no answer to ${method}`);
            if (reply.error) throw new McpError(reply.error.message || `error ${reply.error.code}`, { code: reply.error.code });
            return reply.result ?? {};
        } finally {
            signal?.removeEventListener('abort', onAbort);
        }
    }

    _answer(req) {
        const result = req.method === 'ping' ? { result: {} } : { error: { code: -32601, message: `${req.method} is not supported by this client` } };
        return this._post({ jsonrpc: '2.0', id: req.id, ...result }).then((r) => r.body?.cancel?.());
    }
}

/* ---- tools ------------------------------------------------------------------------- */

const SAFE = /[^A-Za-z0-9_-]/g;
/** A server's tool as one of the agent's: `mcp__<server>__<tool>`, at most 64 characters. */
export function mcpToolName(server, tool) {
    const s = String(server).replace(SAFE, '_').slice(0, 20) || 'server';
    let name = `mcp__${s}__${String(tool).replace(SAFE, '_')}`;
    if (name.length > 64) {
        // Keep it unique: a short hash of the whole name replaces the end.
        let h = 0;
        for (const ch of `${server}/${tool}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        name = `${name.slice(0, 56)}_${h.toString(36).padStart(7, '0')}`;   // 56 + 1 + 7 = 64
    }
    return name;
}

/* A name not in `seen` (and add it): two servers, or two of one server's tools, can
 * sanitize to the same name, and only one of them could ever be called. */
function uniqueName(name, seen) {
    let out = name;
    for (let n = 2; seen.has(out); n++) out = `${name.slice(0, 64 - `_${n}`.length)}_${n}`;
    seen.add(out);
    return out;
}

/** A tool's input schema as the model APIs take it: an object, no `$schema`. */
export function cleanSchema(schema) {
    const s = schema && typeof schema === 'object' ? structuredClone(schema) : {};
    delete s.$schema;
    s.type = 'object';
    if (!s.properties || typeof s.properties !== 'object') s.properties = {};
    return s;
}

/** A tools/call result as the agent's tool result: its content as text. */
export function formatToolResult(r) {
    const parts = [];
    for (const c of r?.content || []) {
        if (c.type === 'text') parts.push(c.text);
        else if (c.type === 'image' || c.type === 'audio') {
            parts.push(`[${c.type} ${c.mimeType || ''}, about ${Math.round(((c.data || '').length * 3) / 4).toLocaleString()} bytes: not shown to the model]`);
        } else if (c.type === 'resource') {
            const res = c.resource || {};
            parts.push(typeof res.text === 'string' ? res.text : `[resource ${res.uri || ''} (${res.mimeType || 'binary'})]`);
        } else if (c.type === 'resource_link') {
            parts.push(`[resource ${c.uri}${c.name ? ` (${c.name})` : ''}${c.description ? `: ${c.description}` : ''}]`);
        } else {
            parts.push(JSON.stringify(c));
        }
    }
    if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
    return { content: parts.join('\n') || '(no output)', isError: !!r?.isError };
}

/** Input checks for a server's tool: an object with its required fields. The server checks the rest. */
export function checkMcpInput(schema, input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
    for (const key of schema.required || []) if (input[key] === undefined) return `missing required parameter "${key}"`;
    if (schema.additionalProperties === false) {
        for (const key of Object.keys(input)) if (!(key in (schema.properties || {}))) return `unknown parameter "${key}"`;
    }
    return null;
}

/* ---- the servers --------------------------------------------------------------------- */

/** A server record as saved: { id, name, url, headers: [[name, value]], enabled, disabledTools }. */
export function serverShape(s) {
    const name = typeof s?.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : 'server';
    return {
        id: typeof s?.id === 'string' && s.id ? s.id : `mcp-${Math.random().toString(36).slice(2, 8)}`,
        name,
        url: typeof s?.url === 'string' ? s.url.trim() : '',
        headers: Array.isArray(s?.headers)
            ? s.headers.filter((h) => Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'string') : [],
        enabled: s?.enabled !== false,
        disabledTools: Array.isArray(s?.disabledTools) ? s.disabledTools.filter((t) => typeof t === 'string') : [],
    };
}

/** Header lines ("Name: value", one per line) to pairs, and what is wrong with them. */
export function parseHeaderLines(text) {
    const pairs = [];
    const problems = [];
    for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const i = line.indexOf(':');
        const name = i > 0 ? line.slice(0, i).trim() : '';
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) { problems.push(`"${line.slice(0, 30)}" is not "Name: value"`); continue; }
        pairs.push([name, line.slice(i + 1).trim()]);
    }
    return { pairs, problems };
}

const validURL = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

export class McpHub {
    /**
     * @param {object} o
     * @param {() => object[]} o.servers  the server records, read at each use
     * @param {Function} [o.fetch]
     * @param {(server) => void} [o.onChange]  a server's state or tools changed
     * @param {number} [o.connectMs]  how long connecting may take
     */
    constructor({ servers, fetch = globalThis.fetch?.bind(globalThis), onChange = () => {}, connectMs = CONNECT_MS }) {
        this.servers = servers;
        this.connectMs = connectMs;
        this.fetch = fetch;
        this.onChange = onChange;
        this.state = new Map();   // id -> { key, client, status, error, tools, connecting }
    }

    /** Connect what is on and changed, close what went off or away. */
    sync() {
        const list = this.servers();
        for (const [id, st] of this.state) {
            const s = list.find((x) => x.id === id);
            if (!s || !s.enabled || st.key !== keyOf(s)) {
                st.client?.close();
                this.state.delete(id);
                if (s) this.onChange(s);
            }
        }
        return Promise.all(list.filter((s) => s.enabled && !this.state.has(s.id)).map((s) => this.connect(s)));
    }

    /** (Re)connect one server and list its tools. */
    connect(s) {
        const old = this.state.get(s.id);
        old?.client?.close();
        const st = { key: keyOf(s), client: null, status: 'connecting', error: null, tools: [], server: null, instructions: null };
        this.state.set(s.id, st);
        this.onChange(s);
        st.connecting = (async () => {
            if (!validURL(s.url)) throw new McpError('the URL must start with http:// or https://');
            const client = new McpClient({ url: s.url, headers: Object.fromEntries(s.headers), fetch: this.fetch });
            st.client = client;
            const signal = AbortSignal.timeout(this.connectMs);
            try {
                await client.connect(signal);
                st.server = client.server;
                st.instructions = client.instructions;
                st.tools = await client.listTools(signal);
            } catch (e) {
                if (signal.aborted) throw new McpError(`no answer in ${Math.round(this.connectMs / 1000)} s`);
                throw e;
            }
            // Replaced (reconnected, turned off) while it connected: let this session go.
            if (this.state.get(s.id) !== st) { client.close(); return; }
            st.status = 'ready';
        })().catch((e) => {
            st.status = 'failed';
            if (this.state.get(s.id) !== st) st.client?.close();
            // fetch() says the same "Failed to fetch" for an unreachable server and a CORS refusal.
            st.error = e instanceof TypeError ? `${e.message}: the server isn't reachable, or doesn't allow this page (CORS)` : e.message;
        }).finally(() => {
            if (this.state.get(s.id) === st) this.onChange(s);
        });
        return st.connecting;
    }

    status(id) { return this.state.get(id) || { status: 'off', tools: [] }; }

    /** The tools the agent gets: each ready server's tools that are on. */
    tools() {
        const out = [];
        const seen = new Set();
        for (const s of this.servers()) {
            const st = this.state.get(s.id);
            if (!s.enabled || st?.status !== 'ready') continue;
            for (const t of st.tools) {
                if (s.disabledTools.includes(t.name)) continue;
                const desc = t.description || t.title || '';
                const name = uniqueName(mcpToolName(s.name, t.name), seen);
                out.push({
                    name,
                    server: s.id,
                    tool: t.name,
                    def: {
                        name,
                        description: `[MCP server "${s.name}"${st.server?.name ? `, ${st.server.name}` : ''}] ${desc}`.trim().slice(0, 1024),
                        input_schema: cleanSchema(t.inputSchema),
                    },
                });
            }
        }
        return out;
    }

    /** Run one tool call. @returns {{content:string, isError:boolean}} */
    async call(server, tool, input, signal) {
        const s = this.servers().find((x) => x.id === server);
        let st = this.state.get(server);
        if (!s || !s.enabled) return { content: 'That MCP server is turned off.', isError: true };
        if (st?.status !== 'ready') {
            // A connection being opened is waited for, not replaced: parallel calls
            // would otherwise close each other's. Only a failed one is tried again.
            const attempt = st?.status === 'connecting' && st.key === keyOf(s) ? st.connecting : this.connect(s);
            const stopped = await Promise.race([
                attempt.then(() => false),
                new Promise((resolve) => {
                    if (signal?.aborted) resolve(true);
                    else signal?.addEventListener('abort', () => resolve(true), { once: true });
                }),
            ]);
            if (stopped) return { content: 'Stopped by the user.', isError: true };
            st = this.state.get(server);
            if (st?.status !== 'ready') return { content: `The MCP server "${s.name}" is not connected: ${st?.error || 'unknown error'}`, isError: true };
        }
        try {
            return formatToolResult(await st.client.callTool(tool, input, signal));
        } catch (e) {
            if (signal?.aborted) return { content: 'Stopped by the user.', isError: true };
            return { content: `The MCP server "${s.name}" failed: ${e.message}`, isError: true };
        }
    }
}

const keyOf = (s) => JSON.stringify([s.url, s.headers]);
