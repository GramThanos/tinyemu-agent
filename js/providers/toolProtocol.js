/*
 * toolProtocol.js — tool calling for models with no native tool API: tools are
 * described in the system prompt and calls are written as tagged JSON in the text.
 */

'use strict';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export function toolPrompt(system, tools) {
    if (!tools.length) return system;   // a compaction request: plain text only
    const specs = tools.map((t) => JSON.stringify({
        name: t.name, description: t.description, parameters: t.input_schema,
    })).join('\n');
    return `${system}

You have these tools:
${specs}

To call a tool, reply with exactly this and then stop, without guessing the result:
${OPEN}{"name": "Bash", "arguments": {"command": "uname -a"}}${CLOSE}

You can write several calls in one reply; they run at the same time. The results come back in the next message as <tool_response>. Reply normally, with no tool call, when the task is finished.`;
}

/** Remove the reasoning some models emit in <think> tags. */
export function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, '');
}

/**
 * Parse every tool call in a finished reply.
 * @returns {{text:string, calls:Array<{name?:string, input?:object, error?:string}>}}
 */
export function parseToolCalls(reply) {
    const calls = [];
    const pieces = [];
    let pos = 0;
    for (;;) {
        const start = reply.indexOf(OPEN, pos);
        if (start < 0) { pieces.push(reply.slice(pos)); break; }
        pieces.push(reply.slice(pos, start));
        const bodyStart = start + OPEN.length;
        const end = reply.indexOf(CLOSE, bodyStart);
        // A model that stops right after the JSON may never write the closing tag.
        const body = end < 0 ? reply.slice(bodyStart) : reply.slice(bodyStart, end);
        pos = end < 0 ? reply.length : end + CLOSE.length;
        try {
            const parsed = JSON.parse(body.trim());
            if (typeof parsed?.name !== 'string') throw new Error('no "name"');
            calls.push({ name: parsed.name, input: parsed.arguments ?? {} });
        } catch (e) {
            calls.push({ error: `Could not parse the tool call (${e.message}): ${body.trim().slice(0, 200)}` });
        }
        if (end < 0) break;
    }
    return { text: pieces.join('').trim(), calls };
}

/**
 * Pass streamed text through, holding back tool-call markup and <think> blocks so
 * they never reach the chat. Tags may be split across chunks.
 */
export class VisibleTextFilter {
    constructor(onText) {
        this.onText = onText;
        this.buf = '';
        this.hidden = null;   // the closing tag being waited for
    }

    push(chunk) {
        this.buf += chunk;
        for (;;) {
            if (this.hidden) {
                const end = this.buf.indexOf(this.hidden);
                if (end < 0) { this.buf = this.buf.slice(-(this.hidden.length - 1)); return; }
                this.buf = this.buf.slice(end + this.hidden.length);
                this.hidden = null;
                continue;
            }
            const m = this.buf.match(/<tool_call>|<think>/);
            if (m) {
                if (m.index) this.onText(this.buf.slice(0, m.index));
                this.buf = this.buf.slice(m.index + m[0].length);
                this.hidden = m[0] === OPEN ? CLOSE : '</think>';
                continue;
            }
            // Hold back any tail that could still become an opening tag.
            const lt = this.buf.lastIndexOf('<');
            const maybeTag = lt >= 0 && (OPEN.startsWith(this.buf.slice(lt)) || '<think>'.startsWith(this.buf.slice(lt)));
            const emit = maybeTag ? this.buf.slice(0, lt) : this.buf;
            if (emit) this.onText(emit);
            this.buf = this.buf.slice(emit.length);
            return;
        }
    }

    end() {
        if (!this.hidden && this.buf) this.onText(this.buf);
        this.buf = '';
    }
}
