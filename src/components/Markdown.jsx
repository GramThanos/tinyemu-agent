// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Markdown.jsx — the model's replies, as Markdown (showdown).
 *
 * showdown's output is HTML, and it passes raw HTML through, so it never goes into
 * the page as HTML. It is parsed in an inert document (DOMParser: no script runs,
 * no image loads) and rebuilt as React elements from an allowlist: text, the usual
 * Markdown elements, and links to http(s) and mailto only. Anything else (images,
 * raw HTML the model wrote) shows as the text it was written as. So no request
 * leaves the page because of a reply, and no attribute other than a checked href
 * reaches the DOM.
 *
 * showdown has open advisories (a ReDoS in link parsing; XSS through metadata and
 * table header ids). The last two need its HTML inserted or those options on, and
 * neither is the case here; for the first, a reply past MAX_MARKDOWN is shown as
 * plain text.
 */

import { memo, useMemo } from 'react';
import showdown from 'showdown';

/* Longer replies are shown as plain text: converting is synchronous. */
const MAX_MARKDOWN = 100000;

const converter = new showdown.Converter({
    // Off: anything that makes requests, ids or HTML of its own.
    metadata: false,
    noHeaderId: true,
    tablesHeaderId: false,
    parseImgDimensions: false,
    emoji: false,
    ghMentions: false,
    tasklists: false,
    encodeEmails: false,
    completeHTMLDocument: false,
    // On: what models write.
    tables: true,
    strikethrough: true,
    ghCodeBlocks: true,
    simplifiedAutoLink: true,
    excludeTrailingPunctuationFromURLs: true,
    literalMidWordUnderscores: true,
    simpleLineBreaks: false,
    disableForced4SpacesIndentedSublists: true,
    backslashEscapesHTMLTags: true,
});

/* Elements kept as they are (attributes dropped, but for the ones below). */
const ALLOWED = new Set([
    'p', 'br', 'hr', 'em', 'strong', 'del', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a',
]);
const VOID = new Set(['br', 'hr']);
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tr']);
const SAFE_URL = /^(https?:|mailto:)/i;

function toReact(node, key) {
    if (node.nodeType === 3) return node.nodeValue;   // text
    if (node.nodeType !== 1) return null;             // comments and the rest
    const tag = node.localName;
    // A table's parts take no text: showdown's line breaks between their cells go.
    const kids = () => [...node.childNodes]
        .filter((c) => !(TABLE_PARTS.has(tag) && c.nodeType === 3 && !c.nodeValue.trim()))
        .map((c, i) => toReact(c, i));
    // Not allowed: the source as text, so nothing it says is lost (or obeyed).
    if (!ALLOWED.has(tag)) return node.outerHTML;
    if (VOID.has(tag)) return tag === 'br' ? <br key={key} /> : <hr key={key} />;
    if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        if (!SAFE_URL.test(href.trim())) return <span key={key}>{kids()}</span>;
        return <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>{kids()}</a>;
    }
    const props = {};
    // A code block's language, for its style.
    if (tag === 'code') {
        const lang = (node.getAttribute('class') || '').split(/\s+/).find((c) => /^language-[\w+#.-]{1,30}$/.test(c));
        if (lang) props.className = lang;
    }
    if ((tag === 'th' || tag === 'td') && /^(left|right|center)$/.test(node.style?.textAlign || '')) {
        props.style = { textAlign: node.style.textAlign };
    }
    const Tag = tag;
    return <Tag key={key} {...props}>{kids()}</Tag>;
}

/** Markdown text as React elements; plain text when long or when parsing fails. */
export const Markdown = memo(function Markdown({ text }) {
    const nodes = useMemo(() => {
        if (!text || text.length > MAX_MARKDOWN || typeof DOMParser === 'undefined') return null;
        try {
            const doc = new DOMParser().parseFromString(`<body>${converter.makeHtml(text)}</body>`, 'text/html');
            return [...doc.body.childNodes].map((c, i) => toReact(c, i));
        } catch {
            return null;
        }
    }, [text]);
    return nodes ? <div className="md">{nodes}</div> : <>{text}</>;
});
