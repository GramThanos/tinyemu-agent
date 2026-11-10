/*
 * compaction.js — shrinking a conversation that is filling the model's context.
 *
 * Every provider keeps its own history in its own wire format, so compaction is
 * done the same way for all of them, on the page: the history is rendered as a
 * plain transcript (provider.transcript()), a forked copy of the same model with
 * no tools writes a summary of it, and the summary replaces the history
 * (provider.resetHistory()). Agent.js decides when; this file holds the parts
 * that don't depend on the loop.
 *
 * The VM itself is not part of the context: files the agent wrote are still
 * there after a compaction, so the summary only has to say where they are.
 */

'use strict';

/* When a model's window is not known (an OpenAI-compatible server that doesn't
 * report it), assume this many tokens; Settings can say otherwise. */
export const DEFAULT_CONTEXT_WINDOW = 128000;

export const COMPACT_PROMPT = `You write the working memory of an AI agent. The agent works for a user inside a Linux virtual machine, through tools that read and write files and run shell commands. Its conversation has grown too long for its context, so the whole history will be replaced by what you write, and the agent will carry on from your text alone. You are given the history as a transcript.

Write a summary that lets the agent continue without losing anything that matters:
- The user's requests, preferences and corrections, in their own words where the wording matters, and which of them are done.
- What the agent did and found: files created or changed (full paths), commands and their important results, errors and how they were resolved.
- The current state: what works, what is still broken or open.
- If work was in progress, exactly where it stopped and what the next step was.
- Facts the agent will need again: names, paths, numbers, settings, decisions and their reasons.

Leave out greetings, repetition, and tool output that no longer matters; the files are still in the VM and can be read again. Write plain text with short headings, and nothing before or after the summary.`;

const LABEL = { user: 'USER', assistant: 'AGENT', call: 'TOOL CALL', result: 'TOOL RESULT' };
const ENTRY_MAX = 4000;   // characters kept of one entry (tool output is the bulk)

/** Rough token count: about four characters a token for English and code. */
export function estimateTokens(text) { return Math.ceil(text.length / 4); }

/**
 * Render transcript entries as one text for the summarizer, within `maxChars`.
 * Long entries keep their start and end. When everything doesn't fit, the first
 * entry (the original request, or an earlier summary) and the most recent ones
 * are kept, which is where the task and its current state are.
 * @param {{role:string, text:string, isError?:boolean}[]} entries
 */
export function renderTranscript(entries, maxChars) {
    const blocks = entries.map((e) => {
        let text = String(e.text ?? '');
        if (text.length > ENTRY_MAX) {
            const keep = ENTRY_MAX / 2;
            text = `${text.slice(0, keep)}\n[… ${text.length - ENTRY_MAX} characters cut …]\n${text.slice(-keep)}`;
        }
        return `${LABEL[e.role] || e.role.toUpperCase()}${e.isError ? ' (error)' : ''}:\n${text}`;
    });
    const size = (list) => list.reduce((n, b) => n + b.length + 2, 0);
    if (size(blocks) <= maxChars || blocks.length < 2) return blocks.join('\n\n');
    const head = blocks[0];
    const tail = [];
    let room = maxChars - head.length - 100;
    for (let i = blocks.length - 1; i > 0 && room - blocks[i].length - 2 >= 0; i--) {
        tail.unshift(blocks[i]);
        room -= blocks[i].length + 2;
    }
    const omitted = blocks.length - 1 - tail.length;
    return [head, `[… ${omitted} earlier entries omitted to fit …]`, ...tail].join('\n\n');
}

/**
 * The message that replaces the history. `task`, for a sub-agent, is the task it
 * was given, kept word for word: a summary may blur exactly what was asked.
 */
export function compactedMessage(summary, midTurn, task = null) {
    return '[Context compacted: the conversation so far was summarized to save space, and this summary '
        + 'replaces it. Files and changes in the VM are untouched; read them again if you need the details.]\n\n'
        + `${summary.trim()}\n\n`
        + (task ? `[Your task, exactly as it was given to you:]\n${task}\n\n` : '')
        + (midTurn
            ? '[You were in the middle of this work: continue it from where the summary says it stopped.]'
            : '[The user\'s next message follows.]');
}

/** Whether an error means the request no longer fits the model's context. */
export function isContextOverflow(e) {
    return /prompt is too long|input is too long|too many (input )?tokens|maximum context|context (length|window|size)|exceeds? (the )?(model'?s? )?context/i
        .test(String(e?.message ?? e));
}
