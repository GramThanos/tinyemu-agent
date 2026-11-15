/*
 * figures.js — what the page's Context and Usage panels show, worked out from an
 * agent's state and a chat's counters. No DOM here, so the tests can check it.
 */

'use strict';

import { estimateTokens } from './compaction.js';

const SKILL_TOOL = 'skill';

/**
 * Where a context window goes, as segments that add up to the window.
 *
 * Only the total in use is measured (the last response's input + output); the
 * system prompt and the tool definitions are estimated from their text (about 4
 * characters a token), and the conversation is the rest. Before any response,
 * the conversation is estimated from the transcript too.
 *
 * @param {object} o
 * @param {number} o.used        tokens in the context (Agent.contextInfo().used)
 * @param {number} o.limit       the window
 * @param {number} o.trigger     where automatic compaction starts
 * @param {boolean} o.auto       automatic compaction on
 * @param {string} o.system      the system prompt as sent
 * @param {object[]} o.defs      the tool definitions as sent
 * @param {{text?:string}[]} [o.transcript]  the history, for an estimate before any response
 * @returns {{ segments: {key,label,tokens}[], tools: {name,tokens}[], skills: number, used: number, measured: boolean }}
 */
export function contextBreakdown({ used, limit, trigger, auto, system = '', defs = [], transcript = [] }) {
    const system_ = estimateTokens(String(system || ''));
    const tools = defs.map((d) => ({ name: d.name, tokens: estimateTokens(JSON.stringify(d)) }));
    const skillTokens = tools.filter((t) => t.name === SKILL_TOOL).reduce((n, t) => n + t.tokens, 0);
    const toolTokens = tools.reduce((n, t) => n + t.tokens, 0) - skillTokens;
    const measured = used > 0;
    const fixed = system_ + toolTokens + skillTokens;
    const messages = measured
        ? Math.max(0, used - fixed)
        : transcript.reduce((n, e) => n + estimateTokens(String(e.text ?? '')), 0);
    const total = measured ? Math.max(used, fixed) : fixed + messages;
    // What compaction keeps free: past the trigger it would compact.
    const buffer = auto ? Math.max(0, limit - Math.max(trigger, total)) : 0;
    const free = Math.max(0, limit - total - buffer);
    return {
        segments: [
            { key: 'messages', label: 'Messages', tokens: messages },
            { key: 'tools', label: 'Tool definitions', tokens: toolTokens },
            { key: 'skills', label: 'Skills', tokens: skillTokens },
            { key: 'system', label: 'System prompt', tokens: system_ },
            { key: 'buffer', label: 'Compaction buffer', tokens: buffer },
            { key: 'free', label: 'Free space', tokens: free },
        ],
        tools: tools.filter((t) => t.name !== SKILL_TOOL).sort((a, b) => b.tokens - a.tokens),
        skills: skillTokens,
        used: total,
        measured,
    };
}

/**
 * A chat's usage: totals, the cache hit rate, time spent waiting on the API, and
 * each part's share of the tokens.
 * @param {object} usage   the chat's { main, sub, compaction } counters
 * @param {object[]} exchanges  its log entries; `response` ones carry `ms`
 */
export function usageSummary(usage, exchanges = []) {
    const keys = ['requests', 'input', 'cacheWrite', 'cacheRead', 'output', 'thinking'];
    const parts = [['main', usage.main], ['sub', usage.sub], ['compaction', usage.compaction]];
    const total = Object.fromEntries(keys.map((k) => [k, parts.reduce((n, [, t]) => n + (t?.[k] || 0), 0)]));
    total.thinkingKnown = parts.some(([, t]) => t?.thinkingKnown);
    const tokensOf = (t) => (t ? t.input + t.cacheWrite + t.cacheRead + t.output : 0);
    const all = tokensOf(total);
    const prompt = total.input + total.cacheWrite + total.cacheRead;
    return {
        total,
        tokens: all,
        cacheHit: prompt ? total.cacheRead / prompt : null,
        apiMs: exchanges.reduce((n, e) => n + (e?.type === 'response' && Number.isFinite(e.ms) ? e.ms : 0), 0),
        shares: parts.map(([key, t]) => ({ key, tokens: tokensOf(t), share: all ? tokensOf(t) / all : 0 })),
    };
}

/* "6m0s", "1.5s", "20ms" (OpenAI's reset durations) in ms. */
function durationMs(text) {
    let ms = 0;
    let any = false;
    for (const [, n, unit] of String(text).matchAll(/([\d.]+)\s*(ms|h|m|s)/g)) {
        any = true;
        ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
    }
    return any ? ms : null;
}

/**
 * Rate limits from a response's headers, where the browser may read them (the
 * provider has to expose them over CORS). Anthropic: anthropic-ratelimit-<kind>-
 * {limit,remaining,reset}, reset a time. OpenAI and compatible servers:
 * x-ratelimit-{limit,remaining,reset}-<kind>, reset a duration; OpenRouter's
 * x-ratelimit-{limit,remaining,reset} has no kind and resets at an epoch in ms.
 * @param {{get(name:string):string|null}} headers
 * @param {number} [now]
 * @returns {{name:string, limit:number, remaining:number, resetAt:number|null}[]|null}
 */
export function parseRateLimits(headers, now = Date.now()) {
    if (!headers?.get) return null;
    const out = [];
    const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const add = (name, limit, remaining, resetAt) => {
        if (num(limit) === null || num(remaining) === null) return;
        out.push({ name, limit: num(limit), remaining: num(remaining), resetAt });
    };
    for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
        const a = (k) => headers.get(`anthropic-ratelimit-${kind}-${k}`);
        const at = Date.parse(a('reset') ?? '');
        add(kind.replace('-', ' '), a('limit'), a('remaining'), Number.isFinite(at) ? at : null);
    }
    for (const kind of ['requests', 'tokens']) {
        const o = (k) => headers.get(`x-ratelimit-${k}-${kind}`);
        const ms = durationMs(o('reset') ?? '');
        add(kind, o('limit'), o('remaining'), ms === null ? null : now + ms);
    }
    if (!out.length) {
        const reset = num(headers.get('x-ratelimit-reset'));
        add('requests', headers.get('x-ratelimit-limit'), headers.get('x-ratelimit-remaining'),
            reset === null ? null : reset > 1e12 ? reset : reset * 1000);
    }
    return out.length ? out : null;
}

/* ---- running figures on a chat record (c.figs) ------------------------------
 * The log (c.exchanges) is capped, so the figures a long chat shows are kept as
 * running totals, updated by recordExchange() from each log entry as it comes.
 * Plain JSON: it is saved with the chat. */

const CONTEXT_POINTS = 300;   // context-size samples kept; older ones thinned out
const RECENT_MS = 50;         // per-tool durations kept, for the median
const BASH_WORDS = 100;       // distinct Bash commands counted

export function emptyFigures() {
    return {
        replies: {},          // stop reason -> count ('error' for a failed request)
        speed: { n: 0, tokens: 0, streamMs: 0, firstN: 0, firstMs: 0, firstMax: 0 },
        context: [],          // [time, tokens, compacted (0/1)] of the chat's own agent
        cache: { requests: 0, cold: 0 },
        tools: {},            // name -> { calls, failed, stopped, capped, ms, maxMs, chars, recent[] }
        steps: { withCalls: 0, calls: 0, maxParallel: 0 },
        bash: {},             // first command word -> count
        via: {},              // where tool time went: vm, page, user (ms)
        subs: { done: 0, failed: 0, stopped: 0, interrupted: 0, wrapUps: 0 },
        breaks: { outages: 0, outageMs: 0, pauses: 0, pauseMs: 0, resumes: 0 },
        health: null,         // the guest after the latest Bash call, with `at`
        limits: null,         // the latest rate limits, { list, at }
    };
}

/** Fill in what an older chat record lacks. */
export function figuresShape(f) {
    const e = emptyFigures();
    if (!f || typeof f !== 'object') return e;
    for (const [k, v] of Object.entries(e)) {
        if (f[k] === undefined) { f[k] = v; continue; }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (!f[k] || typeof f[k] !== 'object') { f[k] = v; continue; }
            for (const [kk, vv] of Object.entries(v)) if (f[k][kk] === undefined) f[k][kk] = vv;
        }
    }
    if (!Array.isArray(f.context)) f.context = [];
    return f;
}

const WRAPPERS = ['sudo', 'env', 'time', 'nohup', 'exec', 'command'];

/** The command a Bash line runs, as one word: `FOO=1 sudo /usr/bin/make -j4` is make. */
export function commandWord(command) {
    let line = String(command || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
    // `cd dir && make`: the work is after the cd.
    const parts = line.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
    line = parts.find((p) => !/^cd(\s|$)/.test(p)) || parts[0] || '';
    const words = line.split(/\s+/);
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.includes(words[i]))) i++;
    const w = (words[i] || '').replace(/^["'(]+/, '');
    return w ? w.split('/').pop() : '';
}

const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function pushContext(f, tokens, compacted, at) {
    f.context.push([at, tokens, compacted]);
    // Keep the curve's shape, not every point: thin the older ones, keep compactions.
    if (f.context.length > CONTEXT_POINTS) {
        const keepFrom = f.context.length - 50;
        f.context = f.context.filter((p, i) => i % 2 === 0 || p[2] || i >= keepFrom);
    }
}

/**
 * Update the figures with one log entry (see Agent.js: start, user, response,
 * tool, compaction, error). `own` is the name of the chat's own agent ('main', or
 * a sub-agent's), whose requests draw the context curve; sub-agents' entries
 * count everywhere else.
 */
export function recordExchange(f, e, own = 'main', now = Date.now()) {
    if (!e || typeof e !== 'object') return f;
    if (e.type === 'response') {
        const u = e.usage;
        f.replies[e.stop] = (f.replies[e.stop] || 0) + 1;
        if (u) {
            f.cache.requests++;
            if (!u.cacheRead) f.cache.cold++;
            if (u.limits) f.limits = { list: u.limits, at: now };
            if (e.agent === own) pushContext(f, (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0), 0, now);
        }
        if (u?.output && Number.isFinite(e.ms) && Number.isFinite(e.firstMs)) {
            f.speed.n++;
            f.speed.tokens += u.output;
            f.speed.streamMs += Math.max(1, e.ms - e.firstMs);
        }
        if (Number.isFinite(e.firstMs)) {
            f.speed.firstN++;
            f.speed.firstMs += e.firstMs;
            f.speed.firstMax = Math.max(f.speed.firstMax, e.firstMs);
        }
        const n = e.toolCalls?.length || 0;
        if (n) {
            f.steps.withCalls++;
            f.steps.calls += n;
            f.steps.maxParallel = Math.max(f.steps.maxParallel, n);
        }
    } else if (e.type === 'tool') {
        const t = f.tools[e.name] ||= { calls: 0, failed: 0, stopped: 0, capped: 0, ms: 0, maxMs: 0, chars: 0, recent: [] };
        t.calls++;
        if (e.isError) t.failed++;
        if (e.stopped) t.stopped++;
        if (e.capped) t.capped++;
        if (Number.isFinite(e.ms)) {
            t.ms += e.ms;
            t.maxMs = Math.max(t.maxMs, e.ms);
            t.recent.push(e.ms);
            if (t.recent.length > RECENT_MS) t.recent.shift();
            // A sub-agent's time is its model's and its own tools', counted there.
            if (e.via && e.via !== 'model') f.via[e.via] = (f.via[e.via] || 0) + e.ms;
        }
        t.chars += Number.isFinite(e.chars) ? e.chars : String(e.content ?? '').length;
        if (e.name === 'Bash') {
            const w = commandWord(e.input?.command);
            if (w && (f.bash[w] !== undefined || Object.keys(f.bash).length < BASH_WORDS)) f.bash[w] = (f.bash[w] || 0) + 1;
            if (e.health) f.health = { ...e.health, at: now };
        }
    } else if (e.type === 'compaction') {
        if (e.agent === own) pushContext(f, e.after || 0, 1, now);
    } else if (e.type === 'error') {
        if (e.network) {
            if (e.attempt === 1) f.breaks.outages++;
            f.breaks.outageMs += e.retryInMs || 0;
        } else {
            f.replies.error = (f.replies.error || 0) + 1;
        }
    } else if (e.type === 'user' && typeof e.text === 'string' && /write your final report/.test(e.text)) {
        f.subs.wrapUps++;
    }
    return f;
}

/** A sub-agent ended: done, failed, stopped or interrupted. */
export function recordSubAgent(f, status) {
    if (f.subs[status] !== undefined) f.subs[status]++;
    return f;
}

/** Derived figures for the panels. */
export function figuresSummary(f) {
    const tools = Object.entries(f.tools).map(([name, t]) => ({
        name, calls: t.calls, failed: t.failed, stopped: t.stopped, capped: t.capped,
        failRate: t.calls ? t.failed / t.calls : 0, medianMs: median(t.recent), maxMs: t.maxMs,
        avgChars: t.calls ? Math.round(t.chars / t.calls) : 0,
    })).sort((a, b) => b.calls - a.calls);
    return {
        replies: Object.values(f.replies).reduce((n, x) => n + x, 0),
        tokensPerSecond: f.speed.streamMs ? f.speed.tokens / (f.speed.streamMs / 1000) : null,
        firstMsAvg: f.speed.firstN ? f.speed.firstMs / f.speed.firstN : null,
        firstMsMax: f.speed.firstN ? f.speed.firstMax : null,
        coldShare: f.cache.requests ? f.cache.cold / f.cache.requests : null,
        parallelAvg: f.steps.withCalls ? f.steps.calls / f.steps.withCalls : null,
        tools,
        bash: Object.entries(f.bash).sort((a, b) => b[1] - a[1]),
    };
}
