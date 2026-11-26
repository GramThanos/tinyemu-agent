// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * mcpServers.js — the MCP servers set up in Settings → Integrations (js/mcp.js),
 * for every chat: each one's tools join the agent's (`extraTools`), read at each
 * request, so a server connecting or a tool turned off applies from the next step.
 * Kept in localStorage, headers (tokens) included, like the providers' keys.
 */

'use strict';

import { checkMcpInput, McpHub, serverShape } from '../../js/mcp.js';
import { emit } from './store.js';
import { readJSON, S, writeJSON } from './state.js';

export const MCP_KEY = 'tinyemu-agent-mcp';
{
    const v = readJSON(MCP_KEY, []);
    S.mcpServers = Array.isArray(v) ? v.map(serverShape) : [];
}
export function saveMcp() {
    if (!writeJSON(MCP_KEY, S.mcpServers)) alert('This browser has no storage for the MCP servers, so they last until the page reloads.');
    emit('mcp');
}

export const mcp = new McpHub({
    servers: () => S.mcpServers,
    onChange() { emit('mcp'); },
});

/* The servers' tools as the tools layer takes them (createTools' extraTools). */
export function mcpTools() {
    return mcp.tools().map((t) => ({
        name: t.name, def: t.def, via: 'mcp',
        check: (input) => checkMcpInput(t.def.input_schema, input),
        run: (input, ctx) => mcp.call(t.server, t.tool, input, ctx.signal),
    }));
}

export function addMcpServer() {
    let n = S.mcpServers.length + 1;
    while (S.mcpServers.some((x) => x.name === `server${n}`)) n++;
    const s = serverShape({ name: `server${n}`, enabled: false });
    S.mcpServers.push(s);
    saveMcp();
    return s;
}
export function removeMcpServer(s) {
    S.mcpServers = S.mcpServers.filter((x) => x !== s);
    saveMcp();
    mcp.sync();
}
