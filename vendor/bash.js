/*
 * bash.js 1.0.0, vendored from https://github.com/GramThanos/bash.js (commit 91a608e),
 * unchanged below this comment. Used by ../js/bashjs.js when Settings turns on
 * "Run Bash with bash.js".
 *
 * MIT License
 *
 * Copyright (c) 2026 Grammatopoulos Athanasios Vasileios
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.BashJS = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  function normalizePath(path) {
    var input = String(path || '/');
    var absolute = input.charAt(0) === '/';
    var parts = [];
    input.split('/').forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') {
        if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
        else if (!absolute) parts.push(part);
      } else parts.push(part);
    });
    var result = (absolute ? '/' : '') + parts.join('/');
    return result || (absolute ? '/' : '.');
  }

  function resolvePath(cwd, path) {
    path = String(path == null ? '' : path);
    return normalizePath(path.charAt(0) === '/' ? path : normalizePath(cwd || '/') + '/' + path);
  }

  function dirname(path) {
    var p = normalizePath(path);
    if (p === '/') return '/';
    var at = p.lastIndexOf('/');
    return at <= 0 ? (p.charAt(0) === '/' ? '/' : '.') : p.slice(0, at);
  }

  function basename(path) {
    var p = normalizePath(path);
    if (p === '/') return '/';
    return p.slice(p.lastIndexOf('/') + 1);
  }

  // Quoted characters that would otherwise trigger tilde, brace, or pathname
  // expansion are carried through expansion as private-use control markers.
  // Glob markers survive until after pathname expansion (see unmarkGlob).
  var QUOTED_MARKERS = { '~': '\u0005', '{': '\u0006', '}': '\u0007', '*': '\u0014', '?': '\u0015', '[': '\u0016', ']': '\u0017' };
  var GLOB_UNMARK = { '\u0014': '*', '\u0015': '?', '\u0016': '[', '\u0017': ']' };
  function markQuoted(ch) { return QUOTED_MARKERS[ch] || ch; }
  function markGlob(text) { return String(text).replace(/[*?[\]]/g, function (ch) { return QUOTED_MARKERS[ch]; }); }
  function unmarkGlob(text) { return String(text).replace(/[\u0014-\u0017]/g, function (ch) { return GLOB_UNMARK[ch]; }); }
  // Marks text produced by a substitution so the expansion pass that follows
  // treats `$`, backticks, braces and tilde in it as literal characters.
  function protectLiteral(text) {
    return String(text).replace(/[$`~{}]/g, function (ch) {
      return ch === '$' ? '\u0004' : ch === '`' ? '\u0018' : QUOTED_MARKERS[ch];
    });
  }
  function isDevicePath(path) { return String(path).indexOf('/dev/') === 0; }
  function errorReason(error) {
    var code = error && error.code;
    if (code === 'ENOENT') return 'No such file or directory';
    if (code === 'EISDIR') return 'Is a directory';
    if (code === 'ENOTDIR') return 'Not a directory';
    if (code === 'EBADF') return 'Bad file descriptor';
    if (code === 'AMBIGUOUS') return 'ambiguous redirect';
    if (code === 'EEXIST') return 'cannot overwrite existing file';
    return (error && error.message) || String(error);
  }

  // Bash brace expansion: `{a,b}`, `{1..5}`, `{a..e..2}`. Parameter
  // expansions (`${...}`) are never brace-expanded, and a group that does not
  // expand (`{x}`) is left literal while later groups are still considered.
  function braceExpand(text, budget) {
    budget = budget || { left: 1000 };
    function skipParam(at) {
      var depth = 0;
      for (var k = at + 1; k < text.length; k++) {
        if (text[k] === '{') depth++;
        else if (text[k] === '}' && --depth === 0) return k;
      }
      return text.length;
    }
    var from = 0;
    while (from < text.length) {
      var begin = -1, finish = -1, nesting = 0;
      for (var bi = from; bi < text.length; bi++) {
        if (text[bi] === '$' && text[bi + 1] === '{') { bi = skipParam(bi); continue; }
        if (text[bi] === '{') { if (nesting++ === 0) begin = bi; }
        else if (text[bi] === '}' && nesting && --nesting === 0) { finish = bi; break; }
      }
      if (begin < 0 || finish < 0) return [text];
      var inner = text.slice(begin + 1, finish), choices = [], depth = 0, item = '';
      for (var ci = 0; ci < inner.length; ci++) {
        var cc = inner[ci];
        if (cc === '$' && inner[ci + 1] === '{') {
          var close = ci, d = 0;
          for (; close < inner.length; close++) { if (inner[close] === '{') d++; else if (inner[close] === '}' && --d === 0) break; }
          item += inner.slice(ci, close + 1); ci = close; continue;
        }
        if (cc === ',' && !depth) { choices.push(item); item = ''; }
        else { if (cc === '{') depth++; if (cc === '}') depth--; item += cc; }
      }
      choices.push(item);
      var range = inner.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/), letters = inner.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
      if (range || letters) {
        var a = range ? Number(range[1]) : letters[1].charCodeAt(0), b = range ? Number(range[2]) : letters[2].charCodeAt(0);
        var step = Math.abs(Number(range ? range[3] || 1 : letters[3] || 1)) * (a <= b ? 1 : -1);
        var pad = !!range && (/^-?0\d/.test(range[1]) || /^-?0\d/.test(range[2]));
        var width = range ? Math.max(range[1].replace(/^-/, '').length, range[2].replace(/^-/, '').length) : 1;
        if (!step) throw new SyntaxError('brace range step cannot be zero');
        choices = [];
        for (var x = a; step > 0 ? x <= b : x >= b; x += step) {
          if (choices.length >= 1000) throw new SyntaxError('brace range exceeds 1000 alternatives');
          choices.push(range ? ((x < 0 ? '-' : '') + (pad ? String(Math.abs(x)).padStart(width, '0') : String(Math.abs(x)))) : String.fromCharCode(x));
        }
      } else if (choices.length === 1) {
        // Not a brace expression; keep it literal and look further right.
        from = begin + 1;
        continue;
      }
      var head = text.slice(0, begin), tail = text.slice(finish + 1), all = [];
      for (var k2 = 0; k2 < choices.length; k2++) {
        var expanded = braceExpand(head + choices[k2] + tail, budget);
        if (all.length + expanded.length > 1000) throw new SyntaxError('brace expansion exceeds 1000 alternatives');
        all = all.concat(expanded);
      }
      return all;
    }
    return [text];
  }

  function quoteHereDocEscapes(body) {
    return String(body).replace(/(\\+)([$`])/g, function (_, slashes, marker) {
      var pairs = Math.floor(slashes.length / 2), literal = '\\'.repeat ? '\\'.repeat(pairs) : new Array(pairs + 1).join('\\');
      return literal + (marker === '`' ? '\u0018' : (slashes.length % 2 ? '\u0002' + marker : marker));
    });
  }

  function byteLength(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(value)).length;
    return unescape(encodeURIComponent(String(value))).length;
  }

  function ShellError(message, code) {
    this.name = 'ShellError';
    this.message = message;
    this.code = code || 'EIO';
    if (Error.captureStackTrace) Error.captureStackTrace(this, ShellError);
  }
  ShellError.prototype = Object.create(Error.prototype);
  ShellError.prototype.constructor = ShellError;

  function normalizeNode(node) {
    if (node == null) return null;
    if (typeof node === 'string' || node instanceof Uint8Array) {
      return { type: 'file', content: typeof node === 'string' ? node : decodeBytes(node), size: byteLength(typeof node === 'string' ? node : decodeBytes(node)) };
    }
    if (Array.isArray(node)) {
      return { type: 'dir', entries: node.map(function (entry) {
        return typeof entry === 'string' ? { name: entry } : { name: entry.name, type: entry.type };
      }) };
    }
    if (typeof node === 'object' && node.type === 'dir') {
      return { type: 'dir', entries: node.entries || [], mtime: node.mtime, mode: node.mode };
    }
    if (typeof node === 'object' && (node.type === 'file' || 'content' in node)) {
      return { type: 'file', content: String(node.content == null ? '' : node.content), size: node.size, mtime: node.mtime, mode: node.mode };
    }
    return null;
  }

  function decodeBytes(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
  }

  function createVfs(callbacks) {
    callbacks = callbacks || {};
    if (typeof callbacks.read !== 'function') throw new TypeError('BashJS requires a read(path) callback');
    if (typeof callbacks.write !== 'function') throw new TypeError('BashJS requires a write(path, content, opts) callback');
    if (typeof callbacks.delete !== 'function') throw new TypeError('BashJS requires a delete(path, opts) callback');
    if (typeof callbacks.move !== 'function') throw new TypeError('BashJS requires a move(src, dst) callback');
    var cache = new Map();

    async function raw(path) {
      path = normalizePath(path);
      if (path === '/dev/null' || path === '/dev/zero') return { type: 'file', content: path === '/dev/zero' ? '\0' : '' };
      if (cache.has(path)) return cache.get(path);
      var value;
      try { value = await callbacks.read(path); }
      catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'NotFound')) return null;
        throw new ShellError(error && error.message || String(error), error && error.code || 'EIO');
      }
      var node = normalizeNode(value);
      cache.set(path, node);
      return node;
    }

    function invalidate(path) {
      path = normalizePath(path);
      Array.from(cache.keys()).forEach(function (key) {
        if (key === path || key.indexOf(path === '/' ? '/' : path + '/') === 0 || path.indexOf(key === '/' ? '/' : key + '/') === 0) cache.delete(key);
      });
    }

    return {
      // Cached reads are only valid within one top-level exec(); the host may
      // change files between calls.
      clearCache: function () { cache.clear(); },
      stat: async function (path) {
        path = normalizePath(path);
        if (path === '/dev/null' || path === '/dev/zero') return { type: 'file', size: path === '/dev/zero' ? 1 : 0 };
        if (typeof callbacks.stat === 'function') {
          try { var result = await callbacks.stat(path); if (result) return result; }
          catch (error) { throw new ShellError(error && error.message || String(error), error && error.code || 'EIO'); }
        }
        var node = await raw(path);
        if (!node) return null;
        return { type: node.type, size: node.size == null ? (node.type === 'file' ? byteLength(node.content) : 0) : node.size, mtime: node.mtime, mode: node.mode };
      },
      exists: async function (path) {
        path = normalizePath(path);
        if (path === '/dev/null' || path === '/dev/zero') return true;
        if (typeof callbacks.exists === 'function') {
          try { return !!(await callbacks.exists(normalizePath(path))); }
          catch (error) { throw new ShellError(error && error.message || String(error), error && error.code || 'EIO'); }
        }
        return !!(await raw(path));
      },
      isDir: async function (path) { var s = await this.stat(path); return !!s && s.type === 'dir'; },
      isFile: async function (path) { var s = await this.stat(path); return !!s && s.type === 'file'; },
      readFile: async function (path) {
        path = normalizePath(path);
        if (path === '/dev/null') return '';
        if (path === '/dev/zero') return '\0';
        var node = await raw(path);
        if (!node) throw new ShellError(path + ': No such file or directory', 'ENOENT');
        if (node.type === 'dir') throw new ShellError(path + ': Is a directory', 'EISDIR');
        return node.content;
      },
      readDir: async function (path) {
        path = normalizePath(path);
        var node = await raw(path);
        if (!node) throw new ShellError(path + ': No such file or directory', 'ENOENT');
        if (node.type !== 'dir') throw new ShellError(path + ': Not a directory', 'ENOTDIR');
        var entries = [];
        for (var i = 0; i < node.entries.length; i++) {
          var e = node.entries[i];
          var name = typeof e === 'string' ? e : e.name;
          if (!name) continue;
          var type = typeof e === 'object' && e.type ? e.type : undefined;
          entries.push({ name: name, type: type });
        }
        entries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
        return entries;
      },
      writeFile: async function (path, data, opts) {
        path = normalizePath(path); opts = opts || {};
        if (path === '/dev/null' || path === '/dev/zero') return;
        try { await callbacks.write(path, String(data == null ? '' : data), { append: !!opts.append }); }
        catch (error) { throw new ShellError(error && error.message || String(error), error && error.code || 'EIO'); }
        invalidate(path);
      },
      mkdir: async function (path, opts) {
        path = normalizePath(path); opts = opts || {};
        if (opts.parents) {
          var parts = path.split('/').filter(Boolean), current = '';
          for (var i = 0; i < parts.length; i++) {
            current += '/' + parts[i];
            if (await this.exists(current)) {
              if (!(await this.isDir(current))) throw new ShellError(current + ': Not a directory', 'ENOTDIR');
            } else {
              try { await callbacks.write(current, null, { type: 'dir' }); }
              catch (error) { throw new ShellError(error && error.message || String(error), error && error.code || 'EIO'); }
              invalidate(current);
            }
          }
        } else {
          try { await callbacks.write(path, null, { type: 'dir' }); }
          catch (error) { throw new ShellError(error && error.message || String(error), error && error.code || 'EIO'); }
          invalidate(path);
        }
      },
      remove: async function (path, opts) {
        path = normalizePath(path);
        try { await callbacks.delete(path, opts || {}); }
        catch (error) { throw new ShellError(error && error.message || String(error), error && error.code || 'EIO'); }
        invalidate(path);
      },
      rename: async function (src, dst) {
        src = normalizePath(src); dst = normalizePath(dst);
        try { await callbacks.move(src, dst); }
        catch (error) { throw new ShellError(error && error.message || String(error), error && error.code || 'EIO'); }
        invalidate(src); invalidate(dst);
      },
      walk: async function (path, visitor, opts) {
        opts = opts || {};
        var root = normalizePath(path);
        async function visit(current, depth) {
          var stat = await this.stat(current);
          if (!stat) return;
          await visitor(current, stat, depth);
          if (stat.type !== 'dir' || (opts.maxdepth != null && depth >= opts.maxdepth)) return;
          var children = await this.readDir(current);
          for (var i = 0; i < children.length; i++) {
            if (!opts.followHidden && children[i].name.charAt(0) === '.') continue;
            await visit.call(this, resolvePath(current, children[i].name), depth + 1);
          }
        }
        await visit.call(this, root, 0);
      }
    };
  }

  function InputStream(value) {
    this.value = String(value == null ? '' : value);
    this.position = 0;
  }
  InputStream.prototype.readAll = function () { var s = this.value.slice(this.position); this.position = this.value.length; return s; };
  InputStream.prototype.readLine = function () {
    if (this.position >= this.value.length) return null;
    var end = this.value.indexOf('\n', this.position);
    if (end < 0) { var last = this.value.slice(this.position); this.position = this.value.length; return last; }
    var line = this.value.slice(this.position, end); this.position = end + 1; return line;
  };
  // Reads up to (not including) delim; { text, found } (found: delim was seen).
  InputStream.prototype.readUntil = function (delim) {
    if (this.position >= this.value.length) return null;
    var end = this.value.indexOf(delim, this.position);
    if (end < 0) { var rest = this.value.slice(this.position); this.position = this.value.length; return { text: rest, found: false }; }
    var text = this.value.slice(this.position, end); this.position = end + delim.length; return { text: text, found: true };
  };
  InputStream.prototype.readChars = function (n) { var s = this.value.slice(this.position, this.position + Math.max(0, n)); this.position += s.length; return s; };
  InputStream.prototype.eof = function () { return this.position >= this.value.length; };

  function BufferSink() { this.chunks = []; this.closed = false; }
  BufferSink.prototype.write = function (chunk) { if (!this.closed) this.chunks.push(String(chunk)); };
  BufferSink.prototype.close = function () { this.closed = true; };
  BufferSink.prototype.toString = function () { return this.chunks.join(''); };

  function HostSink(fn) { this.fn = typeof fn === 'function' ? fn : function () {}; }
  HostSink.prototype.write = function (chunk) { this.fn(String(chunk)); };
  HostSink.prototype.close = function () {};

  function FdTable(entries) {
    this.entries = new Map(entries || [[0, { input: new InputStream('') }], [1, { output: new BufferSink() }], [2, { output: new BufferSink() }]]);
  }
  FdTable.prototype.clone = function () { return new FdTable(this.entries); };
  FdTable.prototype.get = function (fd) { return this.entries.get(Number(fd)); };
  FdTable.prototype.set = function (fd, value) { this.entries.set(Number(fd), value); };
  FdTable.prototype.close = function (fd) { this.entries.delete(Number(fd)); };

  function lex(source) {
    source = String(source || '');
    var tokens = [], i = 0, heredocs = [];
       function addQuoted(ch) {
         // Keep the small amount of quote provenance needed by later expansion
         // passes without changing the public WORD representation.
         word += markQuoted(ch);
       }
       function lineContinuationAt(at) {
         if (source[at] !== '\\') return 0;
         if (source[at + 1] === '\n') return 2;
         if (source[at + 1] === '\r' && source[at + 2] === '\n') return 3;
         return 0;
       }
       while (i < source.length) {
      var c = source[i];
       var continuation = lineContinuationAt(i);
       if (continuation) { i += continuation; continue; }
       if (/\s/.test(c)) {
         if (c === '\n') {
           tokens.push({ type: 'NEWLINE', value: '\n' }); i++;
           for (var hi = 0; hi < heredocs.length; hi++) {
             var hd = heredocs[hi], body = '';
              var foundDelimiter = false;
              while (i < source.length) {
                var end = source.indexOf('\n', i), line = end < 0 ? source.slice(i) : source.slice(i, end);
                line = line.replace(/\r$/, '');
                var compare = hd.strip ? line.replace(/^\t+/, '') : line;
                i = end < 0 ? source.length : end + 1;
                if (compare === hd.delimiter) { foundDelimiter = true; break; }
                body += (hd.strip ? line.replace(/^\t+/, '') : line) + (end < 0 ? '' : '\n');
              }
              if (!foundDelimiter) throw new SyntaxError('missing here-document delimiter: ' + hd.delimiter);
             hd.token.body = body;
           }
           // Each here-document body is consumed exactly once.
           heredocs = [];
         } else i++;
         continue;
       }
      if (c === '#' && (i === 0 || /\s/.test(source[i - 1]) || /[|;&><()]/.test(source[i - 1]))) { while (i < source.length && source[i] !== '\n') i++; continue; }
       var op = ['&>>', '<<<', '<<-', '>|', '<>', '<<', '>>', '&>', '>&', '<&', '&&', '||', '|&', '|', ';;&', ';;', ';&', ';', '&', '>', '<', '(', ')'].find(function (x) { return source.slice(i, i + x.length) === x; });
       if (op) { var opToken = { type: 'OP', value: op, start: i, end: i + op.length }; tokens.push(opToken); if (op === '<<' || op === '<<-') opToken.heredoc = true; i += op.length; continue; }
         var wordStart = i, word = '', quote = null, started = false, wasQuoted = false, wordSegments = [], segmentText = '', segmentQuote = false;
       function flushWordSegment() {
          if (segmentText || segmentQuote) wordSegments.push({ value: segmentText, quoted: segmentQuote });
         segmentText = '';
       }
       while (i < source.length) {
         c = source[i];
          if (quote === "'") { if (c === "'") { flushWordSegment(); quote = null; segmentQuote = false; } else { addQuoted(c === '$' ? '\u0001' : c); segmentText += markQuoted(c === '$' ? '\u0001' : c); } i++; continue; }
         if (quote === '"') {
           if (c === '"') { flushWordSegment(); quote = null; segmentQuote = false; i++; continue; }
           var dqContinuation = lineContinuationAt(i);
           if (dqContinuation) { i += dqContinuation; continue; }
           if (c === '\\' && i + 1 < source.length && /["\\$`]/.test(source[i + 1])) { var dq = source[i + 1] === '$' ? '\u0001' : source[i + 1]; word += dq; segmentText += dq; i += 2; continue; }
           if (c === '$' && source[i + 1] === '{') {
             // `${...}` keeps its operators and patterns (`${f%.*}`) unmarked.
             var paramDepth = 0, paramEnd = i;
             for (; paramEnd < source.length; paramEnd++) {
               if (source[paramEnd] === '{') paramDepth++;
               else if (source[paramEnd] === '}' && --paramDepth === 0) break;
             }
             var param = source.slice(i, paramEnd + 1);
             word += param; segmentText += param; i = paramEnd + 1; continue;
           }
           if (c === '$' && /[?*@#!$\-0-9]/.test(source[i + 1] || '')) { word += c + source[i + 1]; segmentText += c + source[i + 1]; i += 2; continue; }
            addQuoted(c); segmentText += markQuoted(c); i++; continue;
         }
          if (c === '$' && source[i + 1] === "'") {
            // ANSI-C quoting: $'a\tb' is a quoted word with C escapes decoded.
            var ansiEnd = i + 2, ansiRaw = '';
            while (ansiEnd < source.length && source[ansiEnd] !== "'") {
              if (source[ansiEnd] === '\\' && ansiEnd + 1 < source.length) { ansiRaw += source[ansiEnd] + source[ansiEnd + 1]; ansiEnd += 2; continue; }
              ansiRaw += source[ansiEnd++];
            }
            if (ansiEnd >= source.length) throw new SyntaxError('unterminated quote');
            flushWordSegment(); segmentQuote = true; wasQuoted = true; started = true;
            Array.from(decodeEscapes(ansiRaw, 'fmt').text).forEach(function (ch) { var q = ch === '$' ? '\u0001' : ch; addQuoted(q); segmentText += markQuoted(q); });
            flushWordSegment(); segmentQuote = false;
            i = ansiEnd + 1; continue;
          }
          if (c === "'" || c === '"') { flushWordSegment(); quote = c; segmentQuote = true; wasQuoted = true; started = true; i++; continue; }
           var wordContinuation = lineContinuationAt(i);
           if (wordContinuation) { i += wordContinuation; continue; }
           if (c === '\\' && i + 1 < source.length) { var esc = source[i + 1] === '$' ? '\u0001' : source[i + 1]; addQuoted(esc); segmentText += markQuoted(esc); wasQuoted = true; i += 2; started = true; continue; }
           if (c === '$' && source[i + 1] === '{') {
             // `${...}` is one word even with blanks or operators inside
             // (`${s: -2}`, `${a[@]}`); quotes inside it mark literal text.
             var braceDepth = 0, j = i, inner = '';
             while (j < source.length) {
               var pc = source[j];
               if (pc === '\\' && j + 1 < source.length) { inner += markQuoted(source[j + 1] === '$' ? '\u0001' : source[j + 1]); j += 2; continue; }
               if (pc === "'" || pc === '"') {
                 var closeQuote = source.indexOf(pc, j + 1);
                 if (closeQuote < 0) closeQuote = source.length;
                 Array.from(source.slice(j + 1, closeQuote)).forEach(function (qc) { inner += pc === "'" && qc === '$' ? '\u0001' : qc === '$' ? qc : markQuoted(qc); });
                 j = closeQuote + 1; continue;
               }
               if (pc === '{') braceDepth++;
               else if (pc === '}' && --braceDepth === 0) { inner += pc; j++; break; }
               inner += pc; j++;
             }
             word += inner; segmentText += inner; started = true; i = j; continue;
           }
        if (/\s/.test(c) || ['|', ';', '&', '>', '<', '(', ')'].indexOf(c) >= 0) break;
         word += c; segmentText += c; started = true; i++;
      }
      if (quote) throw new SyntaxError('unterminated quote');
      if (!started && !word) throw new SyntaxError('unexpected token');
         flushWordSegment();
         var wordToken = { type: 'WORD', value: word, quoted: wasQuoted, segments: wordSegments, start: wordStart, end: i };
       tokens.push(wordToken);
       if (tokens.length > 1 && tokens[tokens.length - 2].heredoc) {
         var hot = tokens[tokens.length - 2];
         heredocs.push({ delimiter: word.replace(/\u0001/g, '$'), strip: hot.value === '<<-', token: wordToken });
       }
    }
    tokens.push({ type: 'EOF', value: '' });
    return tokens;
  }
  function parse(source) {
    source = String(source || '');
    var ts = lex(source), p = 0;
    var REDIRECT_OPS = /^(?:<|>|>>|>\||<>|&>|&>>|<<|<<-|<<<|>&|<&)$/;
    var TERMINATOR_WORDS = { then: 1, 'else': 1, elif: 1, fi: 1, 'do': 1, done: 1, esac: 1, '}': 1 };
    function tok(k) { return ts[Math.min(p + (k || 0), ts.length - 1)]; }
    function isWord(value, k) { var t = tok(k); return t.type === 'WORD' && !t.quoted && t.value === value; }
    function isOp(value, k) { var t = tok(k); return t.type === 'OP' && t.value === value; }
    // Constructs being parsed, for "unexpected end of file from `if' ..." errors.
    var open = [];
    function lineOf(pos) { return source.slice(0, pos).split('\n').length; }
    function opened(word) { open.push({ word: word, line: lineOf(tok().start || 0) }); }
    function closed() { open.pop(); }
    function fail(t) {
      t = t || tok();
      var error;
      if (t.type === 'EOF') {
        var top = open[open.length - 1];
        error = new SyntaxError('syntax error: unexpected end of file' + (top ? ' from `' + top.word + "' command on line " + top.line : ''));
      } else {
        error = new SyntaxError('syntax error near unexpected token `' + (t.type === 'NEWLINE' ? 'newline' : t.value) + "'");
        error.line = lineOf(t.start || 0);
      }
      throw error;
    }
    function expectWord(value) { if (!isWord(value)) fail(); p++; }
    function skipNewlines() { while (tok().type === 'NEWLINE') p++; }
    function wordOf(t) { return { text: t.value, quoted: !!t.quoted, segments: t.segments || [] }; }
    function atListEnd(terms) {
      var t = tok();
      if (t.type === 'EOF') return true;
      if (t.type === 'OP' && (t.value === ')' || t.value === ';;' || t.value === ';&' || t.value === ';;&')) return true;
      return t.type === 'WORD' && !t.quoted && !!terms && terms.indexOf(t.value) >= 0;
    }
    function parseList(terms) {
      var items = [];
      while (true) {
        while (tok().type === 'NEWLINE' || isOp(';')) p++;
        if (atListEnd(terms)) break;
        var node = parseAndOr(), sep = ';';
        if (isOp(';') || isOp('&')) sep = ts[p++].value;
        else if (tok().type === 'NEWLINE') p++;
        else if (!atListEnd(terms)) fail();
        items.push({ node: node, sep: sep });
      }
      return { type: 'List', items: items };
    }
    function parseBody(terms) {
      var list = parseList(terms);
      if (!list.items.length) fail();
      return list;
    }
    function parseAndOr() {
      var left = parsePipeline();
      while (isOp('&&') || isOp('||')) { var op = ts[p++].value; skipNewlines(); left = { type: 'AndOr', left: left, op: op, right: parsePipeline() }; }
      return left;
    }
    function parsePipeline() {
      var negated = false;
      if (isWord('time')) { p++; if (isWord('-p')) p++; }
      while (isWord('!')) { negated = !negated; p++; }
      var stages = [parseCommand()], pipeStderr = [];
      while (isOp('|') || isOp('|&')) { pipeStderr.push(ts[p++].value === '|&'); skipNewlines(); stages.push(parseCommand()); }
      if (stages.length === 1 && !negated) return stages[0];
      return { type: 'Pipeline', commands: stages, pipeStderr: pipeStderr, negated: negated };
    }
    // Text between `((` and the matching `))`, read from the source.
    function arithmeticText() {
      var from = tok(1).end, depth = 2, i = from;
      while (i < source.length && depth > 0) { if (source[i] === '(') depth++; else if (source[i] === ')') depth--; i++; }
      if (depth > 0 || source[i - 2] !== ')') fail(tok(1));
      var text = source.slice(from, i - 2);
      while (tok().type !== 'EOF' && tok().start < i) p++;
      return text;
    }
    function parseRedirect(fd) {
      var opToken = ts[p++], target = tok();
      if (target.type !== 'WORD') fail(target);
      p++;
      return { fd: fd, op: opToken.value, target: target.value, body: target.body, quoted: target.quoted };
    }
    function withRedirects(node) {
      node.redirects = [];
      while (true) {
        var t = tok();
        if (t.type === 'OP' && REDIRECT_OPS.test(t.value)) { node.redirects.push(parseRedirect(null)); continue; }
        if (t.type === 'WORD' && !t.quoted && /^\d+$/.test(t.value) && tok(1).type === 'OP' && REDIRECT_OPS.test(tok(1).value) && tok(1).start === t.end) {
          p++; node.redirects.push(parseRedirect(Number(t.value))); continue;
        }
        return node;
      }
    }
    function parseCommand() {
      var t = tok();
      if (t.type === 'WORD' && !t.quoted) {
        switch (t.value) {
          case 'if': return withRedirects(parseIf());
          case 'while': case 'until': return withRedirects(parseWhile());
          case 'for': return withRedirects(parseFor());
          case 'case': return withRedirects(parseCase());
          case '{': { opened('{'); p++; var body = parseBody(['}']); expectWord('}'); closed(); return withRedirects({ type: 'Group', body: body }); }
          case '[[': return withRedirects(parseConditional());
          case 'function': return parseFunction(true);
        }
        if (TERMINATOR_WORDS[t.value]) fail(t);
        if (/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(t.value) && isOp('(', 1) && isOp(')', 2)) return parseFunction(false);
      }
      if (t.type === 'OP' && t.value === '(') {
        if (isOp('(', 1) && tok(1).start === t.end) return withRedirects({ type: 'Arith', expr: arithmeticText() });
        p++;
        var inner = parseBody(null);
        if (!isOp(')')) fail();
        p++;
        return withRedirects({ type: 'Subshell', body: inner });
      }
      return parseSimple();
    }
    function parseSimple() {
      var words = [], redirects = [], arrayAssigns = [];
      while (true) {
        var t = tok();
        if (t.type === 'OP' && REDIRECT_OPS.test(t.value)) {
          var fd = null, last = words[words.length - 1];
          if (last && !last.quoted && /^\d+$/.test(last.text) && last.end === t.start) { fd = Number(last.text); words.pop(); }
          redirects.push(parseRedirect(fd));
          continue;
        }
        if (t.type !== 'WORD') break;
        // name=( ... ) and name+=( ... ): array assignment.
        var am = !t.quoted && /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=$/.exec(t.value);
        if (am && isOp('(', 1) && tok(1).start === t.end) {
          p += 2;
          var items = [];
          while (true) {
            skipNewlines();
            if (isOp(')')) { p++; break; }
            if (tok().type !== 'WORD') fail();
            items.push(wordOf(ts[p++]));
          }
          arrayAssigns.push({ name: am[1], append: am[2] === '+', items: items, position: words.length });
          continue;
        }
        var w = wordOf(t); w.end = t.end;
        words.push(w); p++;
      }
      if (!words.length && !redirects.length && !arrayAssigns.length) fail();
      words.forEach(function (w) { delete w.end; });
      return { type: 'SimpleCommand', words: words, redirects: redirects, arrayAssigns: arrayAssigns };
    }
    function parseIf() {
      opened('if'); p++;
      var clauses = [], cond = parseBody(['then']);
      expectWord('then');
      clauses.push({ cond: cond, body: parseBody(['elif', 'else', 'fi']) });
      while (isWord('elif')) {
        p++;
        var c = parseBody(['then']);
        expectWord('then');
        clauses.push({ cond: c, body: parseBody(['elif', 'else', 'fi']) });
      }
      var elseBody = null;
      if (isWord('else')) { p++; elseBody = parseBody(['fi']); }
      expectWord('fi'); closed();
      return { type: 'If', clauses: clauses, elseBody: elseBody };
    }
    function parseWhile() {
      opened(tok().value);
      var until = ts[p++].value === 'until';
      var cond = parseBody(['do']);
      expectWord('do');
      var body = parseBody(['done']);
      expectWord('done'); closed();
      return { type: 'While', until: until, cond: cond, body: body };
    }
    function parseDoBody() {
      while (tok().type === 'NEWLINE' || isOp(';')) p++;
      if (isWord('{')) { p++; var group = parseBody(['}']); expectWord('}'); return group; }
      expectWord('do');
      var body = parseBody(['done']);
      expectWord('done');
      return body;
    }
    function parseFor() {
      opened('for'); p++;
      if (isOp('(') && isOp('(', 1)) {
        var text = arithmeticText(), parts = [], depth = 0, current = '';
        for (var i = 0; i < text.length; i++) {
          var ch = text[i];
          if (ch === '(') depth++; else if (ch === ')') depth--;
          if (ch === ';' && depth === 0) { parts.push(current); current = ''; } else current += ch;
        }
        parts.push(current);
        if (parts.length !== 3) throw new SyntaxError("syntax error: arithmetic expression required");
        var arithBody = parseDoBody(); closed();
        return { type: 'ArithFor', init: parts[0], cond: parts[1], step: parts[2], body: arithBody };
      }
      var nameTok = tok();
      if (nameTok.type !== 'WORD' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nameTok.value)) fail(nameTok);
      p++;
      skipNewlines();
      var items = null;
      if (isWord('in')) {
        p++; items = [];
        while (tok().type === 'WORD') items.push(wordOf(ts[p++]));
        if (!isOp(';') && tok().type !== 'NEWLINE' && !isWord('do')) fail();
      }
      var forBody = parseDoBody(); closed();
      return { type: 'For', name: nameTok.value, items: items, body: forBody };
    }
    function parseCase() {
      opened('case'); p++;
      if (tok().type !== 'WORD') fail();
      var word = wordOf(ts[p++]);
      skipNewlines();
      expectWord('in');
      var items = [];
      while (true) {
        skipNewlines();
        if (isWord('esac')) { p++; closed(); break; }
        if (isOp('(')) p++;
        var patterns = [];
        while (true) {
          if (tok().type !== 'WORD') fail();
          patterns.push(wordOf(ts[p++]));
          if (isOp('|')) { p++; continue; }
          break;
        }
        if (!isOp(')')) fail();
        p++;
        var body = parseList(['esac']), terminator = ';;';
        if (isOp(';;') || isOp(';&') || isOp(';;&')) terminator = ts[p++].value;
        else if (!isWord('esac')) fail();
        items.push({ patterns: patterns, body: body, terminator: terminator });
      }
      return { type: 'Case', word: word, items: items };
    }
    // [[ expression ]]: operands stay unexpanded words; `<`, `>`, `(`, `)`,
    // `&&`, `||` arrive as operator tokens.
    function parseConditional() {
      p++;
      var UNARY = /^-[abcdefghknoprstuvwxzGLNOS]$/, BINARY = { '==': 1, '=': 1, '!=': 1, '=~': 1, '<': 1, '>': 1, '-eq': 1, '-ne': 1, '-lt': 1, '-le': 1, '-gt': 1, '-ge': 1, '-nt': 1, '-ot': 1, '-ef': 1 };
      function operand() { var t = tok(); if (t.type !== 'WORD' || isWord(']]')) fail(t); p++; return wordOf(t); }
      function primary() {
        skipNewlines();
        if (isOp('(')) { p++; var e = orExpr(); skipNewlines(); if (!isOp(')')) fail(); p++; return e; }
        var t = tok();
        if (t.type !== 'WORD' || isWord(']]')) fail(t);
        if (!t.quoted && UNARY.test(t.value) && tok(1).type === 'WORD' && !isWord(']]', 1)) { p++; return { type: 'unary', op: t.value, operand: operand() }; }
        var left = operand(), n = tok();
        var op = n.type === 'OP' && (n.value === '<' || n.value === '>') ? n.value : (n.type === 'WORD' && !n.quoted && BINARY[n.value] ? n.value : null);
        if (!op) return { type: 'word', word: left };
        p++;
        if (op === '=~') {
          // The regex runs to `]]` (or a top-level && / ||); operators inside
          // it are part of the pattern, so take the source text verbatim.
          var start = tok().start, depth = 0;
          if (tok().type === 'WORD' && (isWord(']]', 1) || isOp('&&', 1) || isOp('||', 1))) return { type: 'binary', op: op, left: left, right: operand() };
          while (tok().type !== 'EOF' && !(depth === 0 && (isWord(']]') || isOp('&&') || isOp('||')))) {
            if (isOp('(')) depth++; else if (isOp(')')) depth--;
            p++;
          }
          return { type: 'binary', op: op, left: left, right: { text: source.slice(start, tok().start).trim(), quoted: false, segments: [], raw: true } };
        }
        return { type: 'binary', op: op, left: left, right: operand() };
      }
      function notExpr() { skipNewlines(); if (isWord('!')) { p++; return { type: 'not', expr: notExpr() }; } return primary(); }
      function andExpr() { var l = notExpr(); while (isOp('&&')) { p++; l = { type: 'and', left: l, right: notExpr() }; } return l; }
      function orExpr() { var l = andExpr(); while (isOp('||')) { p++; l = { type: 'or', left: l, right: andExpr() }; } return l; }
      var expr = orExpr();
      skipNewlines();
      expectWord(']]');
      return { type: 'Cond', expr: expr };
    }
    function parseFunction(keyword) {
      var name;
      if (keyword) {
        p++;
        if (tok().type !== 'WORD') fail();
        name = ts[p++].value;
        if (isOp('(') && isOp(')', 1)) p += 2;
      } else { name = ts[p].value; p += 3; }
      skipNewlines();
      var body = parseCommand();
      if (body.type === 'SimpleCommand' || body.type === 'Pipeline') fail();
      return { type: 'FunctionDef', name: name, body: body };
    }
    var body = parseList(null);
    if (tok().type !== 'EOF') fail();
    return { type: 'Script', body: body };
  }

  function arithmetic(source, env, depth) {
    depth = depth || 0;
    // Variables are evaluated recursively (x=y, y=x+1); bash caps the depth.
    if (depth > 1024) throw new SyntaxError('expression recursion level exceeded');
    var tokens = [], pos = 0, at = 0;
    // Assignments and `**` group right-to-left; comparisons left-to-right.
    function rightAssociative(op) { return op === '**' || (op.charAt(op.length - 1) === '=' && ['==', '!=', '<=', '>='].indexOf(op) < 0); }
    function peek() { return tokens[at]; }
    function take() { return tokens[at++]; }
    function num(raw) {
      var n;
      if (raw.indexOf('#') >= 0) {
        var p = raw.split('#'), base = Number(p[0]);
        if (p.length !== 2 || !/^\d+$/.test(p[0]) || base < 2 || base > 64 || !p[1]) throw new SyntaxError('invalid base');
        n = 0n;
        for (var c of p[1]) {
          var code = c.charCodeAt(0), d;
          if (code >= 48 && code <= 57) d = code - 48;
          else if (code >= 97 && code <= 122) d = code - 87;
          else if (code >= 65 && code <= 90) d = base <= 36 ? code - 55 : code - 29;
          else if (c === '@') d = 62;
          else if (c === '_') d = 63;
          else throw new SyntaxError('invalid integer');
          if (d >= base) throw new SyntaxError('invalid integer');
          n = n * BigInt(base) + BigInt(d);
        }
        return n;
      }
      if (/^0[xX]/.test(raw)) return BigInt(raw);
      if (raw.length > 1 && raw[0] === '0') return BigInt('0o' + raw.slice(1));
      return BigInt(raw);
    }
     var originalEnv = env, workingEnv = Object.assign({}, env), evaluating = true;
    env = workingEnv;
     function value(name) { if (!evaluating) return 0n; var x = String(env[name] == null ? '0' : env[name]); return x.trim() ? arithmeticLiteral(x.trim()) : 0n; }
    function arithmeticLiteral(x) { if (/^0[xX][0-9a-fA-F]+$/.test(x) || /^[0-9]+$/.test(x)) return num(x); return arithmetic(x, env, depth + 1); }
    var prec = { ',':1, '=':2, '+=':2, '-=':2, '*=':2, '/=':2, '%=':2, '<<=':2, '>>=':2, '&=':2, '^=':2, '|=':2, '?':3, '||':4, '&&':5, '|':6, '^':7, '&':8, '==':9, '!=':9, '<':10, '<=':10, '>':10, '>=':10, '<<':11, '>>':11, '+':12, '-':12, '*':13, '/':13, '%':13, '**':15 };
    var ops = Object.keys(prec).concat(['++','--','!','~','(',')',':']).sort((a,b)=>b.length-a.length);
    // Re-tokenize operators longest-first (including pairs).
    at=0;
     while(pos<source.length) { var ch=source[pos]; if(/\s/.test(ch)){pos++;continue;} var mm=source.slice(pos).match(/^(0[xX][0-9a-fA-F]+|[0-9]+(?:#[0-9a-zA-Z@_]+)?|\$?[A-Za-z_][A-Za-z0-9_]*)/); if(mm){tokens.push({type:/^[0-9]/.test(mm[0])?'num':'id',value:mm[0].replace(/^\$/,'')});pos+=mm[0].length;continue;} var op=ops.find(x=>source.slice(pos,pos+x.length)===x); if(!op) throw new SyntaxError('invalid arithmetic syntax'); tokens.push({type:'op',value:op});pos+=op.length; }
    tokens.push({type:'eof'}); at=0;
    function expression(min) {
      var t=take(), left, name;
      if(t.type==='num') left={v:num(t.value)};
      else if(t.type==='id') { name=t.value; left={v:value(name),name:name}; }
      else if(t.value==='(') { left=expression(1); if(take().value!==')') throw new SyntaxError('missing )'); }
       else if(['+','-','!','~','++','--'].includes(t.value)) { left=expression(16); var un=t.value; if(un==='++'||un==='--'){if(evaluating&&!left.name) throw new SyntaxError('invalid lvalue'); if(evaluating){left.v+=un==='++'?1n:-1n;env[left.name]=String(left.v);}} else left={v:!evaluating?0n:un==='+'?left.v:un==='-'?-left.v:un==='!'?(left.v?0n:1n):~left.v}; }
      else throw new SyntaxError('invalid arithmetic syntax');
       if(peek().value==='++'||peek().value==='--'){var post=take().value;if(evaluating&&!left.name)throw new SyntaxError('invalid lvalue');var old=left.v;if(evaluating)env[left.name]=String(old+(post==='++'?1n:-1n));left={v:old};}
       while(true){var op=peek().value, p=prec[op];if(!p||p<min)break;take();if(op==='?'){var chooseYes=!!left.v, wasEvaluating=evaluating;evaluating=wasEvaluating&&chooseYes;var yes=expression(1);if(take().value!==':')throw new SyntaxError('missing :');evaluating=wasEvaluating&&!chooseYes;var no=expression(p);evaluating=wasEvaluating;left={v:chooseYes?yes.v:no.v};continue;} var wasEval=evaluating;if(op==='&&'&&!left.v||op==='||'&&left.v)evaluating=false;var right=expression(p+(rightAssociative(op)?0:1));evaluating=wasEval; var a=left.v,b=right.v,z;
         if(!evaluating)z=0n; else if(op===',')z=b; else if(op==='='){if(!left.name)throw new SyntaxError('invalid lvalue');env[left.name]=String(b);z=b;}
         else if(op.endsWith('=')&&op!=='=='&&op!=='!='&&op!=='<='&&op!=='>='){if(!left.name)throw new SyntaxError('invalid lvalue');var basic=op.slice(0,-1);z=calculate(basic,a,b);env[left.name]=String(z);}
         else z=calculate(op,a,b);left=op===','?{v:z,name:right.name}: {v:z};
      } return left;
    }
      function calculate(op,a,b){switch(op){case '+':return a+b;case '-':return a-b;case '*':return a*b;case '/':if(!b)throw new Error('division by 0');return a/b;case '%':if(!b)throw new Error('division by 0');return a%b;case '**':if(b<0n)throw new Error('negative exponent');return a**b;case '<<':return a<<b;case '>>':return a>>b;case '<':return a<b?1n:0n;case '<=':return a<=b?1n:0n;case '>':return a>b?1n:0n;case '>=':return a>=b?1n:0n;case '==':return a===b?1n:0n;case '!=':return a!==b?1n:0n;case '&':return a&b;case '|':return a|b;case '^':return a^b;case '&&':return a&&b?1n:0n;case '||':return a||b?1n:0n;}}
     var result=expression(1);if(peek().type!=='eof')throw new SyntaxError('unexpected token'); Object.keys(workingEnv).forEach(function(k){ originalEnv[k]=workingEnv[k]; }); env=originalEnv; return String(result.v);
  }
  // Implements the field-splitting stage (pathname expansion is not yet
  // implemented). IFS whitespace collapses; other IFS chars delimit fields.
  function splitFields(value, ifs) {
    if (!ifs) return value === '' ? [] : [value];
    var whitespace = Array.from(ifs).filter(function (c) { return /[ \t\n]/.test(c); }).join('');
    var nonwhite = Array.from(ifs).filter(function (c) { return !/[ \t\n]/.test(c); }).join('');
    var fields = [], field = '', started = false, i = 0;
    while (i < value.length) {
      var c = value[i];
      if (whitespace.indexOf(c) >= 0) {
        if (started) { fields.push(field); field = ''; started = false; }
        while (i < value.length && whitespace.indexOf(value[i]) >= 0) i++;
        continue;
      }
      if (nonwhite.indexOf(c) >= 0) {
        fields.push(field); field = ''; started = false; i++;
        while (i < value.length && whitespace.indexOf(value[i]) >= 0) i++;
        continue;
      }
      field += c; started = true; i++;
    }
    if (started) fields.push(field);
    return fields;
  }
  var POSIX_CLASSES = {
    alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
    space: ' \\t\\n\\r\\f\\v', blank: ' \\t', xdigit: '0-9A-Fa-f',
    punct: '!-\\/:-@\\[-`{-~', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e'
  };
  function globRegex(pattern) {
    var out = '^';
    for (var i = 0; i < pattern.length; i++) {
      var c = pattern[i];
      if (c === '*') out += '[\\s\\S]*';
      else if (c === '?') out += '[\\s\\S]';
      else if (c === '[') {
        var end = i + 1, negate = false, body = '', first = true;
        if (pattern[end] === '!' || pattern[end] === '^') { negate = true; end++; }
        while (end < pattern.length && (pattern[end] !== ']' || first)) {
          var posix = pattern.slice(end).match(/^\[:([a-z]+):\]/);
          if (posix && POSIX_CLASSES[posix[1]]) { body += POSIX_CLASSES[posix[1]]; end += posix[0].length; first = false; continue; }
          var member = unmarkGlob(pattern[end]);
          body += /[\\\]\[^]/.test(member) ? '\\' + member : member;
          end++; first = false;
        }
        if (end >= pattern.length) { out += '\\['; continue; }
        out += '[' + (negate ? '^' : '') + body + ']'; i = end;
      } else if (GLOB_UNMARK[c]) out += '\\' + GLOB_UNMARK[c];
      else out += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
    }
    return new RegExp(out + '$');
  }
  // Returns null when the pattern has no unquoted glob characters, [] when it
  // has no matches, or the sorted matches. Matches keep the pattern's own
  // spelling of literal components (`./`, `../`, `//`), as bash does.
  // options: { dotglob, nocase } (shopt dotglob / nocaseglob).
  async function expandGlob(pattern, vfs, cwd, options) {
    options = options || {};
    if (!/[?*[]/.test(pattern)) return null;
    var absolute = pattern.charAt(0) === '/', trailingSlash = /\/$/.test(pattern);
    var parts = pattern.split('/').filter(Boolean);
    var paths = [{ abs: absolute ? '/' : cwd, shown: absolute ? '/' : '' }];
    function join(shown, name) { return shown === '' ? name : shown.charAt(shown.length - 1) === '/' ? shown + name : shown + '/' + name; }
    for (var i = 0; i < parts.length; i++) {
      var component = parts[i], magic = /[*?[]/.test(component), next = [];
      var mustBeDir = i < parts.length - 1 || trailingSlash;
      for (var p = 0; p < paths.length; p++) {
        if (!magic) {
          var literal = unmarkGlob(component), direct = resolvePath(paths[p].abs, literal);
          if (mustBeDir ? await vfs.isDir(direct) : await vfs.exists(direct)) next.push({ abs: direct, shown: join(paths[p].shown, literal) });
          continue;
        }
        var entries;
        try { entries = await vfs.readDir(paths[p].abs); } catch (_) { continue; }
        var re = globRegex(component), includeHidden = component.charAt(0) === '.' || options.dotglob;
        if (options.nocase) re = new RegExp(re.source, 'i');
        for (var e = 0; e < entries.length; e++) {
          var name = entries[e].name;
          if (name.charAt(0) === '.' && !includeHidden) continue;
          if (name === '.' || name === '..') continue;
          if (!re.test(name)) continue;
          var candidate = resolvePath(paths[p].abs, name);
          if (mustBeDir && !(entries[e].type ? entries[e].type === 'dir' : await vfs.isDir(candidate))) continue;
          next.push({ abs: candidate, shown: join(paths[p].shown, name) });
        }
      }
      paths = next;
      if (!paths.length) return [];
    }
    return paths.map(function (p) { return trailingSlash ? p.shown + '/' : p.shown; }).sort();
  }
  function createSession(config) {
    config = config || {};
    var cwd = resolvePath('/', config.cwd || '/');
    var env = Object.assign({}, config.env || {});
    env.PWD = cwd;
    // Child sessions ($(...), <(...), >(...)) share the parent's VFS so that
    // they see, and invalidate, the same read cache.
    var sharedVfs = !!config._vfs;
    var vfs = config._vfs || createVfs(config);
    var persistentFds = new Map();
    // Shell state beyond plain variables. Child sessions ($(...), <(...)) start
    // from a copy of their parent's state.
    var shell = newShellState(config._shell, config);
    var markers = config._markers || null;
    var out = '', err = '';
    var stdout = function (s) { s = String(s); out += s; if (s && typeof config.stdout === 'function') config.stdout(s); };
    var stderr = function (s) { err += String(s); if (typeof config.stderr === 'function') { try { config.stderr(String(s)); } catch (_) {} } };
    return {
      exec: async function (command, options) {
        options = options || {};
        out = '';
        err = '';
        if (!sharedVfs) vfs.clearCache();
        // Replace command substitutions with opaque characters before lexing.  A
        // separate session gives substitutions their own shell variables/cwd,
        // while retaining the same underlying VFS.
        var processFiles = new Map();
        var processOutputs = new Map();
        var nextProcessFd = 10;
        var commandArithmeticFailed = false;
        var originalCommand = String(command);
        // Substitution markers and their tables belong to the session (and are
        // shared with child sessions): function bodies parsed in one exec()
        // call keep their markers and may run in a later call or a subshell.
        if (!markers) markers = createMarkers();
        var substitutions = markers.substitutions, processSubstitutions = markers.processSubstitutions;
        var markerPrefix = markers.prefix;
        // Internal markers must never be confused with literal command data.
        // Pick a prefix absent from the input and environment. Expanded
        // environment values are scanned too, so a collision there would make
        // literal data look like one of our placeholders.
        function createMarkers() {
        var markerPrefix = '\u0010BASHJS';
        var markerNonce;
        // Use the platform CSPRNG where available (including browsers and
        // workers); never rely on Node-specific crypto APIs.
        var cryptoSource = typeof globalThis !== 'undefined' && globalThis.crypto;
        if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') {
          var nonceBytes = new Uint8Array(16);
          cryptoSource.getRandomValues(nonceBytes);
          markerNonce = Array.prototype.map.call(nonceBytes, function (byte) {
            return byte.toString(16).padStart(2, '0');
          }).join('');
        } else {
          // Legacy runtimes without Web Crypto still get a fresh nonce from
          // multiple independent ambient sources.
          markerNonce = Math.random().toString(36).slice(2) +
            Date.now().toString(36) + Math.random().toString(36).slice(2);
        }
        var markerValues = Object.keys(env).map(function (key) { return String(env[key]); });
        function markerCollision(candidate) {
          if (originalCommand.indexOf(candidate) >= 0) return true;
          return markerValues.some(function (value) { return value.indexOf(candidate) >= 0; });
        }
        while (markerCollision(markerPrefix + markerNonce + '\u0011')) {
          markerNonce += Math.random().toString(36).slice(2);
        }
        markerPrefix += markerNonce + '\u0011';
        return { prefix: markerPrefix, substitutions: [], processSubstitutions: [] };
        }
        var escapedPrefix = markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var commandMarker = function (index) { return markerPrefix + 'C' + index + '\u0011'; };
        var processMarker = function (index) { return markerPrefix + 'P' + index + '\u0011'; };
        async function substitute(source) {
          source = String(source);
          // Here-documents are data, not command text. Quoted bodies are kept
          // out of substitution scanning; unquoted bodies remain expandable.
          var heredocBodies = [], heredocTerminators = [], quotedDelimiters = [];
          // Locate here-document headers with a quote/comment-aware scan so
          // that `<<` inside quotes, comments, here-strings (`<<<`) and
          // arithmetic (`$((a<<b))`) is not mistaken for a header.
          (function scanHeredocs() {
            var pending = [], q = null, k = 0, n = source.length;
            while (k < n) {
              var ch = source[k];
              if (q === "'") { if (ch === "'") q = null; k++; continue; }
              if (ch === '\\') { k += 2; continue; }
              if (q === '"') { if (ch === '"') q = null; k++; continue; }
              if (ch === "'" || ch === '"') { q = ch; k++; continue; }
              if (ch === '#' && (k === 0 || /[\s;|&()]/.test(source[k - 1]))) { while (k < n && source[k] !== '\n') k++; continue; }
              if (source.startsWith('$((', k)) {
                var arithDepth = 2, m = k + 3;
                while (m < n && arithDepth) { if (source[m] === '(') arithDepth++; else if (source[m] === ')') arithDepth--; m++; }
                k = m; continue;
              }
              if (source.startsWith('<<<', k)) { k += 3; continue; }
              if (source.startsWith('<<', k)) {
                var m2 = k + 2, strip = false;
                if (source[m2] === '-') { strip = true; m2++; }
                while (source[m2] === ' ' || source[m2] === '\t') m2++;
                var wordStart = m2, delimiter = '', isQuoted = false, dquote = null;
                while (m2 < n) {
                  var dc = source[m2];
                  if (dquote) { if (dc === dquote) dquote = null; else delimiter += dc; m2++; continue; }
                  if (dc === "'" || dc === '"') { dquote = dc; isQuoted = true; m2++; continue; }
                  if (dc === '\\' && m2 + 1 < n) { delimiter += source[m2 + 1]; isQuoted = true; m2 += 2; continue; }
                  if (/[\s;|&<>()]/.test(dc)) break;
                  delimiter += dc; m2++;
                }
                if (m2 > wordStart) {
                  pending.push({ delimiter: delimiter, quoted: isQuoted, strip: strip });
                  // Keep a quoted delimiter word byte-for-byte for the lexer.
                  if (isQuoted) quotedDelimiters.push({ start: wordStart, end: m2 });
                }
                k = m2; continue;
              }
              if (ch === '\n' && pending.length) {
                k++;
                while (pending.length && k < n) {
                  var lineEnd = source.indexOf('\n', k), stop = lineEnd < 0 ? n : lineEnd + 1;
                  var content = source.slice(k, lineEnd < 0 ? n : lineEnd).replace(/\r$/, ''), hd = pending[0];
                  if ((hd.strip ? content.replace(/^\t+/, '') : content) === hd.delimiter) {
                    heredocTerminators.push({ start: k, end: stop });
                    pending.shift();
                  } else heredocBodies.push({ start: k, end: stop, quoted: hd.quoted });
                  k = stop;
                }
                continue;
              }
              k++;
            }
          })();
          var result = '', quote = null, i = 0;
          while (i < source.length) {
            var hdAt = heredocBodies.find(function (x) { return i >= x.start && i < x.end; });
            var escapedAt = 0;
            for (var esc = i - 1; esc >= 0 && source[esc] === '\\'; esc--) escapedAt++;
            var slashEnd = i;
            while (source[slashEnd] === '\\') slashEnd++;
            if (!hdAt && source[i] === '\\' && (source.slice(slashEnd, slashEnd + 2) === '<(' || source.slice(slashEnd, slashEnd + 2) === '>(') && quote !== "'") {
              var escapedDirection = source[slashEnd], escapedDepth = 1, escapedEnd = slashEnd + 2, escapedQuote = null;
              for (; escapedEnd < source.length; escapedEnd++) {
                var escapedChar = source[escapedEnd];
                if (escapedChar === '\\' && escapedQuote !== "'" && escapedEnd + 1 < source.length) { escapedEnd++; continue; }
                if ((escapedChar === "'" || escapedChar === '"') && (!escapedQuote || escapedQuote === escapedChar)) { escapedQuote = escapedQuote ? null : escapedChar; continue; }
                if (!escapedQuote && escapedChar === '(') escapedDepth++;
                else if (!escapedQuote && escapedChar === ')' && --escapedDepth === 0) break;
              }
              if (escapedDepth === 0) {
                var escapedSlashes = slashEnd - i;
                processSubstitutions.push({ literal: source.slice(slashEnd, escapedEnd + 1), slashes: escapedSlashes });
                result += processMarker(processSubstitutions.length - 1);
                i = escapedEnd + 1;
                continue;
              }
              result += source.slice(i, i + 3); i += 3; continue;
            }
            if ((source.slice(i, i + 2) === '<(' || source.slice(i, i + 2) === '>(') && !quote &&
                !hdAt && escapedAt === 0) {
              var processDirection = source[i];
              var pd = 1, pj = i + 2, pq = null;
              for (; pj < source.length; pj++) {
                var pc = source[pj];
                if (pc === '\\' && pq !== "'" && pj + 1 < source.length) { pj++; continue; }
                if ((pc === "'" || pc === '"') && (!pq || pq === pc)) { pq = pq ? null : pc; continue; }
                if (!pq && pc === '(') pd++;
                else if (!pq && pc === ')' && --pd === 0) break;
              }
              if (pd !== 0) throw new SyntaxError('unterminated process substitution');
              var processBody = source.slice(i + 2, pj);
              processSubstitutions.push({ body: processBody, direction: processDirection });
              result += processMarker(processSubstitutions.length - 1);
              i = pj + 1;
              continue;
            }
            var quotedDelimiter = null;
            for (var qd = 0; qd < quotedDelimiters.length; qd++) {
              if (i >= quotedDelimiters[qd].start && i < quotedDelimiters[qd].end) { quotedDelimiter = quotedDelimiters[qd]; break; }
            }
            if (quotedDelimiter) {
              result += source.slice(i, quotedDelimiter.end); i = quotedDelimiter.end; continue;
            }
            var heredocTerminator = null;
            for (var ht = 0; ht < heredocTerminators.length; ht++) {
              if (i >= heredocTerminators[ht].start && i < heredocTerminators[ht].end) { heredocTerminator = heredocTerminators[ht]; break; }
            }
            if (heredocTerminator) {
              result += source.slice(i, heredocTerminator.end); i = heredocTerminator.end; continue;
            }
            var heredocBody = null;
            for (var hb = 0; hb < heredocBodies.length; hb++) {
              if (i >= heredocBodies[hb].start && i < heredocBodies[hb].end) { heredocBody = heredocBodies[hb]; break; }
            }
            if (heredocBody && heredocBody.quoted) {
              var literalEnd = heredocBody.end;
              result += source.slice(i, literalEnd); i = literalEnd; continue;
            }
            if (!quote && !heredocBody && source[i] === '#' && (i === 0 || /[\s;|&()]/.test(source[i - 1]))) {
              // Comments are copied verbatim (the lexer drops them) so that
              // quotes or `$(` inside them do not affect the rest of the script.
              var commentEnd = source.indexOf('\n', i);
              if (commentEnd < 0) commentEnd = source.length;
              result += source.slice(i, commentEnd); i = commentEnd; continue;
            }
            var start = i, end = -1, body = null, backtick = false;
            var slashCount = 0;
            for (var si = i - 1; si >= 0 && source[si] === '\\'; si--) slashCount++;
            var heredocEscaped = heredocBody && slashCount % 2 === 1;
            if (source[i] === '`' && quote !== "'" && (!heredocBody || !heredocEscaped) && slashCount % 2 === 0) {
              backtick = true;
              var btDepth = 1, bj = i + 1;
              for (; bj < source.length; bj++) {
                if (source[bj] === '`') {
                  var bs = 0; for (var bi = bj - 1; bi > i && source[bi] === '\\'; bi--) bs++;
                  if (bs % 2 === 0) {
                    // A delimiter after a command separator starts a nested
                    // legacy substitution; delimiters following a word close
                    // the current one. Escaped backticks are ordinary text.
                    if (bj > i + 1 && /[\s;|&({]/.test(source[bj - 1])) btDepth++;
                    else btDepth--;
                    if (!btDepth) break;
                  }
                }
                else if (source.slice(bj, bj + 2) === '$(') {
                  var bd = 1; bj += 2;
                  while (bj < source.length && bd) { if (source[bj] === '(') bd++; else if (source[bj] === ')') bd--; bj++; }
                  bj--;
                }
              }
              if (!btDepth) { end = bj; body = source.slice(i + 1, end); }
            } else if (source.slice(i, i + 3) === '$((' && quote !== "'" && !heredocEscaped) {
              var ad = 2, aj = i + 3;
              for (; aj < source.length && ad; aj++) { if (source[aj] === '(') ad++; else if (source[aj] === ')') ad--; }
              if (ad) throw new SyntaxError('unterminated arithmetic expansion');
              // Command substitutions nested in the expression become markers
              // too; they are resolved when the expression is evaluated.
              var arithmeticBody = await substitute(source.slice(i + 3, aj - 2));
              substitutions.push(null);
              substitutions[substitutions.length - 1 + ':arithmetic'] = arithmeticBody;
              result += commandMarker(substitutions.length - 1);
              i = aj; continue;
            } else if (source.slice(i, i + 2) === '$(' && quote !== "'" && !heredocEscaped) {
              var depth = 1, q = null, j = i + 2;
              for (; j < source.length; j++) {
                var ch = source[j];
                if (q === "'") { if (ch === "'") q = null; continue; }
                if (ch === '\\' && q !== "'" && j + 1 < source.length) { j++; continue; }
                if (ch === '"' || ch === "'") { if (!q) q = ch; else if (q === ch) q = null; continue; }
                if (ch === '(' && !q) depth++;
                if (ch === ')' && !q && --depth === 0) break;
              }
              if (depth === 0) { end = j; body = source.slice(i + 2, j); }
            }
            if (body !== null) {
              // Every substitution, including `$(< file)`, runs lazily when its
              // command executes, so it observes earlier commands' effects.
              substitutions.push(null);
              substitutions[substitutions.length - 1 + ':body'] = body;
              result += commandMarker(substitutions.length - 1);
              i = end + 1; continue;
            }
            var c = source[i++];
            if (c === '\\' && quote !== "'" && i < source.length) { result += c + source[i++]; continue; }
            // Quotes inside an unquoted here-document body are literal data.
            if ((c === "'" || c === '"') && !heredocBody) { if (!quote) quote = c; else if (quote === c) quote = null; }
            result += c;
          }
          return result;
        }
          command = await substitute(command);
        async function resolveSubstitutions(text) {
          var source = String(text);
          var re = new RegExp(escapedPrefix + '([CP])(\\d+)\\u0011', 'g'), match, result = '', last = 0;
          while ((match = re.exec(source))) {
            result += source.slice(last, match.index);
            if (match[1] === 'P') {
              var processSpec = processSubstitutions[Number(match[2])];
              if (processSpec.literal !== undefined) {
                var literalText = processSpec.literal;
                result += (processSpec.slashes % 2 === 0 ? '\\'.repeat(processSpec.slashes / 2) : '').concat(literalText);
                last = re.lastIndex;
                continue;
              }
              if (processSpec.direction === '>') {
                var outputPath = '/dev/fd/' + nextProcessFd++;
                processOutputs.set(outputPath, processSpec.body);
                result += outputPath;
                last = re.lastIndex;
                continue;
              }
              var processResult = await childSession({ stdout: function () {} }).exec(processSpec.body, { pipefail: options.pipefail, _lastStatus: status });
              var processPath = '/dev/fd/' + nextProcessFd++;
              processFiles.set(processPath, processResult.stdout);
              result += processPath;
              last = re.lastIndex;
              continue;
            }
            var index = Number(match[2]), output = substitutions[index];
            if (substitutions[index + ':arithmetic'] !== undefined) {
              // Parameters ($1, ${x}) and nested $(...) expand before evaluation.
              var arithmeticSource = substitutions[index + ':arithmetic'];
              try { output = arithmetic(unmarkGlob(String(expand(await resolveSubstitutions(arithmeticSource), { braces: false, tilde: false }))), env); }
              catch (e) {
                if (e instanceof FatalShellError) throw e;
                commandArithmeticFailed = true;
                var arithmeticBody = arithmeticSource;
                stderr('bash: ' + arithmeticBody + ': ' + (['division by 0', 'negative exponent', 'expression recursion level exceeded'].indexOf(e.message) >= 0 ? e.message : 'syntax error') + '\n');
                output = '';
              }
              result += String(output);
              last = re.lastIndex;
              continue;
            }
            if (output === null) {
              var spec = substitutions[index + ':body'];
              if (/^\s*<\s*[^<>]+\s*$/.test(spec)) {
                var readName = spec.replace(/^\s*<\s*/, '').trim();
                try { output = await vfs.readFile(resolvePath(cwd, readName)); substitutionStatus = 0; }
                catch (e) { output = ''; substitutionStatus = 1; stderr('bash: ' + readName + ': ' + errorReason(e) + '\n'); }
              } else {
                var childResult = await childSession({ stdout: function () {} }).exec(spec, { pipefail: options.pipefail, _lastStatus: status });
                output = childResult.stdout;
                substitutionStatus = childResult.exitCode;
              }
              output = String(output).replace(/\n+$/, '');
            }
            // Substituted text is data: it must not be re-scanned for `$`,
            // braces, or tilde by the expansion that follows.
            result += protectLiteral(output || '');
            last = re.lastIndex;
          }
          return result + source.slice(last);
        }
        var registry = commandsMap;
         var input = String(config.stdin == null ? '' : config.stdin);
         function expandDefault(word) { return expand(word, { braces: false, tilde: true }); }
         // ---- variables, positional parameters and arrays ----
         function ifsJoiner() { return env.IFS == null ? ' ' : String(env.IFS).charAt(0); }
         function shellFlags() {
           var o = shell.options;
           return (o.errexit ? 'e' : '') + (o.noglob ? 'f' : '') + 'hB' + (o.nounset ? 'u' : '') + (o.xtrace ? 'x' : '') + (o.noclobber ? 'C' : '');
         }
         function arrayKeys(arr) {
           var keys = Array.from(arr.map.keys());
           return arr.assoc ? keys : keys.sort(function (a, b) { return Number(a) - Number(b); });
         }
         function arrayValues(name) {
           var arr = shell.arrays.get(name);
           if (!arr) return env[name] == null ? [] : [String(env[name])];
           return arrayKeys(arr).map(function (k) { return arr.map.get(k); });
         }
         // Normalises a subscript: arithmetic for indexed arrays (negative counts
         // from the end), the expanded string for associative ones.
         function arrayKey(name, subscript) {
           var arr = shell.arrays.get(name);
           if (arr && arr.assoc) return unmarkGlob(expand(subscript, { braces: false }));
           var n = Number(arithmetic(subscript.trim() === '' ? '0' : subscript, env));
           if (n < 0) {
             var keys = arr ? arrayKeys(arr) : [];
             n = (keys.length ? Number(keys[keys.length - 1]) + 1 : 0) + n;
             if (n < 0) throw new FatalShellError(name + '[' + subscript + ']: bad array subscript', 1);
           }
           return String(n);
         }
         function arrayGet(name, subscript) {
           var arr = shell.arrays.get(name);
           var key = arrayKey(name, subscript);
           if (!arr) return key === '0' && env[name] != null ? String(env[name]) : undefined;
           return arr.map.get(key);
         }
         function ensureArray(name, assoc) {
           var arr = shell.arrays.get(name);
           if (!arr) {
             arr = { assoc: !!assoc, map: new Map() };
             if (env[name] != null && !assoc) arr.map.set('0', String(env[name]));
             delete env[name];
             shell.arrays.set(name, arr);
           }
           return arr;
         }
         function isReadonly(name) {
           if (!shell.readonly.has(name)) return false;
           stderrLine('bash: ' + name + ': readonly variable');
           return true;
         }
         // Assigns a scalar (or array element when subscript is given).
         function assignVar(name, value, subscript, append) {
           if (isReadonly(name)) return false;
           value = String(value);
           if (shell.integers.has(name)) value = arithmetic(append ? (getVar(name) || '0') + '+(' + value + ')' : value, env);
           else if (append) value = (subscript != null ? (arrayGet(name, subscript) || '') : (getVar(name) || '')) + value;
           if (subscript != null) { var arr = ensureArray(name); arr.map.set(arrayKey(name, subscript), value); return true; }
           if (shell.arrays.has(name)) { shell.arrays.get(name).map.set(shell.arrays.get(name).assoc ? '0' : '0', value); return true; }
           env[name] = value;
           return true;
         }
         function unsetVar(name) {
           if (isReadonly(name)) return false;
           shell.arrays.delete(name); delete env[name];
           return true;
         }
         function getVar(name) {
           if (/^\d+$/.test(name)) { var n = Number(name); return n === 0 ? 'bash' : shell.positional[n - 1]; }
           switch (name) {
             case '#': return String(shell.positional.length);
             case '@': case '*': return shell.positional.join(name === '*' ? ifsJoiner() : ' ');
             case '?': return String(status);
             case '$': return '4242';
             case '!': return env['!'];
             case '-': return shellFlags();
             case 'FUNCNAME': return frames.length ? frames[frames.length - 1].name : undefined;
             case 'RANDOM': return String(Math.floor(Math.random() * 32768));
             case 'SECONDS': return String(Math.floor((Date.now() - shell.startTime) / 1000));
           }
           if (shell.arrays.has(name)) return shell.arrays.get(name).map.get('0');
           return env[name] == null ? undefined : String(env[name]);
         }
         function unbound(name) {
           if (shell.options.nounset && name !== '@' && name !== '*') throw new FatalShellError(name + ': unbound variable', 1);
         }
         // Glob pattern (with quote markers) -> RegExp source, unanchored.
         function patternSource(pat) {
           var re = globRegex(pat).source;
           return re.slice(1, -1);
         }
         function caseMatch(pattern, value) {
           return new RegExp('^(?:' + patternSource(pattern) + ')$', shell.shopt.nocasematch ? 'i' : '').test(value);
         }
         function quoteForQ(v) { return "'" + String(v).replace(/'/g, "'\\''") + "'"; }
         // Applies a ${...} operator to one value.
         function applyParamOp(name, val, op, isSet) {
           if (!op) { if (!isSet) unbound(name); return val == null ? '' : val; }
           var c0 = op.charAt(0), c1 = op.charAt(1);
           if (c0 === ':' && '-=?+'.indexOf(c1) >= 0 || '-=?+'.indexOf(c0) >= 0) {
             var colon = c0 === ':', kind = colon ? c1 : c0, word = op.slice(colon ? 2 : 1);
             var missing = colon ? (!isSet || val === '') : !isSet;
             if (kind === '-') return missing ? expandDefault(word) : val;
             if (kind === '+') return missing ? '' : expandDefault(word);
             if (kind === '=') {
               if (!missing) return val;
               var assigned = unmarkGlob(expandDefault(word));
               if (/^\d|^[@*#?$!\-]$/.test(name)) throw new FatalShellError('$' + name + ': cannot assign in this way', 1);
               assignVar(name, assigned);
               return assigned;
             }
             if (missing) throw new FatalShellError(name + ': ' + (unmarkGlob(expandDefault(word)) || (colon ? 'parameter null or not set' : 'parameter not set')), 1);
             return val;
           }
           if (!isSet) unbound(name);
           val = val == null ? '' : val;
           if (c0 === ':') {
             // ${v:offset} / ${v:offset:length} (arithmetic, negative from the end)
             var parts = op.slice(1).split(':'), chars = Array.from(val);
             var start = Number(arithmetic(parts[0].trim() || '0', env));
             if (start < 0) start = Math.max(0, chars.length + start);
             if (parts.length < 2) return chars.slice(start).join('');
             var len = Number(arithmetic(parts[1].trim() || '0', env));
             return chars.slice(start, len < 0 ? chars.length + len : start + len).join('');
           }
           if (c0 === '#' || c0 === '%') {
             var long = c1 === c0, pat = op.slice(long ? 2 : 1);
             if (!pat) return val;
             var re = new RegExp('^(?:' + patternSource(expandDefault(pat)) + ')$');
             if (c0 === '#') {
               for (var i = long ? val.length : 0; long ? i >= 0 : i <= val.length; i += long ? -1 : 1) if (re.test(val.slice(0, i))) return val.slice(i);
             } else {
               for (var j = long ? 0 : val.length; long ? j <= val.length : j >= 0; j += long ? 1 : -1) if (re.test(val.slice(j))) return val.slice(0, j);
             }
             return val;
           }
           if (c0 === '/') {
             // ${v/pat/rep}, ${v//pat/rep}, ${v/#pat/rep}, ${v/%pat/rep}
             var mode = c1 === '/' || c1 === '#' || c1 === '%' ? c1 : '', rest = op.slice(mode ? 2 : 1), k = 0, patText = '';
             while (k < rest.length && rest[k] !== '/') { if (rest[k] === '\\' && k + 1 < rest.length) { patText += rest[k] + rest[k + 1]; k += 2; continue; } patText += rest[k++]; }
             var repl = k < rest.length ? unmarkGlob(expandDefault(rest.slice(k + 1))) : '';
             if (!patText) return val;
             var src = patternSource(expandDefault(patText.replace(/\\(.)/g, function (_, ch) { return markQuoted(ch); })));
             var rx = new RegExp(mode === '#' ? '^(?:' + src + ')' : mode === '%' ? '(?:' + src + ')$' : src, mode === '/' ? 'g' : '');
             return val.replace(rx, function () { return repl; });
           }
           if (c0 === '^' || c0 === ',') {
             var all = c1 === c0, upper = c0 === '^';
             if (all) return upper ? val.toUpperCase() : val.toLowerCase();
             return (upper ? val.charAt(0).toUpperCase() : val.charAt(0).toLowerCase()) + val.slice(1);
           }
           if (c0 === '@') {
             switch (op.slice(1)) {
               case 'Q': return quoteForQ(val);
               case 'U': return val.toUpperCase();
               case 'L': return val.toLowerCase();
               case 'u': return val.charAt(0).toUpperCase() + val.slice(1);
               case 'E': return decodeEscapes(val, 'b').text;
             }
           }
           throw new FatalShellError('${' + name + op + '}: bad substitution', 1);
         }
         // Values of a multi-word parameter ($@, $*, ${a[@]}, ${a[*]}), or null.
         function multiValues(name, subscript) {
           if ((name === '@' || name === '*') && subscript == null) return shell.positional.slice();
           if (subscript === '@' || subscript === '*') return arrayValues(name);
           return null;
         }
         function expandParam(expr) {
           var original = expr;
           if (expr === '#') return String(shell.positional.length);
           var lengthOf = false, indirect = false;
           if (expr.length > 1 && expr.charAt(0) === '#') { lengthOf = true; expr = expr.slice(1); }
           else if (expr.length > 1 && expr.charAt(0) === '!') { indirect = true; expr = expr.slice(1); }
           var m = expr.match(/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!\-])(?:\[((?:[^\]]|\][^\]]*\[)*?)\])?([\s\S]*)$/);
           if (!m) throw new FatalShellError('${' + original + '}: bad substitution', 1);
           var name = m[1], subscript = m[2], op = m[3];
           if (indirect) {
             if ((op === '*' || op === '@') && subscript == null) {
               return Object.keys(env).concat(Array.from(shell.arrays.keys())).filter(function (n) { return n.indexOf(name) === 0 && /^[A-Za-z_]/.test(n); }).sort().join(op === '*' ? ifsJoiner() : ' ');
             }
             if (subscript === '@' || subscript === '*') {
               var arr = shell.arrays.get(name);
               return (arr ? arrayKeys(arr) : (env[name] != null ? ['0'] : [])).join(subscript === '*' ? ifsJoiner() : ' ');
             }
             var target = subscript != null ? arrayGet(name, subscript) : getVar(name);
             if (target == null || target === '') { unbound(name); return ''; }
             return expandParam(target + op);
           }
           var values = multiValues(name, subscript);
           if (values) {
             if (lengthOf) return String(values.length);
             if (op && op.charAt(0) === ':' && '-=?+'.indexOf(op.charAt(1)) < 0) {
               // ${@:start:len} slices the list; $@ slicing counts from $0.
               var bounds = op.slice(1).split(':'), from = Number(arithmetic(bounds[0].trim() || '0', env));
               var list = (name === '@' || name === '*') && subscript == null ? ['bash'].concat(values) : values;
               if (from < 0) from = Math.max(0, list.length + from);
               values = list.slice(from, bounds.length > 1 ? from + Number(arithmetic(bounds[1].trim() || '0', env)) : undefined);
               return values.join(subscript === '*' || name === '*' ? ifsJoiner() : ' ');
             }
             if (op && /^:?[-=?+]/.test(op)) return applyParamOp(name, values.length ? values.join(' ') : undefined, op, values.length > 0);
             return values.map(function (v) { return applyParamOp(name, v, op, true); }).join(subscript === '*' || name === '*' ? ifsJoiner() : ' ');
           }
           var val = subscript != null ? arrayGet(name, subscript) : getVar(name);
           if (lengthOf) { if (val == null) unbound(name); return String(Array.from(val || '').length); }
           return applyParamOp(name, val, op, val != null);
         }
         // Replaces $name, $1, $@, ${...} (with nested braces) in a string.
         function expandParams(part) {
           var out = '', i = 0;
           while (i < part.length) {
             var c = part[i];
             if (c !== '$') { out += c; i++; continue; }
             if (part[i + 1] === '{') {
               var depth = 0, j = i + 1;
               for (; j < part.length; j++) {
                 if (part[j] === '{') depth++;
                 else if (part[j] === '}' && --depth === 0) break;
               }
               if (j >= part.length) { out += part.slice(i); break; }
               out += expandParam(part.slice(i + 2, j));
               i = j + 1; continue;
             }
             var sm = part.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[?!#@*$\-])/);
             if (sm) {
               var v = getVar(sm[1]);
               if (v == null) unbound(sm[1]);
               out += v == null ? '' : v;
               i += 1 + sm[1].length; continue;
             }
             out += c; i++;
           }
           return out;
         }
          // Brace, tilde and parameter expansion plus quote-marker removal.
          // opts.braces=false / opts.tilde=false disable those stages (used for
          // assignments, here-documents, and non-initial word segments).
          // Glob markers are deliberately kept; see unmarkGlob/globField.
          function expand(s, opts) {
            opts = opts || {};
            s = String(s).replace(/\u0001|\u0002/g, '\u0004');
            var alternatives = opts.braces === false ? [s] : braceExpand(s);
            var expanded = alternatives.map(function (part) {
              if (opts.tilde !== false) part = part.replace(/^~([+-]?)/, function (t, which, offset, whole) {
                if (!which && whole.charAt(1) && whole.charAt(1) !== '/') return t;
                return which === '+' ? (env.PWD || env.cwd || cwd) : which === '-' ? (env.OLDPWD || '') : (env.HOME || '');
              });
              return expandParams(part).replace(new RegExp(escapedPrefix + 'C(\\d+)\\u0011', 'g'), function (_, n) { return substitutions[Number(n)] || ''; })
                .replace(/\u0004/g, '$').replace(/\u0018/g, '`').replace(/\u0005/g, '~').replace(/\u0006/g, '{').replace(/\u0007/g, '}');
            });
            return expanded.length === 1 ? expanded[0] : expanded;
          }
          // Pathname expansion of one field. Quoted glob characters are
          // markers here, so they only ever match themselves.
          async function globField(text) {
            if (shell.options.noglob) return [String(text)];
            var matches = await expandGlob(String(text), vfs, cwd, { dotglob: shell.shopt.dotglob, nocase: shell.shopt.nocaseglob });
            if (matches && !matches.length && shell.shopt.nullglob) return [];
            return matches && matches.length ? matches : [String(text)];
          }
        var status = options._lastStatus || 0;
        var substitutionStatus = 0;
        function childSession(overrides) {
          return createSession(Object.assign({}, config, { cwd: cwd, env: env, stderr: function (t) { stderr(t); }, _vfs: vfs, _shell: shell, _markers: markers }, overrides || {}));
        }
        // ---- interpreter ----------------------------------------------------
        // Every node runs with an `io` context:
        //   stdin: InputStream shared by the commands reading fd 0 (so `read`
        //          in a loop consumes successive lines); piped: fd 0 overrides
        //          persistent `exec` fds; out / err: sinks for fd 1 / fd 2 (null
        //          means the shell's own); fds: Map of other descriptors.
        var loopDepth = 0, callDepth = 0, sourceDepth = 0, errexitSuppressed = 0, iterations = 0, frames = [];
        var maxIterations = config.maxLoopIterations || 1000000, maxCallDepth = config.maxCallDepth || 1000;
        var KEYWORDS = ['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'time', '{', '}', '!', '[[', ']]'];
        var SESSION_BUILTINS = ['set', 'shift', 'local', 'declare', 'typeset', 'readonly', 'return', 'break', 'continue', 'eval', 'source', '.', 'let', 'unset', 'type', 'command', 'builtin', 'trap', 'wait', 'getopts', 'hash', 'shopt', 'exec'];
        function stderrLine(text) { stderr(text + '\n'); }
        function guardIteration() {
          if (++iterations > maxIterations) throw new FatalShellError('loop iteration limit (' + maxIterations + ') exceeded', 1);
        }
        function pipefailOn() { return !!(options.pipefail || shell.options.pipefail); }

        // ---- word expansion ----
        function hasExpansion(text) { return /\$|`/.test(text) || text.indexOf(markerPrefix) >= 0; }
        // Quoted forms that expand to one field per element: "$@", "${@...}",
        // "${a[@]...}" and "${!a[@]}".
        var MULTI_PARAM = /\$@|\$\{(!?)(@|[A-Za-z_][A-Za-z0-9_]*\[@\])([^}]*)\}/;
        function multiFieldList(match) {
          if (match[0] === '$@') return shell.positional.slice();
          var indirect = match[1] === '!', ref = match[2], op = match[3] || '';
          var name = ref === '@' ? '@' : ref.slice(0, -3);
          if (indirect) {
            var keyed = shell.arrays.get(name);
            return keyed ? arrayKeys(keyed) : (env[name] != null ? ['0'] : []);
          }
          var values = multiValues(name, ref === '@' ? null : '@');
          if (!op) return values;
          if (op.charAt(0) === ':' && '-=?+'.indexOf(op.charAt(1)) < 0) {
            var bounds = op.slice(1).split(':'), from = Number(arithmetic(bounds[0].trim() || '0', env));
            var list = name === '@' ? ['bash'].concat(values) : values;
            if (from < 0) from = Math.max(0, list.length + from);
            return list.slice(from, bounds.length > 1 ? from + Number(arithmetic(bounds[1].trim() || '0', env)) : undefined);
          }
          if (/^:?[-=?+]/.test(op)) return values.length ? (op.replace(/^:/, '').charAt(0) === '+' ? [unmarkGlob(expandDefault(op.replace(/^:?\+/, '')))] : values) : (/^:?[-=]/.test(op) ? [unmarkGlob(expandDefault(op.replace(/^:?[-=]/, '')))] : []);
          return values.map(function (v) { return applyParamOp(name, v, op, true); });
        }
        // Expands one word into fields (glob markers kept, see unmarkGlob).
        async function expandWordFields(word) {
          var activeIfs = env.IFS == null ? ' \t\n' : String(env.IFS);
          if (!hasExpansion(word.text)) {
            var plain = expand(word.text), plainList = Array.isArray(plain) ? plain : [plain], plainFields = [];
            for (var pl = 0; pl < plainList.length; pl++) plainFields.push.apply(plainFields, await globField(plainList[pl]));
            return plainFields;
          }
          var segments = word.segments && word.segments.length ? word.segments : [{ value: word.text, quoted: false }];
          // Brace expansion applies to the whole word, before any other
          // expansion; segment boundaries ride along as sentinels.
          var joined = segments.map(function (s) { return (s.quoted ? '\u0012' : '\u0013') + s.value; }).join('');
          var alternatives = braceExpand(joined), wordFields = [];
          for (var ai = 0; ai < alternatives.length; ai++) {
            var segs = [];
            alternatives[ai].replace(/([\u0012\u0013])([^\u0012\u0013]*)/g, function (all, kind, value) { segs.push({ quoted: kind === '\u0012', value: value }); return all; });
            var fields = [''], present = false, previousQuoted = false, anyQuoted = false, dropped = false;
            for (var si = 0; si < segs.length; si++) {
              var segment = segs[si];
              var multi = segment.quoted ? MULTI_PARAM.exec(segment.value) : null;
              if (multi) {
                // "$@" and "${a[@]}" expand to one field per element.
                var list = multiFieldList(multi);
                var pre = String(expand(await resolveSubstitutions(segment.value.slice(0, multi.index)), { braces: false, tilde: false }));
                var post = String(expand(await resolveSubstitutions(segment.value.slice(multi.index + multi[0].length)), { braces: false, tilde: false }));
                anyQuoted = true; previousQuoted = true;
                if (!list.length) {
                  if (pre || post || segs.length > 1) { fields[fields.length - 1] += markGlob(pre + post); present = true; }
                  else dropped = true;
                  continue;
                }
                present = true;
                list.forEach(function (item, k) {
                  var text = (k === 0 ? pre : '') + item + (k === list.length - 1 ? post : '');
                  if (k === 0) fields[fields.length - 1] += markGlob(text); else fields.push(markGlob(text));
                });
                continue;
              }
              var expanded = String(expand(await resolveSubstitutions(segment.value), { braces: false, tilde: si === 0 && !segment.quoted }));
              if (segment.quoted) {
                fields[fields.length - 1] += markGlob(expanded);
                present = true; previousQuoted = true; anyQuoted = true;
              } else {
                var pieces = splitFields(expanded, activeIfs);
                if (!pieces.length) continue;
                if (previousQuoted && fields[fields.length - 1] !== '' && expanded !== '' &&
                    Array.from(expanded).some(function (ch) { return activeIfs.indexOf(ch) >= 0; })) fields.push('');
                fields[fields.length - 1] += pieces[0];
                for (var pi = 1; pi < pieces.length; pi++) fields.push(pieces[pi]);
                present = true; previousQuoted = false;
              }
            }
            if (dropped && !present) continue;
            if (!present && !anyQuoted) continue;
            for (var fi = 0; fi < fields.length; fi++) wordFields.push.apply(wordFields, await globField(fields[fi]));
          }
          return wordFields;
        }
        async function expandWords(words) {
          var out = [];
          for (var i = 0; i < words.length; i++) out.push.apply(out, await expandWordFields(words[i]));
          return out.map(unmarkGlob);
        }
        // A word expanded to a single string without splitting or globbing;
        // quoted glob characters stay marked (for patterns).
        async function expandMarked(word) {
          var segments = word.segments && word.segments.length ? word.segments : [{ value: word.text, quoted: !!word.quoted }];
          var out = '';
          for (var i = 0; i < segments.length; i++) {
            var text = String(expand(await resolveSubstitutions(segments[i].value), { braces: false, tilde: i === 0 && !segments[i].quoted }));
            out += segments[i].quoted ? markGlob(text) : text;
          }
          return out;
        }
        async function expandValue(word) { return unmarkGlob(await expandMarked(word)); }
        async function evalArith(expr) {
          return arithmetic(String(expand(await resolveSubstitutions(expr), { braces: false, tilde: false })).replace(/\u0004/g, '$'), env);
        }
        function arithError(e, expr) {
          var reason = ['division by 0', 'negative exponent', 'expression recursion level exceeded'].indexOf(e.message) >= 0 ? e.message : 'syntax error in expression';
          stderrLine('bash: ' + String(expr).trim() + ': ' + reason);
        }

        // ---- state isolation for subshells, pipeline stages and `&` ----
        function snapshot() {
          var arrays = new Map();
          shell.arrays.forEach(function (arr, name) { arrays.set(name, { assoc: arr.assoc, map: new Map(arr.map) }); });
          return { env: env, cwd: cwd, arrays: shell.arrays, functions: shell.functions, positional: shell.positional, options: shell.options,
            shopt: shell.shopt, readonly: shell.readonly, integers: shell.integers, persistentFds: persistentFds,
            copy: { env: Object.assign({}, env), arrays: arrays, functions: new Map(shell.functions), positional: shell.positional.slice(),
              options: Object.assign({}, shell.options), shopt: Object.assign({}, shell.shopt), readonly: new Set(shell.readonly), integers: new Set(shell.integers), persistentFds: new Map(persistentFds) } };
        }
        async function runIsolated(fn) {
          var saved = snapshot();
          env = saved.copy.env; shell.arrays = saved.copy.arrays; shell.functions = saved.copy.functions; shell.positional = saved.copy.positional;
          shell.options = saved.copy.options; shell.shopt = saved.copy.shopt; shell.readonly = saved.copy.readonly; shell.integers = saved.copy.integers; persistentFds = saved.copy.persistentFds;
          var savedLoop = loopDepth, savedErrexit = errexitSuppressed;
          try { return await fn(); }
          catch (e) {
            if (e instanceof ExitSignal) return e.code;
            if (e instanceof FatalShellError) { stderrLine('bash: ' + e.message); return e.code; }
            if (e instanceof LoopSignal) return 0;
            if (e instanceof ReturnSignal) return e.code;
            throw e;
          } finally {
            env = saved.env; cwd = saved.cwd; shell.arrays = saved.arrays; shell.functions = saved.functions; shell.positional = saved.positional;
            shell.options = saved.options; shell.shopt = saved.shopt; shell.readonly = saved.readonly; shell.integers = saved.integers; persistentFds = saved.persistentFds;
            loopDepth = savedLoop; errexitSuppressed = savedErrexit;
          }
        }

        // ---- redirections ----
        function displayWord(text) {
          return unmarkGlob(String(text)).replace(/\u0001/g, '$').replace(/\u0005/g, '~').replace(/\u0006/g, '{').replace(/\u0007/g, '}');
        }
        // Builds the fd table for a command: shell defaults, persistent `exec`
        // fds, the io context, then the command's own redirections (left to
        // right). Returns { table, opened, touched } or throws a ShellError
        // whose `display` names the failing target.
        async function prepareFds(redirectNodes, io) {
          var activeIfs = env.IFS == null ? ' \t\n' : String(env.IFS);
          var redirects = [];
          for (var sri = 0; sri < redirectNodes.length; sri++) {
            var redirectCopy = Object.assign({}, redirectNodes[sri]);
            if (redirectCopy.body && !redirectCopy.quoted) redirectCopy.body = await resolveSubstitutions(quoteHereDocEscapes(redirectCopy.body));
            if (redirectCopy.op !== '<<' && redirectCopy.op !== '<<-') redirectCopy.target = await resolveSubstitutions(redirectCopy.target);
            redirectCopy.rawTarget = redirectNodes[sri].target;
            redirects.push(redirectCopy);
          }
          var table = new FdTable([[0, { input: io.stdin }], [1, { output: { write: stdout } }], [2, { output: { write: stderr } }]]);
          var opened = [], touched = new Set();
          persistentFds.forEach(function (entry, fd) {
            if (entry === null) { table.close(fd); return; }
            var local = {};
            Object.keys(entry).forEach(function (key) { local[key] = entry[key]; });
            table.set(fd, local);
            if (entry._flush) opened.push(entry._flush);
          });
          if (io.piped) table.set(0, { input: io.stdin });
          if (io.out) table.set(1, { output: { write: function (s) { io.out.write(s); } } });
          if (io.err) table.set(2, { output: { write: function (s) { io.err.write(s); } } });
          if (io.fds) io.fds.forEach(function (entry, fd) { if (entry === null) table.close(fd); else table.set(fd, entry); });
          function ambiguous(red) { var e = new ShellError('ambiguous redirect', 'AMBIGUOUS'); e.display = displayWord(red.rawTarget); throw e; }
          // A file redirection target must expand to exactly one word.
          async function redirectTarget(red) {
            var words = expand(red.target);
            if (Array.isArray(words)) ambiguous(red);
            var raw = String(red.rawTarget);
            if (!red.quoted && (/\$|`/.test(raw) || raw.indexOf(markerPrefix) >= 0)) {
              var split = splitFields(words, activeIfs);
              if (split.length !== 1) ambiguous(red);
              words = split[0];
            }
            var globbed = await globField(words);
            if (globbed.length !== 1) ambiguous(red);
            return unmarkGlob(globbed[0]);
          }
          async function fileWriter(path, append) {
            var data = '', first = true; if (!append) await vfs.writeFile(path, '');
            var writer = function (s) { data += String(s); };
            writer.flush = async function () { if (data) { await vfs.writeFile(path, data, { append: append || !first }); data = ''; first = false; } };
            opened.push(writer); return writer;
          }
          function badFd() { throw new ShellError('Bad file descriptor', 'EBADF'); }
          var currentTarget = '', noclobber = shell.options.noclobber;
          try {
            for (var ri = 0; ri < redirects.length; ri++) {
              var red = redirects[ri], f = red.fd == null ? (red.op.charAt(0) === '<' ? 0 : 1) : red.fd, target;
              currentTarget = displayWord(red.rawTarget);
              if (red.op === '<<' || red.op === '<<-') target = red.target;
              else if (red.op === '<<<') target = unmarkGlob(expand(red.target, { braces: false }));
              else target = await redirectTarget(red);
              currentTarget = target;
              touched.add(f);
              if (red.op.charAt(0) === '&' || (red.op === '>&' && !/^(?:\d+-?|-)$/.test(target))) { touched.add(1); touched.add(2); }
              if (/^\d+-$/.test(target)) touched.add(Number(target.slice(0, -1)));
              if (f < 0 || f > 9) throw new ShellError('Bad file descriptor', 'EBADF');
              if (red.op === '>&' || red.op === '<&') {
                var cap = red.op === '<&' ? 'input' : 'output';
                if (target === '-') { table.close(f); continue; }
                if (/^\d+-?$/.test(target)) {
                  var moving = target.charAt(target.length - 1) === '-', source = Number(moving ? target.slice(0, -1) : target);
                  if (source > 9) throw new ShellError('Bad file descriptor', 'EBADF');
                  var sourceEntry = table.get(source);
                  if (!sourceEntry || sourceEntry.closed || (moving && !sourceEntry[cap])) badFd();
                  var destination = {}; destination[cap] = sourceEntry[cap]; destination.closed = false; table.set(f, destination);
                  if (moving) table.close(source);
                } else {
                  if (red.op === '<&' || red.fd != null) ambiguous(red);
                  var dupPath = resolvePath(cwd, target);
                  if (noclobber && !isDevicePath(dupPath) && await vfs.isFile(dupPath)) throw new ShellError('cannot overwrite existing file', 'EEXIST');
                  var dupWriter = await fileWriter(dupPath, false);
                  [1, 2].forEach(function (fd) { var e = table.get(fd) || {}; e.output = { write: dupWriter }; e.closed = false; table.set(fd, e); });
                }
              } else if (red.op === '<<<' || red.op === '<<' || red.op === '<<-') {
                // Here-document bodies get parameter/command/arithmetic
                // expansion only: no brace or tilde expansion.
                var body = red.op === '<<<' ? target + '\n' : (red.quoted ? (red.body || '') : unmarkGlob(expand(red.body || '', { braces: false, tilde: false })));
                table.set(0, { input: new InputStream(body), closed: false });
              } else if (red.op === '<' || red.op === '<>') {
                var rp = resolvePath(cwd, target), ie = {};
                if (rp === '/dev/stdin' || rp === '/dev/stdout' || rp === '/dev/stderr') {
                  var standard = table.get(rp === '/dev/stdin' ? 0 : rp === '/dev/stdout' ? 1 : 2);
                  if (!standard || !standard.input) badFd();
                  ie.input = standard.input;
                } else if (processFiles.has(rp)) {
                  ie.input = new InputStream(processFiles.get(rp));
                } else if (/^\/dev\/fd\/\d+$/.test(rp)) {
                  var readAlias = table.get(Number(rp.slice(8)));
                  if (!readAlias || !readAlias.input) badFd();
                  ie.input = readAlias.input;
                } else {
                  if (rp !== '/dev/null' && red.op === '<>' && !(await vfs.exists(rp))) await vfs.writeFile(rp, '');
                  ie.input = new InputStream(rp === '/dev/null' ? '' : await vfs.readFile(rp));
                }
                ie.closed = false;
                if (red.op === '<>') {
                  var rw = rp === '/dev/null' ? { write: function () {} } : await fileWriter(rp, true);
                  ie.output = typeof rw === 'function' ? { write: rw } : rw;
                }
                table.set(f, ie);
              } else if (red.op === '>&' && target && !/^(?:\d+-?|-)$/.test(target)) {
                var toFile = resolvePath(cwd, target);
                if (noclobber && !isDevicePath(toFile) && await vfs.isFile(toFile)) throw new ShellError('cannot overwrite existing file', 'EEXIST');
                var fileOutput = await fileWriter(toFile, false);
                [1, 2].forEach(function (fd) { var entry = table.get(fd) || {}; entry.output = { write: fileOutput }; entry.closed = false; table.set(fd, entry); });
              } else {
                var wp = resolvePath(cwd, target), append = red.op === '>>' || red.op === '&>>';
                if ((red.op === '>' || red.op === '&>') && noclobber && !isDevicePath(wp) && await vfs.isFile(wp)) throw new ShellError('cannot overwrite existing file', 'EEXIST');
                var fw;
                if (wp === '/dev/stdin' || wp === '/dev/stdout' || wp === '/dev/stderr') {
                  var alias = table.get(wp === '/dev/stdin' ? 0 : wp === '/dev/stdout' ? 1 : 2);
                  if (!alias || !alias.output) badFd();
                  fw = alias.output;
                } else if (processOutputs.has(wp)) {
                  let outputBody = processOutputs.get(wp), outputData = '';
                  // A process-substitution child inherits the shell's current
                  // stdout, not the descriptor being redirected
                  // (`> >(sink1) 2> >(sink2)`: sink2's stdout is sink1).
                  let ownerOutput = (table.get(1) || {}).output;
                  fw = function (s) { outputData += String(s); };
                  fw.flush = async function () {
                    await childSession({ stdin: outputData,
                      stdout: function (s) { if (ownerOutput) ownerOutput.write(s); else stdout(s); } }).exec(outputBody, { pipefail: pipefailOn() });
                    outputData = '';
                    processOutputs.delete(wp);
                  };
                  opened.push(fw);
                } else if (/^\/dev\/fd\/\d+$/.test(wp)) {
                  var fdAlias = table.get(Number(wp.slice(8)));
                  if (!fdAlias || !fdAlias.output) badFd();
                  fw = fdAlias.output;
                } else fw = wp === '/dev/null' ? { write: function () {} } : await fileWriter(wp, append);
                (red.op.indexOf('&') === 0 ? [1, 2] : [f]).forEach(function (fd) { var oe = table.get(fd) || {}; oe.output = typeof fw === 'function' ? { write: fw } : fw; oe.closed = false; table.set(fd, oe); });
              }
            }
          } catch (re) {
            if (re && re.display == null) re.display = currentTarget;
            throw re;
          }
          return { table: table, opened: opened, touched: touched };
        }
        function redirectFailed(re) {
          stderrLine('bash: ' + (re.display ? re.display + ': ' : '') + errorReason(re));
          return 1;
        }
        async function flushAll(opened) { for (var i = 0; i < opened.length; i++) await opened[i].flush(); }
        var CLOSED_SINK = { write: function () { throw new ShellError('Bad file descriptor', 'EBADF'); } };
        // The io context seen by commands inside a redirected compound
        // command, function body, or eval/source text.
        function ioFromTable(table, io, onlyTouched) {
          var next = { stdin: io.stdin, piped: io.piped, out: io.out, err: io.err, fds: new Map(io.fds || []) };
          for (var fd = 0; fd <= 9; fd++) {
            if (onlyTouched && !onlyTouched.has(fd)) continue;
            var e = table.get(fd);
            if (fd === 0) { if (e && e.input) { next.stdin = e.input; next.piped = true; } else if (!e) next.fds.set(0, null); }
            else if (fd === 1 || fd === 2) {
              var sink = e && e.output ? (function (o) { return { write: function (s) { o.write(s); } }; })(e.output) : CLOSED_SINK;
              if (fd === 1) next.out = sink; else next.err = sink;
            } else if (e) next.fds.set(fd, e);
            else next.fds.set(fd, null);
          }
          return next;
        }
        async function runWithRedirects(node, io, fn) {
          if (!node.redirects || !node.redirects.length) return fn(io);
          var prepared;
          try { prepared = await prepareFds(node.redirects, io); }
          catch (re) { if (re instanceof ShellError || (re && re.code)) return redirectFailed(re); throw re; }
          try { return await fn(ioFromTable(prepared.table, io, prepared.touched)); }
          finally { await flushAll(prepared.opened); }
        }

        // ---- execution ----
        var ERREXIT_NODES = { SimpleCommand: 1, Pipeline: 1, Subshell: 1, Cond: 1, Arith: 1 };
        async function runChecked(node, io, suppress) {
          if (suppress) errexitSuppressed++;
          var st;
          try { st = await run(node, io); }
          finally { if (suppress) errexitSuppressed--; }
          status = st;
          if (!suppress && st !== 0 && shell.options.errexit && errexitSuppressed === 0 && ERREXIT_NODES[node.type] && !(node.type === 'Pipeline' && node.negated)) throw new ExitSignal(st);
          return st;
        }
        async function runList(list, io) {
          var last = 0;
          for (var j = 0; j < list.items.length; j++) {
            var item = list.items[j];
            if (item.sep === '&') {
              // Background jobs run to completion here, in their own subshell.
              await runIsolated(function () { return run(item.node, io); });
              env['!'] = String(4243 + j); last = status = 0;
              continue;
            }
            last = await runChecked(item.node, io, false);
          }
          return last;
        }
        async function runCond(list, io) {
          errexitSuppressed++;
          try { return await runList(list, io); }
          finally { errexitSuppressed--; }
        }
        async function loopBody(list, io) {
          try { return { status: await runList(list, io) }; }
          catch (e) {
            if (!(e instanceof LoopSignal)) throw e;
            if (e.levels > 1) { e.levels--; throw e; }
            return { status: status, signal: e.kind };
          }
        }
        async function run(node, io) {
          switch (node.type) {
            case 'Script': return runList(node.body, io);
            case 'List': return runList(node, io);
            case 'AndOr': {
              var left = await runChecked(node.left, io, true);
              if ((node.op === '&&') === (left === 0)) return runChecked(node.right, io, false);
              return left;
            }
            case 'Pipeline': return runPipeline(node, io);
            case 'SimpleCommand': return runSimple(node, io);
            case 'FunctionDef': shell.functions.set(node.name, node.body); return 0;
          }
          return runWithRedirects(node, io, function (b) { return runCompound(node, b); });
        }
        async function runPipeline(node, io) {
          var last = node.commands.length - 1, codes = [], data = '';
          if (last === 0) {
            var single = await run(node.commands[0], io);
            return node.negated ? (single === 0 ? 1 : 0) : single;
          }
          for (var k = 0; k <= last; k++) {
            // Inner stages write into a pipe buffer; the last stage writes to
            // whatever the pipeline itself is connected to. Every stage runs in
            // a subshell, so its variable and directory changes are discarded.
            var stageOut = k < last ? new BufferSink() : io.out;
            var stageIo = { stdin: k === 0 ? io.stdin : new InputStream(data), piped: k > 0 ? true : io.piped, out: stageOut,
              err: k < last && node.pipeStderr && node.pipeStderr[k] ? stageOut : io.err, fds: io.fds };
            var stage = node.commands[k];
            codes.push(await runIsolated(function () { return run(stage, stageIo); }));
            if (k < last) data = stageOut.toString();
          }
          shell.pipestatus = codes;
          var code = pipefailOn() ? (codes.slice().reverse().find(function (n) { return n !== 0; }) || 0) : codes[codes.length - 1];
          return node.negated ? (code === 0 ? 1 : 0) : code;
        }
        async function runCompound(node, io) {
          switch (node.type) {
            case 'Group': return runList(node.body, io);
            case 'Subshell': return runIsolated(function () { return runList(node.body, io); });
            case 'If': {
              for (var c = 0; c < node.clauses.length; c++) {
                if (await runCond(node.clauses[c].cond, io) === 0) return runList(node.clauses[c].body, io);
              }
              return node.elseBody ? runList(node.elseBody, io) : 0;
            }
            case 'While': {
              var whileStatus = 0;
              loopDepth++;
              try {
                while (true) {
                  guardIteration();
                  if ((await runCond(node.cond, io) === 0) === node.until) break;
                  var r = await loopBody(node.body, io);
                  whileStatus = r.status;
                  if (r.signal === 'break') break;
                }
              } finally { loopDepth--; }
              return whileStatus;
            }
            case 'For': {
              var items = node.items ? await expandWords(node.items) : shell.positional.slice(), forStatus = 0;
              loopDepth++;
              try {
                for (var i = 0; i < items.length; i++) {
                  guardIteration();
                  if (!assignVar(node.name, items[i])) return 1;
                  var fr = await loopBody(node.body, io);
                  forStatus = fr.status;
                  if (fr.signal === 'break') break;
                }
              } finally { loopDepth--; }
              return forStatus;
            }
            case 'ArithFor': {
              var arithStatus = 0;
              loopDepth++;
              try {
                if (node.init.trim()) await evalArith(node.init);
                while (true) {
                  guardIteration();
                  if (node.cond.trim() && Number(await evalArith(node.cond)) === 0) break;
                  var ar = await loopBody(node.body, io);
                  arithStatus = ar.status;
                  if (ar.signal === 'break') break;
                  if (node.step.trim()) await evalArith(node.step);
                }
              } catch (e) {
                if (e instanceof SyntaxError || (e && /division by 0|negative exponent|recursion/.test(e.message))) { arithError(e, node.cond); return 1; }
                throw e;
              } finally { loopDepth--; }
              return arithStatus;
            }
            case 'Case': {
              var subject = await expandValue(node.word), caseStatus = 0, fallthrough = false;
              for (var ci = 0; ci < node.items.length; ci++) {
                var item = node.items[ci], hit = fallthrough;
                for (var pi = 0; !hit && pi < item.patterns.length; pi++) hit = caseMatch(await expandMarked(item.patterns[pi]), subject);
                if (!hit) continue;
                caseStatus = await runList(item.body, io);
                if (item.terminator === ';;') return caseStatus;
                fallthrough = item.terminator === ';&';
              }
              return caseStatus;
            }
            case 'Cond': {
              try { return (await evalCond(node.expr)) ? 0 : 1; }
              catch (e) { if (e instanceof CondError) { stderrLine('bash: ' + e.message); return 2; } throw e; }
            }
            case 'Arith': {
              if (shell.options.xtrace) stderrLine('+ ((' + node.expr + '))');
              try { return Number(await evalArith(node.expr)) !== 0 ? 0 : 1; }
              catch (e) { if (e instanceof SyntaxError || (e && /division by 0|negative exponent|recursion/.test(e.message))) { arithError(e, node.expr); return 1; } throw e; }
            }
          }
          return 2;
        }

        // [[ expression ]]
        function CondError(message) { this.message = message; }
        async function condFile(word) { var name = await expandValue(word); return { name: name, st: name === '' ? null : await vfs.stat(resolvePath(cwd, name)) }; }
        async function evalCond(e) {
          switch (e.type) {
            case 'and': return (await evalCond(e.left)) && evalCond(e.right);
            case 'or': return (await evalCond(e.left)) || evalCond(e.right);
            case 'not': return !(await evalCond(e.expr));
            case 'word': return (await expandValue(e.word)) !== '';
            case 'unary': {
              var op = e.op;
              if (op === '-z') return (await expandValue(e.operand)) === '';
              if (op === '-n') return (await expandValue(e.operand)) !== '';
              if (op === '-v') {
                var vn = await expandValue(e.operand), vm = vn.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/);
                if (!vm) return false;
                if (vm[2] != null) { var arr = shell.arrays.get(vm[1]); return !!arr && (vm[2] === '@' || vm[2] === '*' ? arr.map.size > 0 : arr.map.has(arrayKey(vm[1], vm[2]))); }
                return getVar(vm[1]) != null;
              }
              if (op === '-o') { var on = await expandValue(e.operand); return !!shell.options[on]; }
              if (op === '-t') return false;
              var f = await condFile(e.operand), st = f.st;
              switch (op) {
                case '-e': case '-a': return !!st;
                case '-f': return !!st && st.type === 'file';
                case '-d': return !!st && st.type === 'dir';
                case '-s': return !!st && st.size > 0;
                case '-r': case '-w': return !!st;
                case '-x': return !!st && (st.type === 'dir' || (st.mode != null && (st.mode & 73) !== 0));
              }
              return false;
            }
            case 'binary': {
              var left = await expandValue(e.left);
              if (e.op === '==' || e.op === '=' || e.op === '!=') {
                var matched = caseMatch(await expandMarked(e.right), left);
                return e.op === '!=' ? !matched : matched;
              }
              if (e.op === '=~') {
                var source = '';
                if (e.right.raw) source = await regexFromRaw(e.right.text);
                else {
                  var segs = e.right.segments && e.right.segments.length ? e.right.segments : [{ value: e.right.text, quoted: e.right.quoted }];
                  for (var s = 0; s < segs.length; s++) {
                    var piece = unmarkGlob(String(expand(await resolveSubstitutions(segs[s].value), { braces: false, tilde: false })));
                    source += segs[s].quoted ? escapeRegex(piece) : piece;
                  }
                }
                var re;
                try { re = new RegExp(translateRegex(source, 'ERE'), shell.shopt.nocasematch ? 'i' : ''); }
                catch (err) { throw new CondError('[[: invalid regular expression `' + source + "'"); }
                var m = re.exec(left), rematch = { assoc: false, map: new Map() };
                if (m) m.forEach(function (g, k) { rematch.map.set(String(k), g == null ? '' : g); });
                shell.arrays.set('BASH_REMATCH', rematch);
                return !!m;
              }
              var right = await expandValue(e.right);
              switch (e.op) {
                case '<': return left < right;
                case '>': return left > right;
                case '-eq': case '-ne': case '-lt': case '-le': case '-gt': case '-ge': {
                  var a = BigInt(arithmetic(left || '0', env)), b = BigInt(arithmetic(right || '0', env));
                  return { '-eq': a === b, '-ne': a !== b, '-lt': a < b, '-le': a <= b, '-gt': a > b, '-ge': a >= b }[e.op];
                }
                case '-ef': return resolvePath(cwd, left) === resolvePath(cwd, right) && !!(await vfs.stat(resolvePath(cwd, left)));
                case '-nt': case '-ot': {
                  var sa = await vfs.stat(resolvePath(cwd, left)), sb = await vfs.stat(resolvePath(cwd, right));
                  var ta = sa ? +new Date(sa.mtime || 0) : -Infinity, tb = sb ? +new Date(sb.mtime || 0) : -Infinity;
                  return e.op === '-nt' ? !!sa && (!sb || ta > tb) : !!sb && (!sa || ta < tb);
                }
              }
              return false;
            }
          }
          return false;
        }
        // Regex text taken verbatim from the source: quoted parts are literal.
        async function regexFromRaw(text) {
          var out = '', i = 0;
          while (i < text.length) {
            var c = text[i];
            if (c === "'") { var close = text.indexOf("'", i + 1); if (close < 0) close = text.length; out += escapeRegex(text.slice(i + 1, close)); i = close + 1; continue; }
            if (c === '"') {
              var end = i + 1;
              while (end < text.length && text[end] !== '"') { if (text[end] === '\\') end++; end++; }
              out += escapeRegex(unmarkGlob(String(expand(await resolveSubstitutions(text.slice(i + 1, end)), { braces: false, tilde: false }))));
              i = end + 1; continue;
            }
            if (c === '\\' && i + 1 < text.length) { out += escapeRegexChar(text[i + 1]); i += 2; continue; }
            if (c === '$' || text.indexOf(markerPrefix, i) === i) {
              var token = text.slice(i).match(/^\$\{[^}]*\}|^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9?#@*$!-]/);
              var markerEnd = text.indexOf('\u0011', text.indexOf('\u0011', i) + 1);
              var chunk = token ? token[0] : (text.indexOf(markerPrefix, i) === i ? text.slice(i, markerEnd + 1) : c);
              out += unmarkGlob(String(expand(await resolveSubstitutions(chunk), { braces: false, tilde: false })));
              i += chunk.length; continue;
            }
            out += c; i++;
          }
          return out;
        }

        // ---- simple commands ----
        function xtraceWord(w) { return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(w) ? w : "'" + w.replace(/'/g, "'\\''") + "'"; }
        async function arrayItems(items) {
          // Elements of name=( ... ): `[key]=value` entries or plain words.
          var out = [];
          for (var i = 0; i < items.length; i++) {
            var w = items[i], km = !w.quoted || (w.segments[0] && !w.segments[0].quoted) ? /^\[([^\]]*)\]=([\s\S]*)$/.exec(w.text) : null;
            if (km) {
              var valueWord = { text: km[2], quoted: false, segments: [{ value: km[2], quoted: false }] };
              if (w.segments && w.segments.length) {
                var rest = w.text.length - km[2].length, consumed = 0, segs = [];
                w.segments.forEach(function (sg) {
                  var skip = Math.max(0, Math.min(sg.value.length, rest - consumed));
                  consumed += sg.value.length;
                  if (sg.value.length - skip > 0) segs.push({ value: sg.value.slice(skip), quoted: sg.quoted });
                });
                valueWord.segments = segs;
              }
              out.push({ key: km[1], value: await expandValue(valueWord) });
            } else (await expandWords([w])).forEach(function (v) { out.push({ value: v }); });
          }
          return out;
        }
        async function assignArray(name, items, append, assoc) {
          if (isReadonly(name)) return false;
          var arr = shell.arrays.get(name);
          if (!append || !arr) {
            var keepAssoc = arr ? arr.assoc : !!assoc;
            arr = { assoc: keepAssoc || !!assoc, map: new Map() };
            if (append && env[name] != null) arr.map.set('0', String(env[name]));
            delete env[name];
            shell.arrays.set(name, arr);
          }
          var next = arr.assoc ? 0 : arrayKeys(arr).reduce(function (m, k) { return Math.max(m, Number(k) + 1); }, 0);
          var values = await arrayItems(items);
          values.forEach(function (it) {
            if (it.key != null) {
              var key = arr.assoc ? it.key : String(Number(arithmetic(it.key, env)));
              arr.map.set(key, it.value);
              if (!arr.assoc) next = Number(key) + 1;
            } else { arr.map.set(String(next), it.value); next++; }
          });
          return true;
        }
        var ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/;
        function isAssignmentWord(word) {
          if (!ASSIGNMENT.test(word.text)) return false;
          var first = word.segments && word.segments[0];
          if (!first) return !word.quoted;
          // The name and `=` must be unquoted.
          return !first.quoted && ASSIGNMENT.test(first.value);
        }
        function applyPair(p) {
          var m = ASSIGNMENT.exec(p);
          return assignVar(m[1], p.slice(m[0].length), m[2] ? m[2].slice(1, -1) : null, m[3] === '+');
        }
        async function runSimple(node, io) {
          commandArithmeticFailed = false;
          substitutionStatus = 0;
          processFiles.clear();
          processOutputs.clear();
          var assignmentWords = [], commandWords = [], assigning = true;
          node.words.forEach(function (w) {
            if (assigning && isAssignmentWord(w)) assignmentWords.push(w);
            else { assigning = false; commandWords.push(w); }
          });
          var pairs = [];
          for (var ai = 0; ai < assignmentWords.length; ai++) {
            // Assignment values are not brace-expanded, split, or globbed.
            var w = assignmentWords[ai], value = unmarkGlob(String(expand(await resolveSubstitutions(w.text), { braces: false })));
            pairs.push(value);
          }
          var argv = await expandWords(commandWords);
          function arithmeticStatus(code) { return commandArithmeticFailed ? 1 : code; }
          var prefixArrays = node.arrayAssigns ? node.arrayAssigns.filter(function (a) { return a.position <= assignmentWords.length; }) : [];
          var argArrays = node.arrayAssigns ? node.arrayAssigns.filter(function (a) { return a.position > assignmentWords.length; }) : [];
          if (shell.options.xtrace && (argv.length || pairs.length)) {
            (io.err || { write: stderr }).write('+ ' + pairs.map(function (p) { var m = ASSIGNMENT.exec(p); return m[0] + xtraceWord(p.slice(m[0].length)); }).concat(argv.map(xtraceWord)).join(' ') + '\n');
          }
          if (!argv.length && !node.redirects.length) {
            // A failed assignment (readonly variable) ends a non-interactive shell.
            for (var pi = 0; pi < pairs.length; pi++) if (!applyPair(pairs[pi])) throw new ExitSignal(1);
            for (var pa = 0; pa < prefixArrays.length; pa++) if (!(await assignArray(prefixArrays[pa].name, prefixArrays[pa].items, prefixArrays[pa].append))) return 1;
            return arithmeticStatus(substitutionStatus);
          }
          var name = argv.length ? argv[0] : '', args = argv.slice(1);
          var prepared;
          try { prepared = await prepareFds(node.redirects, io); }
          catch (re) { if (re instanceof ShellError || (re && re.code)) return redirectFailed(re); throw re; }
          var table = prepared.table, opened = prepared.opened, touched = prepared.touched;
          function requireFd(fd, cap) { var ent = table.get(fd); if (!ent || ent.closed || !ent[cap]) throw new ShellError('Bad file descriptor', 'EBADF'); return ent[cap]; }
          var writeOut = function (s) { requireFd(1, 'output').write(s); }, writeErr = function (s) { requireFd(2, 'output').write(s); };
          var stdinStream = table.get(0) && table.get(0).input;
          var commandStdin = {
            readAll: function () { requireFd(0, 'input'); return stdinStream.readAll(); },
            readUntil: function (delim) { requireFd(0, 'input'); return stdinStream.readUntil(delim); },
            readChars: function (n) { requireFd(0, 'input'); return stdinStream.readChars(n); }
          };
          if (!argv.length) {
            // Redirection-only command: assignments still apply to the shell.
            try {
              pairs.forEach(applyPair);
              for (var pr = 0; pr < prefixArrays.length; pr++) await assignArray(prefixArrays[pr].name, prefixArrays[pr].items, prefixArrays[pr].append);
            } finally { await flushAll(opened); }
            return arithmeticStatus(substitutionStatus);
          }
          if (name === 'exec') {
            if (args.length) { await flushAll(opened); stderrLine('bash: exec: arguments are not supported'); return 2; }
            // Only descriptors named by this command's redirections persist,
            // and never from inside a pipeline (bash runs stages in subshells).
            if (!io.out && !io.piped) touched.forEach(function (fd) {
              var persisted = table.get(fd);
              if (!persisted) { persistentFds.set(fd, null); return; }
              opened.forEach(function (writer) { if (persisted.output && persisted.output.write === writer) persisted._flush = writer; });
              persistentFds.set(fd, persisted);
            });
            await flushAll(opened);
            return 0;
          }
          var commandIo = ioFromTable(table, io, null);
          // Prefix assignments are visible to the command only.
          var savedEnv = env, isFunction = shell.functions.has(name) && !node.noFunctions;
          var isSession = SESSION_BUILTINS.indexOf(name) >= 0;
          var temporary = [];
          function applyTemporary() {
            pairs.forEach(function (p) {
              var m = ASSIGNMENT.exec(p);
              temporary.push([m[1], Object.prototype.hasOwnProperty.call(env, m[1]), env[m[1]]]);
              env[m[1]] = p.slice(m[0].length);
            });
          }
          function restoreTemporary() {
            temporary.reverse().forEach(function (t) { if (t[1]) env[t[0]] = t[2]; else delete env[t[0]]; });
          }
          if (isFunction || isSession) {
            applyTemporary();
            try {
              if (isFunction) return await callFunction(name, args, commandIo);
              return await sessionBuiltin(name, args, { io: commandIo, out: writeOut, err: writeErr, argArrays: argArrays, table: table, node: node });
            } catch (e) {
              if (e instanceof ShellError && e.code === 'EBADF') { try { writeErr('bash: ' + name + ': write error: Bad file descriptor\n'); } catch (_) {} return 1; }
              throw e;
            } finally { restoreTemporary(); await flushAll(opened); }
          }
          env = Object.assign({}, env);
          pairs.forEach(function (p) { var m = ASSIGNMENT.exec(p); env[m[1]] = p.slice(m[0].length); });
          var commandVfs = Object.create(vfs);
          commandVfs.readFile = async function (path) {
            var resolved = resolvePath(cwd, path);
            return processFiles.has(resolved) ? processFiles.get(resolved) : vfs.readFile(path);
          };
          // Reads a command operand: '-' and /dev/stdin are fd 0, /dev/fd/N is
          // that descriptor or a process substitution, else the VFS.
          async function readOperand(operand) {
            if (operand === '-') return commandStdin.readAll();
            var resolved = resolvePath(cwd, operand);
            if (resolved === '/dev/stdin') return commandStdin.readAll();
            if (processFiles.has(resolved)) return processFiles.get(resolved);
            if (/^\/dev\/fd\/\d+$/.test(resolved)) {
              var fdEntry = table.get(Number(resolved.slice(8)));
              if (!fdEntry || !fdEntry.input) throw new ShellError('Bad file descriptor', 'EBADF');
              return fdEntry.input.readAll();
            }
            return vfs.readFile(resolved);
          }
          function quoteArg(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
          // Lookup order: function, shell builtin, user-registered command, bundled utility.
          var lookupName = name.indexOf('/') >= 0 ? basename(name) : name;
          var isBuiltin = BUILTINS.has(name);
          var command = (isBuiltin ? BUILTINS.get(name) : null) || registry.get(lookupName) || COMMANDS.get(lookupName);
          if (node.onlyBuiltins && !isBuiltin) command = null;
          var errorPrefix = (isBuiltin ? 'bash: ' : '') + name + ': ';
          var ctx = { name: name, args: args, argv0: argv[0], cwd: cwd, env: Object.assign({}, env),
            stdin: commandStdin, stdout: { write: writeOut }, stderr: { write: writeErr },
            resolve: function (p) { return resolvePath(cwd, p); }, vfs: commandVfs,
            readFile: readOperand,
            stdinRedirected: !!io.piped || touched.has(0),
            now: function () { return typeof config.now === 'function' ? new Date(+config.now()) : new Date(); },
            timezone: config.timezone || env.TZ || null,
            fdInput: function (fd) { var e = table.get(fd); return e && e.input ? e.input : null; },
            // Runs argv (array, each word quoted) or a command line (string).
            // execOptions: { cwd, stdin, capture }. With capture, stdout is
            // collected and { exitCode, stdout } is returned instead of a code.
            exec: async function (execArgv, execOptions) {
              execOptions = execOptions || {};
              var captured = '';
              var child = childSession({ cwd: execOptions.cwd || cwd, stdin: execOptions.stdin || '',
                stdout: function (s) { if (execOptions.capture) captured += s; else writeOut(s); }, stderr: function (s) { writeErr(s); } });
              var line = typeof execArgv === 'string' ? execArgv : execArgv.map(quoteArg).join(' ');
              var code = (await child.exec(line, { pipefail: pipefailOn() })).exitCode;
              return execOptions.capture ? { exitCode: code, stdout: captured } : code;
            },
            error: function (m) { writeErr(errorPrefix + m + '\n'); } };
          if (isBuiltin) ctx.shell = {
            lastStatus: status,
            setCwd: function (path) { savedEnv.OLDPWD = cwd; cwd = path; savedEnv.PWD = path; env.OLDPWD = savedEnv.OLDPWD; env.PWD = path; ctx.cwd = path; },
            getVar: function (n) { var v = getVar(n); return v == null ? undefined : v; },
            setVar: function (n, v) {
              var saved = env; env = savedEnv;
              try { return assignVar(n, v); } finally { env = saved; if (!shell.arrays.has(n)) env[n] = String(v); }
            },
            setArray: function (n, values) {
              if (isReadonly(n)) return false;
              delete savedEnv[n]; delete env[n];
              shell.arrays.set(n, { assoc: false, map: new Map(values.map(function (v, k) { return [String(k), String(v)]; })) });
              return true;
            },
            unsetVar: function (n) { delete savedEnv[n]; delete env[n]; shell.arrays.delete(n); },
            markExported: function (n, on) { if (on) shell.exported.add(n); else shell.exported.delete(n); },
            vars: function () { return Object.keys(savedEnv); }
          };
          function reportQuietly(message) { try { writeErr(message); } catch (_) { /* fd 2 closed too */ } }
          try {
            if (command) {
              try { var code = await command(ctx); return arithmeticStatus(typeof code === 'number' ? code : 0); }
              catch (e) {
                if (e instanceof ExitSignal) throw e;
                reportQuietly(errorPrefix + (e && e.code === 'EBADF' ? 'write error: Bad file descriptor' : (e && e.message) || String(e)) + '\n');
                return 1;
              }
            }
            reportQuietly('bash: ' + name + ': command not found\n');
            return 127;
          } finally {
            env = savedEnv;
            await flushAll(opened);
          }
        }

        // ---- functions, eval and source ----
        async function callFunction(name, args, fnIo) {
          if (callDepth >= maxCallDepth) { stderrLine('bash: ' + name + ': maximum function nesting level exceeded (' + maxCallDepth + ')'); return 1; }
          var savedPositional = shell.positional, frame = { locals: new Map() };
          shell.positional = args.slice();
          frame.name = name;
          frames.push(frame); callDepth++;
          try { return await run(shell.functions.get(name), fnIo); }
          catch (e) { if (e instanceof ReturnSignal) return e.code; throw e; }
          finally {
            callDepth--; frames.pop();
            shell.positional = savedPositional;
            Array.from(frame.locals.keys()).reverse().forEach(function (n) {
              var saved = frame.locals.get(n);
              if (saved.array) shell.arrays.set(n, saved.array); else shell.arrays.delete(n);
              if (saved.had) env[n] = saved.value; else delete env[n];
            });
          }
        }
        function makeLocal(name) {
          var frame = frames[frames.length - 1];
          if (!frame.locals.has(name)) frame.locals.set(name, { had: Object.prototype.hasOwnProperty.call(env, name), value: env[name], array: shell.arrays.get(name) });
        }
        async function runText(text, io, label) {
          var ast;
          try { ast = parse(await substitute(text)); }
          catch (e) { stderrLine('bash: ' + (label ? label + ': ' : '') + (/^syntax error/.test(e.message) ? '' : 'syntax error: ') + e.message); return 2; }
          return runList(ast.body, io);
        }

        // Builtins that need the interpreter's state.
        async function sessionBuiltin(name, args, c) {
          var io = c.io;
          function err(message) { try { c.err('bash: ' + name + ': ' + message + '\n'); } catch (_) {} }
          switch (name) {
            case 'set': return builtinSet(args, c);
            case 'shopt': {
              var mode = null, quiet = false, names = [];
              args.forEach(function (a) { if (a === '-s') mode = true; else if (a === '-u') mode = false; else if (a === '-q') quiet = true; else names.push(a); });
              var known = ['nullglob', 'dotglob', 'globstar', 'nocaseglob', 'nocasematch', 'extglob', 'failglob', 'expand_aliases', 'lastpipe', 'inherit_errexit', 'xpg_echo'];
              for (var i = 0; i < names.length; i++) if (known.indexOf(names[i]) < 0) { err(names[i] + ': invalid shell option name'); return 1; }
              if (mode === null) {
                var list = names.length ? names : known, allOn = true;
                list.forEach(function (n) { if (!shell.shopt[n]) allOn = false; if (!quiet) c.out(n.padEnd(15) + '\t' + (shell.shopt[n] ? 'on' : 'off') + '\n'); });
                return allOn ? 0 : 1;
              }
              names.forEach(function (n) { shell.shopt[n] = mode; });
              return 0;
            }
            case 'shift': {
              var n = args.length ? Number(args[0]) : 1;
              if (!/^\d+$/.test(args[0] || '1')) { err(args[0] + ': numeric argument required'); return 1; }
              if (n > shell.positional.length) return 1;
              shell.positional = shell.positional.slice(n);
              return 0;
            }
            case 'local': case 'declare': case 'typeset': case 'readonly':
              return builtinDeclare(name, args, c);
            case 'return': {
              if (!callDepth && !sourceDepth) { err('can only `return\' from a function or sourced script'); return 1; }
              if (args.length && !/^-?\d+$/.test(args[0])) { err(args[0] + ': numeric argument required'); throw new ReturnSignal(2); }
              throw new ReturnSignal(args.length ? ((Number(args[0]) % 256) + 256) % 256 : status);
            }
            case 'break': case 'continue': {
              var levels = args.length ? Number(args[0]) : 1;
              if (!/^\d+$/.test(args[0] || '1') || levels < 1) { err(args[0] + ': loop count out of range'); return 1; }
              if (!loopDepth) { err("only meaningful in a `for', `while', or `until' loop"); return 0; }
              throw new LoopSignal(name, Math.min(levels, loopDepth));
            }
            case 'eval': return args.length ? runText(args.join(' '), io, 'eval') : 0;
            case 'source': case '.': {
              if (!args.length) { err('filename argument required'); return 2; }
              var text;
              try { text = await vfs.readFile(resolvePath(cwd, args[0])); }
              catch (e) { err(args[0] + ': ' + errorReason(e)); return 1; }
              var savedPositional = shell.positional;
              if (args.length > 1) shell.positional = args.slice(1);
              sourceDepth++;
              try { return await runText(text, io, args[0]); }
              catch (e) { if (e instanceof ReturnSignal) return e.code; throw e; }
              finally { sourceDepth--; if (args.length > 1) shell.positional = savedPositional; }
            }
            case 'let': {
              if (!args.length) { err('expression expected'); return 1; }
              var last = '0';
              try { for (var li = 0; li < args.length; li++) last = await evalArith(args[li]); }
              catch (e) { arithError(e, args[li]); return 1; }
              return Number(last) !== 0 ? 0 : 1;
            }
            case 'unset': {
              var fnMode = false, rc = 0;
              args.forEach(function (a) {
                if (a === '-f') { fnMode = true; return; }
                if (a === '-v' || a === '-n') return;
                if (fnMode) { shell.functions.delete(a); return; }
                var um = a.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/);
                if (!um) { err('`' + a + "': not a valid identifier"); rc = 1; return; }
                if (um[2] != null) {
                  var arr = shell.arrays.get(um[1]);
                  if (arr) { if (um[2] === '@' || um[2] === '*') arr.map.clear(); else arr.map.delete(arrayKey(um[1], um[2])); }
                  return;
                }
                if (!unsetVar(um[1])) { rc = 1; return; }
                if (!shell.arrays.has(um[1]) && !(um[1] in env)) shell.functions.delete(um[1]);
              });
              return rc;
            }
            case 'type': return builtinType(args, c);
            case 'command': case 'builtin': {
              var opts = [];
              while (args.length && /^-[pvV]+$/.test(args[0])) opts.push(args.shift());
              if (!args.length) return 0;
              if (opts.join('').indexOf('v') >= 0 || opts.join('').indexOf('V') >= 0) return builtinType(['-c'].concat(args), c);
              // Re-run the already-expanded words as quoted literals, skipping functions.
              var literal = function (a) { var v = a.replace(/\$/g, '\u0001').replace(/[*?[\]{}~]/g, markQuoted); return { text: v, quoted: true, segments: [{ value: v, quoted: true }] }; };
              var sub = { type: 'SimpleCommand', words: args.map(literal), redirects: [], arrayAssigns: [], noFunctions: true, onlyBuiltins: name === 'builtin' };
              if (name === 'builtin' && !BUILTINS.has(args[0]) && SESSION_BUILTINS.indexOf(args[0]) < 0) { err(args[0] + ': not a shell builtin'); return 1; }
              return runSimple(sub, io);
            }
            case 'trap': {
              if (!args.length) { shell.traps.forEach(function (cmd, sig) { c.out('trap -- ' + quoteForQ(cmd) + ' ' + sig + '\n'); }); return 0; }
              if (args[0] === '-l' || args[0] === '-p') return 0;
              var action = args[0], signals = args.slice(1);
              if (/^\d+$/.test(action) || (!signals.length)) { signals = args; action = '-'; }
              signals.forEach(function (sig) {
                var key = String(sig).toUpperCase().replace(/^SIG/, '');
                if (key === '0') key = 'EXIT';
                if (action === '-') shell.traps.delete(key); else shell.traps.set(key, action);
              });
              return 0;
            }
            case 'wait': case 'hash': return 0;
            case 'getopts': return builtinGetopts(args, c);
          }
          return 2;
        }
        function builtinSet(args, c) {
          var letters = { e: 'errexit', u: 'nounset', x: 'xtrace', f: 'noglob', C: 'noclobber', v: 'verbose', n: 'noexec', B: 'braceexpand', h: 'hashall', a: 'allexport', b: 'notify', m: 'monitor', H: 'histexpand', P: 'physical', T: 'functrace', E: 'errtrace' };
          var named = ['allexport', 'braceexpand', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand', 'history', 'ignoreeof', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'emacs', 'xtrace'];
          if (!args.length) {
            Object.keys(env).filter(function (k) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k); }).sort().forEach(function (k) {
              var v = String(env[k]);
              c.out(k + '=' + (/^[A-Za-z0-9_@%+=:,.\/-]*$/.test(v) ? v : quoteForQ(v)) + '\n');
            });
            return 0;
          }
          for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (a === '--') { shell.positional = args.slice(i + 1); return 0; }
            if (a === '-' ) { shell.options.xtrace = false; shell.options.verbose = false; if (i + 1 < args.length) shell.positional = args.slice(i + 1); return 0; }
            if (/^[-+]o$/.test(a)) {
              var opt = args[i + 1];
              if (opt === undefined) {
                named.forEach(function (n) {
                  if (a === '-o') c.out(n.padEnd(15) + '\t' + (shell.options[n] ? 'on' : 'off') + '\n');
                  else c.out('set ' + (shell.options[n] ? '-o' : '+o') + ' ' + n + '\n');
                });
                return 0;
              }
              if (named.indexOf(opt) < 0) { try { c.err('bash: set: ' + opt + ': invalid option name\n'); } catch (_) {} return 2; }
              shell.options[opt] = a === '-o';
              i++; continue;
            }
            if (/^[-+][A-Za-z]+$/.test(a)) {
              for (var k = 1; k < a.length; k++) {
                if (!letters[a[k]]) { try { c.err('bash: set: ' + a.charAt(0) + a[k] + ': invalid option\n'); } catch (_) {} return 2; }
                shell.options[letters[a[k]]] = a.charAt(0) === '-';
              }
              continue;
            }
            shell.positional = args.slice(i);
            return 0;
          }
          return 0;
        }
        async function builtinDeclare(name, args, c) {
          var flags = {}, unflags = {}, operands = [], inFunction = frames.length > 0;
          if (name === 'local' && !inFunction) { try { c.err('bash: local: can only be used in a function\n'); } catch (_) {} return 1; }
          for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (/^[-+][aAfFgilnprtuxI]+$/.test(a) && !operands.length) { for (var k = 1; k < a.length; k++) (a.charAt(0) === '-' ? flags : unflags)[a[k]] = true; continue; }
            operands.push(a);
          }
          if (name === 'readonly') flags.r = true;
          var local = name === 'local' || (inFunction && name !== 'readonly' && !flags.g);
          if (flags.f || flags.F) {
            var fnames = operands.length ? operands : Array.from(shell.functions.keys()).sort();
            var missing = 0;
            fnames.forEach(function (f) { if (shell.functions.has(f)) c.out((flags.F ? 'declare -f ' : '') + f + (flags.F ? '' : ' ()') + '\n'); else missing = 1; });
            return missing;
          }
          function describe(n) {
            var attrs = (shell.arrays.has(n) ? (shell.arrays.get(n).assoc ? 'A' : 'a') : '') + (shell.integers.has(n) ? 'i' : '') + (shell.readonly.has(n) ? 'r' : '') + (shell.exported.has(n) ? 'x' : '');
            var arr = shell.arrays.get(n);
            if (arr) return 'declare -' + (attrs || '-') + ' ' + n + '=(' + arrayKeys(arr).map(function (key) { return '[' + key + ']="' + String(arr.map.get(key)).replace(/["\\$`]/g, '\\$&') + '"'; }).join(' ') + ')';
            return 'declare -' + (attrs || '-') + ' ' + n + (env[n] != null ? '="' + String(env[n]).replace(/["\\$`]/g, '\\$&') + '"' : '');
          }
          if (flags.p || (!operands.length && !c.argArrays.length && name !== 'local')) {
            var names = operands.length ? operands : Object.keys(env).concat(Array.from(shell.arrays.keys())).filter(function (n) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n); }).sort();
            var notFound = 0;
            names.forEach(function (n) {
              if (name === 'readonly' && !operands.length && !shell.readonly.has(n)) return;
              if (env[n] == null && !shell.arrays.has(n)) { try { c.err('bash: ' + name + ': ' + n + ': not found\n'); } catch (_) {} notFound = 1; return; }
              c.out(describe(n) + '\n');
            });
            return notFound;
          }
          var rc = 0;
          for (var o = 0; o < operands.length; o++) {
            var item = operands[o], m = item.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?=)?([\s\S]*)$/);
            if (!m) { try { c.err('bash: ' + name + ': `' + item + "': not a valid identifier\n"); } catch (_) {} rc = 1; continue; }
            var vname = m[1];
            if (local) makeLocal(vname);
            if (shell.readonly.has(vname) && (m[3] || flags.a || flags.A)) { isReadonly(vname); rc = 1; continue; }
            if (local && !m[3] && name === 'local') { delete env[vname]; shell.arrays.delete(vname); }
            if (flags.i) shell.integers.add(vname); else if (unflags.i) shell.integers.delete(vname);
            if (flags.a || flags.A) ensureArray(vname, flags.A);
            var arrayLiteral = c.argArrays.filter(function (x) { return x.name === vname; })[0];
            if (arrayLiteral) { if (!(await assignArray(vname, arrayLiteral.items, arrayLiteral.append, flags.A))) rc = 1; }
            else if (m[3]) { if (!assignVar(vname, m[4], m[2] ? m[2].slice(1, -1) : null, m[3] === '+=')) rc = 1; }
            if (flags.r) shell.readonly.add(vname);
            if (flags.x && !shell.arrays.has(vname) && env[vname] == null && !m[3]) env[vname] = env[vname];
          }
          // Array literals whose name has no other operand (local a=(1 2)).
          for (var al = 0; al < c.argArrays.length; al++) {
            var lit = c.argArrays[al];
            if (operands.some(function (x) { return x.split(/[=[]/)[0] === lit.name; })) continue;
            if (local) makeLocal(lit.name);
            if (!(await assignArray(lit.name, lit.items, lit.append, flags.A))) rc = 1;
            if (flags.r) shell.readonly.add(lit.name);
          }
          return rc;
        }
        function builtinType(args, c) {
          var mode = '', rc = 0, names = [];
          args.forEach(function (a) { if (/^-[tpaPfc]+$/.test(a)) mode += a.slice(1); else names.push(a); });
          names.forEach(function (n) {
            var kind = KEYWORDS.indexOf(n) >= 0 ? 'keyword' : shell.functions.has(n) ? 'function'
              : (BUILTINS.has(n) || SESSION_BUILTINS.indexOf(n) >= 0) ? 'builtin' : (registry.has(n) || COMMANDS.has(n)) ? 'file' : null;
            if (!kind) { if (mode.indexOf('c') < 0 && mode.indexOf('t') < 0) { try { c.err('bash: type: ' + n + ': not found\n'); } catch (_) {} } rc = 1; return; }
            if (mode.indexOf('c') >= 0) { c.out((kind === 'file' ? '/usr/bin/' + n : n) + '\n'); return; }
            if (mode.indexOf('t') >= 0) { c.out(kind + '\n'); return; }
            if (mode.indexOf('p') >= 0) { if (kind === 'file') c.out('/usr/bin/' + n + '\n'); return; }
            c.out(n + ' is ' + (kind === 'keyword' ? 'a shell keyword' : kind === 'function' ? 'a function' : kind === 'builtin' ? 'a shell builtin' : '/usr/bin/' + n) + '\n');
          });
          return rc;
        }
        function builtinGetopts(args, c) {
          if (args.length < 2) { try { c.err('bash: getopts: usage: getopts optstring name [arg ...]\n'); } catch (_) {} return 2; }
          var optstring = args[0], varName = args[1], list = args.length > 2 ? args.slice(2) : shell.positional;
          var silent = optstring.charAt(0) === ':';
          var optind = Number(getVar('OPTIND') || 1);
          if (shell.getoptsIndex !== optind) { shell.getoptsIndex = optind; shell.getoptsPos = 0; }
          function finish() { env.OPTIND = String(shell.getoptsIndex); }
          if (shell.getoptsPos === 0) {
            var arg = list[optind - 1];
            if (arg === undefined || arg === '-' || arg.charAt(0) !== '-') { assignVar(varName, '?'); finish(); return 1; }
            if (arg === '--') { shell.getoptsIndex = optind + 1; assignVar(varName, '?'); finish(); return 1; }
            shell.getoptsPos = 1;
          }
          var current = list[shell.getoptsIndex - 1], ch = current.charAt(shell.getoptsPos++);
          if (shell.getoptsPos >= current.length) { shell.getoptsIndex++; shell.getoptsPos = 0; }
          var at = optstring.indexOf(ch);
          if (ch === ':' || at < 0) {
            if (silent) { assignVar(varName, '?'); env.OPTARG = ch; }
            else { try { c.err('bash: illegal option -- ' + ch + '\n'); } catch (_) {} assignVar(varName, '?'); delete env.OPTARG; }
            finish(); return 0;
          }
          if (optstring.charAt(at + 1) === ':') {
            if (shell.getoptsPos > 0) { env.OPTARG = current.slice(shell.getoptsPos); shell.getoptsIndex++; shell.getoptsPos = 0; }
            else if (shell.getoptsIndex <= list.length) { env.OPTARG = list[shell.getoptsIndex - 1]; shell.getoptsIndex++; }
            else {
              if (silent) { assignVar(varName, ':'); env.OPTARG = ch; }
              else { try { c.err('bash: option requires an argument -- ' + ch + '\n'); } catch (_) {} assignVar(varName, '?'); delete env.OPTARG; }
              finish(); return 0;
            }
          } else delete env.OPTARG;
          assignVar(varName, ch);
          finish();
          return 0;
        }
        var ast, topIo = { stdin: new InputStream(input), piped: false, out: null, err: null, fds: null };
        try { ast = parse(command); }
        catch (e) {
          stderr('bash: ' + (/^syntax error/.test(e.message) ? '' : 'syntax error: ') + (e.message || 'unexpected token') + '\n');
          // bash repeats the source line of an unexpected token.
          if (e.line) stderr('bash: `' + (originalCommand.split('\n')[e.line - 1] || '') + "'\n");
          status = 2;
        }
        async function runTop(fn) {
          try { status = await fn(); }
          catch (e) {
            if (e instanceof ExitSignal) status = e.code;
            else if (e instanceof FatalShellError) { stderr('bash: ' + e.message + '\n'); status = e.code; }
            else if (e instanceof LoopSignal) status = 0;
            else if (e instanceof ReturnSignal) status = e.code;
            else { status = 1; stderr('bash: ' + (e.message || String(e)) + '\n'); }
          }
        }
        if (ast) await runTop(function () { return String(command || '').trim() ? runList(ast.body, topIo) : 0; });
        // An EXIT trap runs once, when the top-level script finishes.
        if (!config._shell && shell.traps.has('EXIT')) {
          var exitTrap = shell.traps.get('EXIT'), finalStatus = status;
          shell.traps.delete('EXIT');
          await runTop(async function () { await runText(exitTrap, topIo, null); return finalStatus; });
        }
         return { exitCode: status, stdout: out, stderr: err, cwd: cwd, env: Object.assign({}, env) };
      },
      getCwd: function () { return cwd; },
      getEnv: function () { return Object.assign({}, env); },
      getPositional: function () { return shell.positional.slice(); },
      setPositional: function (args) { shell.positional = (args || []).map(String); },
      setEnv: function (name, value) { env[String(name)] = String(value); },
      _vfs: vfs
    };
  }

  // ==========================================================================
  // §8–§9 Commands: shell builtins and bundled utilities
  // ==========================================================================
  // Every command is `async function (ctx) -> exitCode`. ctx provides:
  //   name, args, cwd, env, resolve(path), vfs, readFile(operand),
  //   stdin.readAll(), stdout.write(s), stderr.write(s), error(msg),
  //   now(), timezone, exec(argv, {cwd}) -> exitCode, stdinRedirected,
  //   shell (builtins only): setCwd, getVar, setVar, unsetVar, vars, lastStatus.

  function ExitSignal(code) { this.code = code; }
  // break/continue (kind) unwinding `levels` loops; return from a function.
  function LoopSignal(kind, levels) { this.kind = kind; this.levels = levels; }
  function ReturnSignal(code) { this.code = code; }
  // An error that aborts the script (unbound variable, bad substitution).
  function FatalShellError(message, code) { this.message = message; this.code = code == null ? 1 : code; }
  function newShellState(parent, config) {
    if (parent) {
      var arrays = new Map();
      parent.arrays.forEach(function (arr, name) { arrays.set(name, { assoc: arr.assoc, map: new Map(arr.map) }); });
      // Subshells do not inherit errexit (bash without inherit_errexit).
      return { functions: new Map(parent.functions), arrays: arrays, positional: parent.positional.slice(), options: Object.assign({}, parent.options, { errexit: false }),
        shopt: Object.assign({}, parent.shopt), readonly: new Set(parent.readonly), integers: new Set(parent.integers), traps: new Map(), startTime: parent.startTime, getoptsIndex: 1, getoptsPos: 0, exported: new Set(parent.exported) };
    }
    return { functions: new Map(), arrays: new Map(), positional: ((config && config.args) || []).map(String),
      options: { errexit: false, nounset: false, xtrace: false, noglob: false, noclobber: false, pipefail: false, braceexpand: true, hashall: true },
      shopt: { nullglob: false, dotglob: false, globstar: false, nocaseglob: false, nocasematch: false, extglob: false },
      readonly: new Set(), integers: new Set(), traps: new Map(), startTime: Date.now(), getoptsIndex: 1, getoptsPos: 0,
      // Variables from the host environment start out exported.
      exported: new Set(Object.keys((config && config.env) || {}).concat(['PWD'])) };
  }
  // options.noTry: GNU prints no "Try '... --help'" hint for this error.
  function UsageError(message, options) { this.message = message; this.noTry = !!(options && options.noTry); }

  // GNU-style option parser. spec.flags: short boolean options; spec.params:
  // short options taking a value; spec.long: { name: key | {key, arg} } where
  // arg is true (required) or 'optional'; spec.numeric: accept -NUM as '#'.
  function getopt(args, spec) {
    spec = spec || {};
    var flags = spec.flags || '', params = spec.params || '', longs = spec.long || {};
    var list = [], operands = [], i = 0;
    while (i < args.length) {
      var a = args[i];
      if (a === '--') { operands = operands.concat(args.slice(i + 1)); break; }
      if (spec.stopAtOperand && operands.length) { operands.push(a); i++; continue; }
      if (a.length > 2 && a.slice(0, 2) === '--') {
        var eq = a.indexOf('='), lname = eq < 0 ? a.slice(2) : a.slice(2, eq), lval = eq < 0 ? undefined : a.slice(eq + 1);
        var match = Object.prototype.hasOwnProperty.call(longs, lname) ? lname : null;
        if (!match) {
          var candidates = Object.keys(longs).filter(function (n) { return n.indexOf(lname) === 0; });
          if (candidates.length === 1) match = candidates[0];
          else if (candidates.length > 1) throw new UsageError("option '--" + lname + "' is ambiguous");
        }
        if (!match) throw new UsageError("unrecognized option '--" + lname + "'");
        var def = typeof longs[match] === 'string' ? { key: longs[match] } : longs[match];
        if (def.arg === true && lval === undefined) {
          if (i + 1 >= args.length) throw new UsageError("option '--" + match + "' requires an argument");
          lval = args[++i];
        } else if (!def.arg && lval !== undefined) throw new UsageError("option '--" + match + "' doesn't allow an argument");
        list.push([def.key || match, lval === undefined ? (def.value !== undefined ? def.value : true) : lval]);
        i++; continue;
      }
      if (a.charAt(0) === '-' && a.length > 1) {
        if (spec.numeric && /^-\d+$/.test(a)) { list.push(['#', a.slice(1)]); i++; continue; }
        for (var j = 1; j < a.length; j++) {
          var c = a.charAt(j);
          if (params.indexOf(c) >= 0) {
            var v = a.slice(j + 1);
            if (!v) {
              if (i + 1 >= args.length) throw new UsageError("option requires an argument -- '" + c + "'");
              v = args[++i];
            }
            list.push([c, v]); break;
          }
          if (flags.indexOf(c) >= 0) { list.push([c, true]); continue; }
          if (spec.numeric && /\d/.test(c)) { var digits = a.slice(j).match(/^\d+/)[0]; list.push(['#', digits]); j += digits.length - 1; continue; }
          throw new UsageError("invalid option -- '" + c + "'");
        }
        i++; continue;
      }
      operands.push(a); i++;
    }
    return {
      list: list, operands: operands,
      has: function (k) { return list.some(function (p) { return p[0] === k; }); },
      get: function (k) { var v; list.forEach(function (p) { if (p[0] === k) v = p[1]; }); return v; },
      all: function (k) { return list.filter(function (p) { return p[0] === k; }).map(function (p) { return p[1]; }); },
      // Last option among `keys` that was given (GNU: the last one wins).
      last: function (keys) { var v = null; list.forEach(function (p) { if (keys.indexOf(p[0]) >= 0) v = p[0]; }); return v; }
    };
  }

  var COMMANDS = new Map();        // bundled utilities (overridable)
  var BUILTINS = new Map();        // shell builtins (take precedence)
  function defineCommand(table, name, options, fn) {
    options = options || {};
    table.set(name, async function (ctx) {
      if (!options.literalArgs && ctx.args.length === 1 && (ctx.args[0] === '--help' || ctx.args[0] === '--version')) {
        ctx.stdout.write(ctx.args[0] === '--help' ? 'Usage: ' + name + ' ' + (options.usage || '[OPTION]... [FILE]...') + '\n' : name + ' (bash.js) ' + VERSION + '\n');
        return 0;
      }
      try { return await fn(ctx); }
      catch (e) {
        if (e instanceof UsageError) {
          ctx.error(e.message);
          if (!options.noTryHelp && !e.noTry) ctx.stderr.write("Try '" + name + " --help' for more information.\n");
          return options.usageCode == null ? 1 : options.usageCode;
        }
        throw e;
      }
    });
  }
  function utility(name, options, fn) { defineCommand(COMMANDS, name, options, fn); }
  function builtin(name, options, fn) { defineCommand(BUILTINS, name, Object.assign({ noTryHelp: true, usageCode: 2 }, options), fn); }

  // ---- text helpers -------------------------------------------------------
  function toBytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
    var binary = unescape(encodeURIComponent(String(text))), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Splits text into records that keep their terminator ("a\n", "b\n", "c").
  function records(text, sep) {
    sep = sep || '\n';
    var out = [], start = 0, at;
    while ((at = text.indexOf(sep, start)) >= 0) { out.push(text.slice(start, at + 1)); start = at + 1; }
    if (start < text.length) out.push(text.slice(start));
    return out;
  }
  // Records without terminators.
  function lines(text, sep) {
    sep = sep || '\n';
    return records(text, sep).map(function (r) { return r.charAt(r.length - 1) === sep ? r.slice(0, -1) : r; });
  }
  function quoteName(name) { return "'" + name + "'"; }
  function displayInput(name) { return name === '-' ? 'standard input' : name; }

  // Reads each operand ('-' = stdin), reporting unreadable ones GNU-style.
  // describeError(operand, error) customises the message (head: "cannot open").
  async function forEachInput(ctx, operands, fn, describeError) {
    if (!operands.length) operands = ['-'];
    var status = 0;
    for (var i = 0; i < operands.length; i++) {
      var text;
      try { text = await ctx.readFile(operands[i]); }
      catch (e) { ctx.error(describeError ? describeError(operands[i], e) : operands[i] + ': ' + errorReason(e)); status = 1; continue; }
      var stop = await fn(text, operands[i], i);
      if (stop === false) break;
    }
    return status;
  }

  // Count arguments such as `-n 5`, `-c 2K`, `-n -3`, `-n +3`.
  function parseCount(raw, what) {
    var m = String(raw).match(/^([+-]?)(\d+)(b|kB|K|KiB|k|MB|M|MiB|GB|G|GiB|TB|T|TiB)?$/);
    if (!m) throw new UsageError('invalid number of ' + what + ': ' + quoteName(raw), { noTry: true });
    var units = { b: 512, kB: 1000, K: 1024, KiB: 1024, k: 1024, MB: 1e6, M: 1048576, MiB: 1048576, GB: 1e9, G: 1073741824, GiB: 1073741824, TB: 1e12, T: 1099511627776, TiB: 1099511627776 };
    return { sign: m[1], value: Number(m[2]) * (m[3] ? units[m[3]] : 1) };
  }

  // ---- escapes and printf -------------------------------------------------
  // mode: 'echo' (\0NNN), 'b' (printf %b: \0NNN and \NNN), 'fmt' (\NNN).
  function decodeEscapes(text, mode) {
    var out = '', i = 0;
    while (i < text.length) {
      var c = text[i];
      if (c !== '\\' || i + 1 >= text.length) { out += c; i++; continue; }
      var d = text[i + 1];
      var simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
      if (mode === 'fmt') { simple['"'] = '"'; simple["'"] = "'"; }
      if (simple[d] !== undefined) { out += simple[d]; i += 2; continue; }
      if (d === 'c' && mode !== 'fmt') return { text: out, stop: true };
      var m;
      if (d === '0' && mode !== 'fmt' && (m = text.slice(i + 2).match(/^[0-7]{0,3}/))) {
        out += String.fromCharCode(parseInt(m[0] || '0', 8) & 255); i += 2 + m[0].length; continue;
      }
      if ((mode === 'fmt' || mode === 'b') && (m = text.slice(i + 1).match(/^[0-7]{1,3}/))) {
        out += String.fromCharCode(parseInt(m[0], 8) & 255); i += 1 + m[0].length; continue;
      }
      if (d === 'x' && (m = text.slice(i + 2).match(/^[0-9a-fA-F]{1,2}/))) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      if (d === 'u' && (m = text.slice(i + 2).match(/^[0-9a-fA-F]{1,4}/))) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      if (d === 'U' && (m = text.slice(i + 2).match(/^[0-9a-fA-F]{1,8}/))) { out += String.fromCodePoint(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      out += c + d; i += 2;
    }
    return { text: out, stop: false };
  }

  // Quotes a value so the shell reads it back unchanged (printf %q).
  function shellQuote(value) {
    value = String(value);
    if (value === '') return "''";
    if (/[\x00-\x1f\x7f]/.test(value)) {
      return "$'" + value.replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, function (ch) {
        var named = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\x1b': '\\E' };
        return named[ch] || '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0');
      }) + "'";
    }
    return value.replace(/[^A-Za-z0-9_@%+=:,.\/-]/g, '\\$&');
  }

  // C rounds exact ties to even (printf '%.0f' 2.5 -> 2); JavaScript's
  // toFixed/toExponential round ties up. Detect exact ties and correct them.
  var TIE_TAIL = '5' + '0'.repeat(24);
  function fixedHalfEven(abs, prec) {
    var rounded = abs.toFixed(prec);
    if (prec + 25 > 100) return rounded;
    var longer = abs.toFixed(prec + 25);
    if (longer.slice(-25) !== TIE_TAIL) return rounded;
    var truncated = longer.slice(0, -25).replace(/\.$/, '');
    return Number(truncated.replace('.', '').slice(-1)) % 2 === 0 ? truncated : rounded;
  }
  function exponentialHalfEven(abs, prec) {
    var rounded = abs.toExponential(prec);
    if (prec + 25 > 100) return rounded;
    var parts = abs.toExponential(prec + 25).split('e');
    if (parts[0].slice(-25) !== TIE_TAIL) return rounded;
    var truncated = parts[0].slice(0, -25).replace(/\.$/, '');
    return Number(truncated.replace('.', '').slice(-1)) % 2 === 0 ? truncated + 'e' + parts[1] : rounded;
  }

  // printf engine shared by the printf builtin and awk.
  // Returns { text, errors: [message], stopped }.
  // hooks (awk): { integer(v) -> BigInt, float(v) -> number, string(v), char(v),
  //   noEscapes: format backslashes are literal, noRepeat: no format reuse,
  //   conversions: allowed conversion letters (others are copied literally) }.
  function formatPrintf(format, args, hooks) {
    var out = '', argi = 0, errors = [], stopped = false;
    function nextArg() { return argi < args.length ? (hooks ? args[argi++] : String(args[argi++])) : undefined; }
    function integerArg(raw) {
      if (hooks) return hooks.integer(raw);
      if (raw === undefined) return 0n;
      var s = raw.trim();
      if (/^['"]/.test(s)) return BigInt(s.length > 1 ? s.codePointAt(1) : 0);
      var m = s.match(/^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/);
      if (!m) { if (s !== '') errors.push(raw + ': invalid number'); return 0n; }
      var digits = m[2], value = /^0[xX]/.test(digits) ? BigInt(digits) : /^0[0-7]+$/.test(digits) ? BigInt('0o' + digits.slice(1)) : BigInt(digits);
      if (m[1] === '-') value = -value;
      if (m[0].length !== s.length) errors.push(raw + ': invalid number');
      return value;
    }
    function floatArg(raw) {
      if (hooks) return hooks.float(raw);
      if (raw === undefined) return 0;
      var s = raw.trim();
      if (/^['"]/.test(s)) return s.length > 1 ? s.codePointAt(1) : 0;
      if (/^[+-]?(inf|infinity)$/i.test(s)) return s.charAt(0) === '-' ? -Infinity : Infinity;
      if (/^[+-]?nan$/i.test(s)) return NaN;
      var m = s.match(/^[+-]?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/);
      if (!m) { if (s !== '') errors.push(raw + ': invalid number'); return 0; }
      if (m[0].length !== s.length) errors.push(raw + ': invalid number');
      return /0[xX]/.test(m[0]) ? parseInt(m[0], 16) : Number(m[0]);
    }
    function pad(sign, prefix, body, spec, numeric) {
      var core = sign + prefix + body, width = spec.width || 0;
      if (core.length >= width) return core;
      if (spec.minus) return core + ' '.repeat(width - core.length);
      if (spec.zero && numeric) return sign + prefix + '0'.repeat(width - core.length) + body;
      return ' '.repeat(width - core.length) + core;
    }
    function signOf(negative, spec) { return negative ? '-' : spec.plus ? '+' : spec.space ? ' ' : ''; }
    function formatFloat(value, conv, spec) {
      var upper = conv === conv.toUpperCase(), lower = conv.toLowerCase(), prec = spec.precision == null ? 6 : spec.precision;
      var negative = value < 0 || Object.is(value, -0), abs = Math.abs(value), body;
      if (!isFinite(abs)) body = isNaN(abs) ? 'nan' : 'inf';
      else if (lower === 'f') body = fixedHalfEven(abs, prec);
      else if (lower === 'e') body = exponentialHalfEven(abs, prec);
      else if (lower === 'g' || lower === 'a') {
        var p = prec === 0 ? 1 : prec, exponent = abs === 0 ? 0 : Number(exponentialHalfEven(abs, p - 1).split('e')[1]);
        body = (exponent < -4 || exponent >= p) ? exponentialHalfEven(abs, p - 1) : fixedHalfEven(abs, Math.max(0, p - 1 - exponent));
        // %g drops trailing fractional zeros (never integer zeros).
        if (!spec.alt && body.indexOf('.') >= 0) body = body.replace(/(\.\d*?)0+(e|$)/, '$1$2').replace(/\.(e|$)/, '$1');
      }
      body = body.replace(/e([+-])(\d)$/, 'e$10$2');
      if (spec.alt && lower !== 'g' && body.indexOf('.') < 0 && isFinite(abs)) body = body.replace(/(\d)(e|$)/, '$1.$2');
      if (upper) body = body.toUpperCase();
      if (isNaN(value)) negative = false;
      return pad(signOf(negative, spec), '', body, spec, isFinite(abs));
    }
    function formatOnce() {
      var consumed = false, i = 0;
      while (i < format.length) {
        var c = format[i];
        if (c === '\\' && !(hooks && hooks.noEscapes)) {
          var end = i + 2, m = format.slice(i + 1).match(/^([0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|.)/);
          if (m) end = i + 1 + m[0].length;
          out += decodeEscapes(format.slice(i, end), 'fmt').text; i = end; continue;
        }
        if (c !== '%') { out += c; i++; continue; }
        if (format[i + 1] === '%') { out += '%'; i += 2; continue; }
        var spec = {}, j = i + 1;
        while (j < format.length && "-+ #0'".indexOf(format[j]) >= 0) {
          var f = format[j++];
          if (f === '-') spec.minus = true; else if (f === '+') spec.plus = true; else if (f === ' ') spec.space = true; else if (f === '#') spec.alt = true; else if (f === '0') spec.zero = true;
        }
        if (format[j] === '*') { spec.width = Number(integerArg(nextArg())); consumed = true; j++; if (spec.width < 0) { spec.minus = true; spec.width = -spec.width; } }
        else { var w = format.slice(j).match(/^\d+/); if (w) { spec.width = Number(w[0]); j += w[0].length; } }
        if (format[j] === '.') {
          j++;
          if (format[j] === '*') { spec.precision = Number(integerArg(nextArg())); consumed = true; j++; if (spec.precision < 0) spec.precision = null; }
          else { var pr = format.slice(j).match(/^\d*/)[0]; spec.precision = Number(pr || 0); j += pr.length; }
        }
        while (j < format.length && 'hlLjzt'.indexOf(format[j]) >= 0) j++;
        var conv = format[j];
        if (conv === undefined) { errors.push('%' + format.slice(i + 1) + ': invalid conversion specification'); out += format.slice(i); return { consumed: consumed, done: true }; }
        i = j + 1;
        if (hooks && hooks.conversions.indexOf(conv) < 0) { out += format.slice(format.lastIndexOf('%', j), j + 1); continue; }
        if ('sbqcdiuoxXfFeEgGaA'.indexOf(conv) < 0) { errors.push('`' + conv + "': invalid format character"); return { consumed: consumed, done: true }; }
        var raw = nextArg(); consumed = true;
        if (conv === 's' || conv === 'q' || conv === 'b' || conv === 'c') {
          var value = hooks ? (conv === 'c' ? hooks.char(raw) : hooks.string(raw)) : raw === undefined ? '' : raw;
          if (conv === 'q') value = shellQuote(value);
          if (conv === 'c') value = Array.from(value)[0] || '';
          if (conv === 'b') { var decoded = decodeEscapes(value, 'b'); value = decoded.text; if (decoded.stop) { out += pad('', '', spec.precision != null ? value.slice(0, spec.precision) : value, spec, false); stopped = true; return { consumed: true, done: true }; } }
          if (spec.precision != null && conv !== 'c') value = value.slice(0, spec.precision);
          out += pad('', '', value, spec, false);
          continue;
        }
        if ('diuoxX'.indexOf(conv) >= 0) {
          var n = integerArg(raw), negative = n < 0n;
          if (conv !== 'd' && conv !== 'i' && negative) { n = (1n << 64n) + n; negative = false; }
          var abs = negative ? -n : n;
          var digits = conv === 'o' ? abs.toString(8) : conv === 'x' ? abs.toString(16) : conv === 'X' ? abs.toString(16).toUpperCase() : abs.toString();
          if (spec.precision != null) { digits = digits.padStart(spec.precision, '0'); if (spec.precision === 0 && abs === 0n) digits = ''; }
          var prefix = '';
          if (spec.alt && conv === 'o' && digits.charAt(0) !== '0') prefix = '0';
          if (spec.alt && (conv === 'x' || conv === 'X') && abs !== 0n) prefix = conv === 'x' ? '0x' : '0X';
          var zeroSpec = spec.precision != null ? Object.assign({}, spec, { zero: false }) : spec;
          out += pad((conv === 'd' || conv === 'i') ? signOf(negative, spec) : '', prefix, digits, zeroSpec, true);
          continue;
        }
        out += formatFloat(floatArg(raw), conv, spec);
      }
      return { consumed: consumed, done: false };
    }
    do {
      var pass = formatOnce();
      if (pass.done || stopped || (hooks && hooks.noRepeat)) break;
      if (!pass.consumed) break;
    } while (argi < args.length);
    return { text: out, errors: errors, stopped: stopped };
  }

  // ---- shell builtins -----------------------------------------------------
  function validName(name) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name); }

  builtin('echo', { literalArgs: true }, function (ctx) {
    var args = ctx.args, newline = true, escapes = false, i = 0;
    while (i < args.length && /^-[neE]+$/.test(args[i])) {
      for (var k = 1; k < args[i].length; k++) {
        var f = args[i][k];
        if (f === 'n') newline = false; else if (f === 'e') escapes = true; else escapes = false;
      }
      i++;
    }
    var text = args.slice(i).join(' ');
    if (escapes) {
      var decoded = decodeEscapes(text, 'echo');
      if (decoded.stop) { ctx.stdout.write(decoded.text); return 0; }
      text = decoded.text;
    }
    ctx.stdout.write(text + (newline ? '\n' : ''));
    return 0;
  });

  builtin('printf', { literalArgs: true }, function (ctx) {
    var args = ctx.args.slice(), target = null;
    if (args[0] === '-v') {
      if (args.length < 2) { ctx.error('-v: option requires an argument'); return 2; }
      target = args[1]; args = args.slice(2);
      if (!validName(target)) { ctx.error(quoteName(target) + ': not a valid identifier'); return 2; }
    }
    if (args[0] === '--') args.shift();
    if (!args.length) { ctx.error('usage: printf [-v var] format [arguments]'); return 2; }
    var result = formatPrintf(args[0], args.slice(1));
    if (target) ctx.shell.setVar(target, result.text); else ctx.stdout.write(result.text);
    result.errors.forEach(function (message) { ctx.error(message); });
    return result.errors.length ? 1 : 0;
  });

  // read [-ers] [-a array] [-d delim] [-n|-N nchars] [-p prompt] [-t secs] [-u fd] [name ...]
  builtin('read', { literalArgs: true }, function (ctx) {
    var args = ctx.args, raw = false, arrayName = null, delim = '\n', nchars = null, exact = false, fd = null, names = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (names.length || a.charAt(0) !== '-' || a === '-') { names.push(a); continue; }
      if (a === '--') { names = names.concat(args.slice(i + 1)); break; }
      for (var k = 1; k < a.length; k++) {
        var f = a[k];
        if ('rse'.indexOf(f) >= 0) { if (f === 'r') raw = true; continue; }
        if ('adnNptui'.indexOf(f) < 0) { ctx.error('-' + f + ': invalid option'); ctx.stderr.write('read: usage: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]\n'); return 2; }
        var value = a.slice(k + 1) || args[++i];
        if (value === undefined) { ctx.error('-' + f + ': option requires an argument'); return 2; }
        if (f === 'a') arrayName = value;
        else if (f === 'd') delim = value === '' ? '\0' : value.charAt(0);
        else if (f === 'n' || f === 'N') { nchars = Number(value); exact = f === 'N'; }
        else if (f === 'u') fd = Number(value);
        break;
      }
    }
    var stream = ctx.stdin;
    if (fd != null) {
      var input = ctx.fdInput(fd);
      if (!input) { ctx.error(fd + ': invalid file descriptor: Bad file descriptor'); return 1; }
      stream = input;
    }
    var line = '', status = 0;
    if (nchars != null) {
      var chunk = '';
      while (chunk.length < nchars) {
        var ch = stream.readChars(1);
        if (!ch) { status = 1; break; }
        if (!exact && ch === delim) break;
        if (!raw && ch === '\\' && !exact) { var next = stream.readChars(1); if (next === '\n') continue; chunk += next ? '\\' + next : ''; continue; }
        chunk += ch;
      }
      line = chunk;
    } else {
      var piece = stream.readUntil(delim);
      if (piece === null) status = 1;
      else {
        line = piece.text;
        if (!piece.found) status = 1;
        // Without -r a trailing backslash continues the line.
        while (!raw && piece && piece.found && delim === '\n' && /(^|[^\\])(\\\\)*\\$/.test(line)) {
          line = line.slice(0, -1);
          piece = stream.readUntil(delim);
          if (piece === null) break;
          line += piece.text;
          if (!piece.found) status = 1;
        }
      }
    }
    var ifs = ctx.shell.getVar('IFS');
    if (ifs === undefined) ifs = ' \t\n';
    function unescape(text) { return raw ? text : text.replace(/\\([\s\S])/g, '$1'); }
    if (arrayName) {
      ctx.shell.setArray(arrayName, splitFields(line, ifs).map(unescape));
      return status;
    }
    if (!names.length) { ctx.shell.setVar('REPLY', unescape(line)); return status; }
    // Split into names.length fields; the last name takes the remainder.
    var white = Array.from(ifs).filter(function (c) { return /[ \t\n]/.test(c); }).join('');
    function isIfs(c) { return ifs.indexOf(c) >= 0; }
    function isWhite(c) { return white.indexOf(c) >= 0; }
    var pos = 0;
    while (pos < line.length && isWhite(line[pos])) pos++;
    for (var n = 0; n < names.length; n++) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(names[n])) { ctx.error('`' + names[n] + "': not a valid identifier"); return 1; }
      if (n === names.length - 1) {
        var rest = line.slice(pos), end = rest.length;
        while (end > 0 && isWhite(rest[end - 1]) && rest[end - 2] !== '\\') end--;
        ctx.shell.setVar(names[n], unescape(rest.slice(0, end)));
        break;
      }
      var start = pos;
      while (pos < line.length && !isIfs(line[pos])) { if (!raw && line[pos] === '\\') pos++; pos++; }
      ctx.shell.setVar(names[n], unescape(line.slice(start, pos)));
      while (pos < line.length && isWhite(line[pos])) pos++;
      if (pos < line.length && isIfs(line[pos]) && !isWhite(line[pos])) { pos++; while (pos < line.length && isWhite(line[pos])) pos++; }
    }
    return status;
  });

  builtin('cd', { usage: '[-L|-P] [dir]' }, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'LPe@' }), operands = o.operands;
    if (operands.length > 1) { ctx.error('too many arguments'); return 1; }
    var target = operands[0], printDir = false;
    if (target === undefined) {
      target = ctx.shell.getVar('HOME');
      if (target == null) { ctx.error('HOME not set'); return 1; }
    } else if (target === '-') {
      target = ctx.shell.getVar('OLDPWD');
      if (target == null) { ctx.error('OLDPWD not set'); return 1; }
      printDir = true;
    }
    if (target === '') return 0;
    var candidates = [ctx.resolve(target)];
    var cdpath = ctx.shell.getVar('CDPATH');
    if (cdpath && target.charAt(0) !== '/' && !/^\.\.?(\/|$)/.test(target)) {
      candidates = cdpath.split(':').map(function (dir) { return resolvePath(ctx.resolve(dir || '.'), target); }).concat(candidates);
    }
    for (var i = 0; i < candidates.length; i++) {
      var st = await ctx.vfs.stat(candidates[i]);
      if (st && st.type === 'dir') {
        if (i < candidates.length - 1) printDir = true;
        ctx.shell.setCwd(candidates[i]);
        if (printDir) ctx.stdout.write(candidates[i] + '\n');
        return 0;
      }
    }
    var last = await ctx.vfs.stat(candidates[candidates.length - 1]);
    ctx.error(target + ': ' + (last ? 'Not a directory' : 'No such file or directory'));
    return 1;
  });

  builtin('pwd', { usage: '[-LP]' }, function (ctx) {
    getopt(ctx.args, { flags: 'LP' });
    ctx.stdout.write(ctx.cwd + '\n');
    return 0;
  });

  builtin('export', { usage: '[-fn] [name[=value] ...] or export -p' }, function (ctx) {
    var o = getopt(ctx.args, { flags: 'fnp' }), status = 0;
    if (!o.operands.length) {
      ctx.shell.vars().filter(validName).sort().forEach(function (name) {
        ctx.stdout.write('declare -x ' + name + '="' + String(ctx.shell.getVar(name)).replace(/["\\$`]/g, '\\$&') + '"\n');
      });
      return 0;
    }
    o.operands.forEach(function (item) {
      var at = item.indexOf('='), name = at < 0 ? item : item.slice(0, at);
      if (!validName(name)) { ctx.error(quoteName(item) + ': not a valid identifier'); status = 1; return; }
      if (at >= 0 && !o.has('n')) ctx.shell.setVar(name, item.slice(at + 1));
      if (ctx.shell.markExported) ctx.shell.markExported(name, !o.has('n'));
    });
    return status;
  });

  builtin('unset', { usage: '[-f] [-v] [-n] [name ...]' }, function (ctx) {
    var o = getopt(ctx.args, { flags: 'fvn' }), status = 0;
    o.operands.forEach(function (name) {
      if (!validName(name)) { ctx.error(quoteName(name) + ': not a valid identifier'); status = 1; return; }
      ctx.shell.unsetVar(name);
    });
    return status;
  });

  builtin('exit', { usage: '[n]', literalArgs: true }, function (ctx) {
    if (ctx.args.length > 1) { ctx.error('too many arguments'); return 1; }
    if (!ctx.args.length) throw new ExitSignal(ctx.shell.lastStatus);
    if (!/^[+-]?\d+$/.test(ctx.args[0].trim())) { ctx.error(ctx.args[0] + ': numeric argument required'); throw new ExitSignal(2); }
    throw new ExitSignal(((Number(ctx.args[0]) % 256) + 256) % 256);
  });

  builtin('true', { literalArgs: true }, function () { return 0; });
  builtin(':', { literalArgs: true }, function () { return 0; });
  builtin('false', { literalArgs: true }, function () { return 1; });

  // test / [ — POSIX argument-count rules, falling back to a full parser.
  async function evaluateTest(ctx, args) {
    var unary = ['-e', '-f', '-d', '-s', '-r', '-w', '-x', '-z', '-n', '-b', '-c', '-p', '-S', '-L', '-h', '-g', '-u', '-k', '-t', '-O', '-G', '-N', '-v', '-a'];
    var binary = ['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef'];
    function integer(value) {
      var s = String(value).trim();
      if (!/^[+-]?\d+$/.test(s)) throw new UsageError(value + ': integer expected');
      return BigInt(s);
    }
    async function stat(p) { return ctx.vfs.stat(ctx.resolve(p)); }
    async function unaryOp(op, operand) {
      if (op === '-z') return operand === '';
      if (op === '-n') return operand !== '';
      if (op === '-v') return ctx.shell.getVar(operand) != null;
      if (op === '-t') return false;
      var st = operand === '' ? null : await stat(operand);
      switch (op) {
        case '-e': case '-a': return !!st;
        case '-f': return !!st && st.type === 'file';
        case '-d': return !!st && st.type === 'dir';
        case '-s': return !!st && st.size > 0;
        case '-r': case '-w': return !!st;
        case '-x': return !!st && (st.type === 'dir' || (st.mode != null && (st.mode & 73) !== 0));
        default: return false;
      }
    }
    async function binaryOp(left, op, right) {
      switch (op) {
        case '=': case '==': return left === right;
        case '!=': return left !== right;
        case '<': return left < right;
        case '>': return left > right;
        case '-eq': return integer(left) === integer(right);
        case '-ne': return integer(left) !== integer(right);
        case '-lt': return integer(left) < integer(right);
        case '-le': return integer(left) <= integer(right);
        case '-gt': return integer(left) > integer(right);
        case '-ge': return integer(left) >= integer(right);
        case '-ef': return ctx.resolve(left) === ctx.resolve(right) && !!(await stat(left));
        case '-nt': case '-ot': {
          var a = await stat(left), b = await stat(right);
          var ta = a ? +new Date(a.mtime || 0) : -Infinity, tb = b ? +new Date(b.mtime || 0) : -Infinity;
          if (!a && !b) return false;
          return op === '-nt' ? (a && (!b || ta > tb)) : (b && (!a || ta < tb));
        }
      }
      return false;
    }
    var pos = 0;
    async function orExpr() { var v = await andExpr(); while (args[pos] === '-o') { pos++; var r = await andExpr(); v = v || r; } return v; }
    async function andExpr() { var v = await notExpr(); while (args[pos] === '-a') { pos++; var r = await notExpr(); v = v && r; } return v; }
    async function notExpr() { if (args[pos] === '!') { pos++; return !(await notExpr()); } return primary(); }
    async function primary() {
      if (pos >= args.length) throw new UsageError('argument expected');
      if (args[pos] === '(') {
        pos++; var v = await orExpr();
        if (args[pos] !== ')') throw new UsageError("`)' expected");
        pos++; return v;
      }
      if (binary.indexOf(args[pos + 1]) >= 0 && pos + 2 < args.length) { var l = args[pos], op = args[pos + 1], r = args[pos + 2]; pos += 3; return binaryOp(l, op, r); }
      if (unary.indexOf(args[pos]) >= 0 && pos + 1 < args.length) { var u = args[pos], operand = args[pos + 1]; pos += 2; return unaryOp(u, operand); }
      return args[pos++] !== '';
    }
    var n = args.length;
    if (n === 0) return false;
    if (n === 1) return args[0] !== '';
    if (n === 2) {
      if (args[0] === '!') return args[1] === '';
      if (unary.indexOf(args[0]) >= 0) return unaryOp(args[0], args[1]);
      throw new UsageError(args[0] + ': unary operator expected');
    }
    if (n === 3) {
      if (binary.indexOf(args[1]) >= 0) return binaryOp(args[0], args[1], args[2]);
      if (args[1] === '-a') return args[0] !== '' && args[2] !== '';
      if (args[1] === '-o') return args[0] !== '' || args[2] !== '';
      if (args[0] === '!') return !(await evaluateTest(ctx, args.slice(1)));
      if (args[0] === '(' && args[2] === ')') return args[1] !== '';
      throw new UsageError(args[1] + ': binary operator expected');
    }
    if (n === 4) {
      if (args[0] === '!') return !(await evaluateTest(ctx, args.slice(1)));
      if (args[0] === '(' && args[3] === ')') return evaluateTest(ctx, args.slice(1, 3));
    }
    var value = await orExpr();
    if (pos < args.length) throw new UsageError(args[pos] + ': too many arguments');
    return value;
  }
  async function runTest(ctx, args) {
    try { return (await evaluateTest(ctx, args)) ? 0 : 1; }
    catch (e) { if (e instanceof UsageError) { ctx.error(e.message); return 2; } throw e; }
  }
  builtin('test', { literalArgs: true }, function (ctx) { return runTest(ctx, ctx.args); });
  builtin('[', { literalArgs: true }, function (ctx) {
    if (ctx.args[ctx.args.length - 1] !== ']') { ctx.error("missing `]'"); return 2; }
    return runTest(ctx, ctx.args.slice(0, -1));
  });

  // ---- file utilities -----------------------------------------------------
  utility('cat', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'AbeEnstTuv', long: { 'show-all': 'A', 'number-nonblank': 'b', 'show-ends': 'E', number: 'n', 'squeeze-blank': 's', 'show-tabs': 'T', 'show-nonprinting': 'v' } });
    var showEnds = o.has('E') || o.has('A') || o.has('e'), showTabs = o.has('T') || o.has('A') || o.has('t');
    var nonPrinting = o.has('v') || o.has('A') || o.has('e') || o.has('t');
    var numberAll = o.has('n'), numberNonBlank = o.has('b'), squeeze = o.has('s');
    var plain = !showEnds && !showTabs && !nonPrinting && !numberAll && !numberNonBlank && !squeeze;
    var lineNo = 0, previousBlank = false;
    function visible(text) {
      return text.replace(/[\x00-\x08\x0b-\x1f\x7f]|\t/g, function (ch) {
        if (ch === '\t') return showTabs ? '^I' : ch;
        if (!nonPrinting) return ch;
        return ch === '\x7f' ? '^?' : '^' + String.fromCharCode(ch.charCodeAt(0) + 64);
      });
    }
    return forEachInput(ctx, o.operands, function (text) {
      if (plain) { ctx.stdout.write(text); return; }
      var out = '';
      records(text).forEach(function (record) {
        var ended = record.charAt(record.length - 1) === '\n', body = ended ? record.slice(0, -1) : record;
        var blank = body === '' && ended;
        if (squeeze && blank && previousBlank) return;
        previousBlank = blank;
        if (numberNonBlank ? body !== '' : numberAll) out += String(++lineNo).padStart(6) + '\t';
        out += visible(body) + (ended ? (showEnds ? '$' : '') + '\n' : '');
      });
      ctx.stdout.write(out);
    });
  });

  utility('tee', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'aip', long: { append: 'a', 'ignore-interrupts': 'i' } });
    var data = ctx.stdin.readAll(), status = 0;
    ctx.stdout.write(data);
    for (var i = 0; i < o.operands.length; i++) {
      try { await ctx.vfs.writeFile(ctx.resolve(o.operands[i]), data, { append: o.has('a') }); }
      catch (e) { ctx.error(o.operands[i] + ': ' + errorReason(e)); status = 1; }
    }
    return status;
  });

  utility('touch', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'acfhm', params: 'drt', long: { 'no-create': 'c', date: { key: 'd', arg: true }, reference: { key: 'r', arg: true } } });
    if (!o.operands.length) throw new UsageError('missing file operand');
    var status = 0;
    for (var i = 0; i < o.operands.length; i++) {
      var path = ctx.resolve(o.operands[i]);
      try {
        var st = await ctx.vfs.stat(path);
        if (!st && !o.has('c')) await ctx.vfs.writeFile(path, '', { append: true });
        // Existing files are left untouched: the host contract has no way to set mtime.
      } catch (e) { ctx.error('cannot touch ' + quoteName(o.operands[i]) + ': ' + errorReason(e)); status = 1; }
    }
    return status;
  });

  utility('mkdir', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'pv', params: 'm', long: { parents: 'p', verbose: 'v', mode: { key: 'm', arg: true } } });
    if (!o.operands.length) throw new UsageError('missing operand');
    var status = 0;
    for (var i = 0; i < o.operands.length; i++) {
      var operand = o.operands[i], path = ctx.resolve(operand);
      try {
        if (o.has('p')) {
          // Walk the operand's own components so -v reports them as typed.
          var comps = operand.split('/'), shown = '', current = operand.charAt(0) === '/' ? '/' : ctx.cwd;
          for (var k = 0; k < comps.length; k++) {
            shown = k === 0 ? comps[k] : shown + '/' + comps[k];
            if (comps[k] === '' || comps[k] === '.') continue;
            current = resolvePath(current, comps[k]);
            var st = await ctx.vfs.stat(current);
            var isLast = comps.slice(k + 1).every(function (c) { return c === '' || c === '.'; });
            if (st && st.type !== 'dir') throw new ShellError('File exists', isLast ? 'EEXIST' : 'ENOTDIR');
            if (!st) {
              await ctx.vfs.mkdir(current);
              if (o.has('v')) ctx.stdout.write('mkdir: created directory ' + quoteName(shown) + '\n');
            }
          }
          continue;
        }
        if (await ctx.vfs.stat(path)) throw new ShellError('File exists', 'EEXIST');
        var parent = await ctx.vfs.stat(dirname(path));
        if (!parent) throw new ShellError('No such file or directory', 'ENOENT');
        if (parent.type !== 'dir') throw new ShellError('Not a directory', 'ENOTDIR');
        await ctx.vfs.mkdir(path);
        if (o.has('v')) ctx.stdout.write('mkdir: created directory ' + quoteName(operand) + '\n');
      } catch (e) {
        ctx.error('cannot create directory ' + quoteName(operand) + ': ' + (e.code === 'EEXIST' ? 'File exists' : errorReason(e)));
        status = 1;
      }
    }
    return status;
  });

  utility('rm', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'fiIrRdv', long: { force: 'f', interactive: { key: 'i', arg: 'optional' }, recursive: 'r', dir: 'd', verbose: 'v', 'no-preserve-root': 'npr', 'preserve-root': { key: 'pr', arg: 'optional' } } });
    var force = o.last(['f', 'i', 'I']) === 'f', recursive = o.has('r') || o.has('R'), verbose = o.has('v');
    if (!o.operands.length) { if (force) return 0; throw new UsageError('missing operand'); }
    var status = 0;
    async function removeTree(path, shown) {
      var st = await ctx.vfs.stat(path);
      if (st && st.type === 'dir') {
        var children = await ctx.vfs.readDir(path);
        for (var i = 0; i < children.length; i++) await removeTree(resolvePath(path, children[i].name), shown.replace(/\/$/, '') + '/' + children[i].name);
        await ctx.vfs.remove(path, {});
        ctx.stdout.write('removed directory ' + quoteName(shown) + '\n');
      } else {
        await ctx.vfs.remove(path, {});
        ctx.stdout.write('removed ' + quoteName(shown) + '\n');
      }
    }
    for (var i = 0; i < o.operands.length; i++) {
      var operand = o.operands[i], path = ctx.resolve(operand);
      if (recursive && /(^|\/)\.\.?\/*$/.test(operand)) { ctx.error("refusing to remove '.' or '..' directory: skipping " + quoteName(operand)); status = 1; continue; }
      if (path === '/' && recursive && !o.has('npr')) { ctx.error("it is dangerous to operate recursively on '/'"); ctx.error('use --no-preserve-root to override this failsafe'); status = 1; continue; }
      try {
        var st = await ctx.vfs.stat(path);
        if (!st) { if (!force) { ctx.error('cannot remove ' + quoteName(operand) + ': No such file or directory'); status = 1; } continue; }
        if (st.type === 'dir') {
          if (!recursive) {
            var empty = !(await ctx.vfs.readDir(path)).length;
            if (!o.has('d')) { ctx.error('cannot remove ' + quoteName(operand) + ': Is a directory'); status = 1; continue; }
            if (!empty) { ctx.error('cannot remove ' + quoteName(operand) + ': Directory not empty'); status = 1; continue; }
            await ctx.vfs.remove(path, {});
            if (verbose) ctx.stdout.write('removed directory ' + quoteName(operand) + '\n');
            continue;
          }
          if (verbose) await removeTree(path, operand);
          else await ctx.vfs.remove(path, { recursive: true });
          continue;
        }
        await ctx.vfs.remove(path, {});
        if (verbose) ctx.stdout.write('removed ' + quoteName(operand) + '\n');
      } catch (e) { ctx.error('cannot remove ' + quoteName(operand) + ': ' + errorReason(e)); status = 1; }
    }
    return status;
  });

  utility('mv', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'bfinTuvZ', params: 'St', long: { force: 'f', interactive: 'i', 'no-clobber': 'n', 'no-target-directory': 'T', 'target-directory': { key: 't', arg: true }, update: { key: 'u', arg: 'optional' }, verbose: 'v', backup: { key: 'b', arg: 'optional' }, suffix: { key: 'S', arg: true } } });
    var operands = o.operands, targetDir = o.get('t'), noClobber = o.last(['f', 'i', 'n']) === 'n', status = 0;
    if (!operands.length) throw new UsageError('missing file operand');
    var pairs = [];
    if (targetDir != null) {
      var tst = await ctx.vfs.stat(ctx.resolve(targetDir));
      if (!tst) { ctx.error('target directory ' + quoteName(targetDir) + ': No such file or directory'); return 1; }
      if (tst.type !== 'dir') { ctx.error('target ' + quoteName(targetDir) + ' is not a directory'); return 1; }
      operands.forEach(function (src) { pairs.push([src, targetDir.replace(/\/+$/, '') + '/' + basename(src)]); });
    } else {
      if (operands.length === 1) throw new UsageError('missing destination file operand after ' + quoteName(operands[0]));
      var dest = operands[operands.length - 1], dst = await ctx.vfs.stat(ctx.resolve(dest));
      if (o.has('T')) {
        if (operands.length > 2) throw new UsageError('extra operand ' + quoteName(operands[2]));
        pairs.push([operands[0], dest]);
      } else if (operands.length > 2 || (dst && dst.type === 'dir')) {
        if (!dst || dst.type !== 'dir') { ctx.error('target ' + quoteName(dest) + ' is not a directory'); return 1; }
        operands.slice(0, -1).forEach(function (src) { pairs.push([src, dest.replace(/\/+$/, '') + '/' + basename(src)]); });
      } else pairs.push([operands[0], dest]);
    }
    for (var i = 0; i < pairs.length; i++) {
      var srcName = pairs[i][0], dstName = pairs[i][1], src = ctx.resolve(srcName), target = ctx.resolve(dstName);
      try {
        var sst = await ctx.vfs.stat(src);
        if (!sst) { ctx.error('cannot stat ' + quoteName(srcName) + ': No such file or directory'); status = 1; continue; }
        if (src === target) { ctx.error(quoteName(srcName) + ' and ' + quoteName(dstName) + ' are the same file'); status = 1; continue; }
        if (sst.type === 'dir' && target.indexOf(src === '/' ? '/' : src + '/') === 0) { ctx.error('cannot move ' + quoteName(srcName) + ' to a subdirectory of itself, ' + quoteName(dstName)); status = 1; continue; }
        var tst2 = await ctx.vfs.stat(target);
        if (tst2) {
          if (noClobber) continue;
          if (o.has('u') && tst2.mtime != null && sst.mtime != null && +new Date(tst2.mtime) >= +new Date(sst.mtime)) continue;
          if (tst2.type === 'dir' && sst.type !== 'dir') { ctx.error('cannot overwrite directory ' + quoteName(dstName) + ' with non-directory'); status = 1; continue; }
          if (tst2.type !== 'dir' && sst.type === 'dir') { ctx.error('cannot overwrite non-directory ' + quoteName(dstName) + ' with directory ' + quoteName(srcName)); status = 1; continue; }
          if (tst2.type === 'dir' && (await ctx.vfs.readDir(target)).length) { ctx.error('cannot move ' + quoteName(srcName) + ' to ' + quoteName(dstName) + ': Directory not empty'); status = 1; continue; }
          // Remove the replaced entry first so hosts need not implement overwrite.
          await ctx.vfs.remove(target, {});
        }
        await ctx.vfs.rename(src, target);
        if (o.has('v')) ctx.stdout.write('renamed ' + quoteName(srcName) + ' -> ' + quoteName(dstName) + '\n');
      } catch (e) { ctx.error('cannot move ' + quoteName(srcName) + ' to ' + quoteName(dstName) + ': ' + errorReason(e)); status = 1; }
    }
    return status;
  });

  // POSIX dirname/basename work on the string, not the file system.
  function posixDirname(p) {
    if (p === '') return '.';
    var t = p.replace(/\/+$/, '');
    if (t === '') return /^\/\/$/.test(p) ? '//' : '/';
    var at = t.lastIndexOf('/');
    if (at < 0) return '.';
    t = t.slice(0, at).replace(/\/+$/, '');
    return t === '' ? '/' : t;
  }
  function posixBasename(p, suffix) {
    if (p === '') return '';
    var t = p.replace(/\/+$/, '');
    if (t === '') return '/';
    t = t.slice(t.lastIndexOf('/') + 1);
    if (suffix && t !== suffix && t.slice(-suffix.length) === suffix) t = t.slice(0, -suffix.length);
    return t;
  }
  utility('dirname', { usage: '[OPTION] NAME...' }, function (ctx) {
    var o = getopt(ctx.args, { flags: 'z', long: { zero: 'z' } });
    if (!o.operands.length) throw new UsageError('missing operand');
    var end = o.has('z') ? '\0' : '\n';
    ctx.stdout.write(o.operands.map(function (p) { return posixDirname(p) + end; }).join(''));
    return 0;
  });
  utility('basename', { usage: 'NAME [SUFFIX]' }, function (ctx) {
    var o = getopt(ctx.args, { flags: 'az', params: 's', long: { multiple: 'a', suffix: { key: 's', arg: true }, zero: 'z' } });
    if (!o.operands.length) throw new UsageError('missing operand');
    var suffix = o.get('s'), names = o.operands, end = o.has('z') ? '\0' : '\n';
    if (!o.has('a') && suffix == null) {
      if (names.length > 2) throw new UsageError('extra operand ' + quoteName(names[2]));
      suffix = names[1]; names = [names[0]];
    }
    ctx.stdout.write(names.map(function (p) { return posixBasename(p, suffix) + end; }).join(''));
    return 0;
  });

  // ---- ls -------------------------------------------------------------------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function compareBytes(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function humanSize(n) {
    if (n < 1024) return String(n);
    var units = ['K', 'M', 'G', 'T', 'P', 'E'], value = n, u = -1;
    do { value /= 1024; u++; } while (value >= 1024 && u < units.length - 1);
    return (value < 10 ? (Math.ceil(value * 10) / 10).toFixed(1) : String(Math.ceil(value))) + units[u];
  }
  function modeString(type, mode) {
    if (mode == null) mode = type === 'dir' ? 493 : 420; // 0755 / 0644
    var out = type === 'dir' ? 'd' : '-', chars = 'rwxrwxrwx';
    for (var i = 0; i < 9; i++) out += (mode & (256 >> i)) ? chars[i] : '-';
    return out;
  }

  utility('ls', { usageCode: 2 }, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'aAlh1RdFprtSXUCmQgonGicfL', long: { all: 'a', 'almost-all': 'A', 'human-readable': 'h', recursive: 'R', directory: 'd', classify: { key: 'F', arg: 'optional' }, reverse: 'r', 'quote-name': 'Q', color: { key: 'color', arg: 'optional' }, 'group-directories-first': 'gdf', 'indicator-style': { key: 'is', arg: true }, sort: { key: 'sort', arg: true }, 'full-time': 'ft' } });
    var showAll = o.has('a') || o.has('f'), almostAll = o.has('A'), long = o.has('l') || o.has('g') || o.has('o') || o.has('n');
    var sortKey = o.has('f') || o.has('U') ? 'none' : o.last(['t', 'S', 'X']) || 'name';
    if (o.get('sort')) sortKey = { time: 't', size: 'S', extension: 'X', none: 'none', name: 'name' }[o.get('sort')] || 'name';
    var reverse = o.has('r'), classify = o.has('F'), slash = o.has('p') || classify;
    var now = ctx.now(), status = 0, out = '';
    function sortEntries(entries) {
      if (sortKey === 'none') return entries;
      entries.sort(function (a, b) {
        var r = 0;
        if (sortKey === 't') r = (+new Date(b.st.mtime || 0)) - (+new Date(a.st.mtime || 0));
        else if (sortKey === 'S') r = (b.st.size || 0) - (a.st.size || 0);
        else if (sortKey === 'X') { var ea = a.name.match(/\.[^.]*$/), eb = b.name.match(/\.[^.]*$/); r = compareBytes(ea ? ea[0] : '', eb ? eb[0] : ''); }
        return r || compareBytes(a.name, b.name);
      });
      if (o.has('gdf')) entries.sort(function (a, b) { return (b.st.type === 'dir') - (a.st.type === 'dir'); });
      if (reverse) entries.reverse();
      return entries;
    }
    function suffix(entry) {
      if (entry.st.type === 'dir' && slash) return '/';
      if (classify && entry.st.type !== 'dir' && entry.st.mode != null && (entry.st.mode & 73)) return '*';
      return '';
    }
    function nameOf(entry) { return (o.has('Q') ? '"' + entry.name + '"' : entry.name) + suffix(entry); }
    function dateOf(st) {
      var d = st.mtime != null ? new Date(st.mtime) : now;
      var recent = Math.abs(+now - +d) < 15778476000;
      return MONTHS[d.getMonth()] + ' ' + String(d.getDate()).padStart(2) + ' ' + (recent ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ' ' + d.getFullYear());
    }
    function render(entries, withTotal) {
      if (!long) {
        if (o.has('m')) return entries.length ? entries.map(nameOf).join(', ') + '\n' : '';
        return entries.map(function (e) { return nameOf(e) + '\n'; }).join('');
      }
      var user = o.has('n') ? '1000' : (ctx.env.USER || 'user'), rows = entries.map(function (e) {
        var size = e.st.type === 'dir' ? 4096 : (e.st.size || 0);
        return { mode: modeString(e.st.type, e.st.mode), links: e.st.type === 'dir' ? '2' : '1', size: o.has('h') ? humanSize(size) : String(size), date: dateOf(e.st), name: nameOf(e), blocks: Math.ceil(size / 4096) * 4 };
      });
      var linkW = Math.max.apply(null, rows.map(function (r) { return r.links.length; }).concat([1]));
      var sizeW = Math.max.apply(null, rows.map(function (r) { return r.size.length; }).concat([1]));
      var text = withTotal ? 'total ' + (o.has('h') ? humanSize(rows.reduce(function (s, r) { return s + r.blocks; }, 0) * 1024) : rows.reduce(function (s, r) { return s + r.blocks; }, 0)) + '\n' : '';
      rows.forEach(function (r) {
        var owner = (o.has('g') ? '' : user + ' ') + (o.has('o') || o.has('G') ? '' : user + ' ');
        text += r.mode + ' ' + r.links.padStart(linkW) + ' ' + owner + r.size.padStart(sizeW) + ' ' + r.date + ' ' + r.name + '\n';
      });
      return text;
    }
    async function listDirectory(path, shown) {
      var children = await ctx.vfs.readDir(path), entries = [];
      if (showAll) {
        entries.push({ name: '.', path: path, st: await ctx.vfs.stat(path) || { type: 'dir' } });
        entries.push({ name: '..', path: dirname(path), st: await ctx.vfs.stat(dirname(path)) || { type: 'dir' } });
      }
      for (var i = 0; i < children.length; i++) {
        var name = children[i].name;
        if (name.charAt(0) === '.' && !showAll && !almostAll) continue;
        var childPath = resolvePath(path, name);
        var st = (long || sortKey !== 'name' || slash || o.has('R') || !children[i].type) ? await ctx.vfs.stat(childPath) : { type: children[i].type };
        entries.push({ name: name, path: childPath, st: st || { type: children[i].type || 'file' } });
      }
      return sortEntries(entries);
    }
    var operands = o.operands.length ? o.operands : ['.'], files = [], dirs = [];
    for (var i = 0; i < operands.length; i++) {
      var st = await ctx.vfs.stat(ctx.resolve(operands[i]));
      if (!st) { ctx.error('cannot access ' + quoteName(operands[i]) + ': No such file or directory'); status = 2; continue; }
      var entry = { name: operands[i], path: ctx.resolve(operands[i]), st: st };
      if (st.type === 'dir' && !o.has('d')) dirs.push(entry); else files.push(entry);
    }
    sortEntries(files); sortEntries(dirs);
    out += render(files, false);
    var showHeaders = files.length + dirs.length > 1 || o.has('R') || status !== 0;
    var first = !files.length;
    async function emitDir(path, shown) {
      var entries;
      try { entries = await listDirectory(path, shown); }
      catch (e) { ctx.error('cannot open directory ' + quoteName(shown) + ': ' + errorReason(e)); status = 2; return; }
      out += (first ? '' : '\n') + (showHeaders ? shown + ':\n' : '') + render(entries, true);
      first = false;
      if (o.has('R')) {
        for (var k = 0; k < entries.length; k++) {
          if (entries[k].st.type !== 'dir' || entries[k].name === '.' || entries[k].name === '..') continue;
          await emitDir(entries[k].path, shown.replace(/\/$/, '') + '/' + entries[k].name);
        }
      }
    }
    for (var d = 0; d < dirs.length; d++) await emitDir(dirs[d].path, dirs[d].name);
    ctx.stdout.write(out);
    return status;
  });

  // ---- head / tail ----------------------------------------------------------
  function sliceBytes(text, start, end) { return decodeBytes(toBytes(text).slice(start, end)); }
  function cannotOpen(operand, error) {
    return error && error.code === 'ENOENT' ? 'cannot open ' + quoteName(operand) + ' for reading: No such file or directory' : 'error reading ' + quoteName(operand) + ': ' + errorReason(error);
  }

  utility('head', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'qvz', params: 'nc', numeric: true, long: { lines: { key: 'n', arg: true }, bytes: { key: 'c', arg: true }, quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z' } });
    var mode = 'n', count = { sign: '', value: 10 }, sep = o.has('z') ? '\0' : '\n';
    o.list.forEach(function (p) {
      if (p[0] === 'n' || p[0] === '#') { mode = 'n'; count = parseCount(p[1], 'lines'); }
      if (p[0] === 'c') { mode = 'c'; count = parseCount(p[1], 'bytes'); }
    });
    var headers = o.has('v') || (o.operands.length > 1 && !o.has('q')), first = true;
    return forEachInput(ctx, o.operands, function (text, name) {
      var out = headers ? (first ? '' : '\n') + '==> ' + displayInput(name) + ' <==\n' : '';
      first = false;
      if (mode === 'c') {
        var size = toBytes(text).length;
        out += count.sign === '-' ? sliceBytes(text, 0, Math.max(0, size - count.value)) : sliceBytes(text, 0, count.value);
      } else {
        var recs = records(text, sep);
        out += (count.sign === '-' ? recs.slice(0, Math.max(0, recs.length - count.value)) : recs.slice(0, count.value)).join('');
      }
      ctx.stdout.write(out);
    }, cannotOpen);
  });

  utility('tail', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'qvzfF', params: 'ncs', numeric: true, long: { lines: { key: 'n', arg: true }, bytes: { key: 'c', arg: true }, quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z', follow: { key: 'f', arg: 'optional' }, retry: 'retry', pid: { key: 'pid', arg: true }, 'sleep-interval': { key: 's', arg: true } } });
    var mode = 'n', count = { sign: '', value: 10 }, sep = o.has('z') ? '\0' : '\n';
    o.list.forEach(function (p) {
      if (p[0] === 'n' || p[0] === '#') { mode = 'n'; count = parseCount(p[1], 'lines'); }
      if (p[0] === 'c') { mode = 'c'; count = parseCount(p[1], 'bytes'); }
    });
    // Streams are finite here, so -f simply prints the current contents.
    var headers = o.has('v') || (o.operands.length > 1 && !o.has('q')), first = true;
    return forEachInput(ctx, o.operands, function (text, name) {
      var out = headers ? (first ? '' : '\n') + '==> ' + displayInput(name) + ' <==\n' : '';
      first = false;
      if (mode === 'c') {
        var size = toBytes(text).length;
        out += count.sign === '+' ? sliceBytes(text, Math.max(0, count.value - 1)) : sliceBytes(text, Math.max(0, size - count.value));
      } else {
        var recs = records(text, sep);
        out += (count.sign === '+' ? recs.slice(Math.max(0, count.value - 1)) : recs.slice(Math.max(0, recs.length - count.value))).join('');
      }
      ctx.stdout.write(out);
    }, cannotOpen);
  });

  // ---- wc ---------------------------------------------------------------------
  utility('wc', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'clLmw', long: { bytes: 'c', chars: 'm', lines: 'l', 'max-line-length': 'L', words: 'w', 'files0-from': { key: 'files0', arg: true }, total: { key: 'total', arg: true } } });
    var want = { l: o.has('l'), w: o.has('w'), m: o.has('m'), c: o.has('c'), L: o.has('L') };
    if (!want.l && !want.w && !want.m && !want.c && !want.L) want = { l: true, w: true, c: true };
    var order = ['l', 'w', 'm', 'c', 'L'].filter(function (k) { return want[k]; });
    var results = [], totals = { l: 0, w: 0, m: 0, c: 0, L: 0 }, usesStdin = false;
    var status = await forEachInput(ctx, o.operands, function (text, name) {
      if (name === '-') usesStdin = true;
      var counts = { l: 0, w: 0, m: Array.from(text).length, c: toBytes(text).length, L: 0 };
      counts.l = (text.match(/\n/g) || []).length;
      counts.w = (text.match(/[^\s]+/g) || []).length;
      lines(text).forEach(function (line) {
        var width = 0;
        Array.from(line).forEach(function (ch) { width = ch === '\t' ? width + 8 - (width % 8) : width + 1; });
        if (width > counts.L) counts.L = width;
      });
      ['l', 'w', 'm', 'c'].forEach(function (k) { totals[k] += counts[k]; });
      totals.L = Math.max(totals.L, counts.L);
      results.push({ name: o.operands.length ? name : null, counts: counts });
    });
    // The total line depends on the operand count, even if some failed to open.
    var showTotal = o.get('total') === 'always' || (o.get('total') !== 'never' && o.get('total') !== 'only' && o.operands.length > 1);
    // GNU pads every column to the width of the total byte count (7 for stdin),
    // except when a single count of a single input is printed.
    var width = (order.length === 1 && results.length + (showTotal ? 1 : 0) <= 1) ? 1 : Math.max(String(totals.c).length, usesStdin ? 7 : 1);
    function row(counts, name) { return order.map(function (k) { return String(counts[k]).padStart(width); }).join(' ') + (name != null ? ' ' + name : '') + '\n'; }
    var out = '';
    if (o.get('total') !== 'only') results.forEach(function (r) { out += row(r.counts, r.name); });
    if (showTotal) out += row(totals, 'total');
    else if (o.get('total') === 'only') out += order.map(function (k) { return String(totals[k]); }).join(' ') + '\n';
    ctx.stdout.write(out);
    return status;
  });

  // ---- nl -----------------------------------------------------------------------
  utility('nl', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'p', params: 'bdfhilnsvwz', long: { 'body-numbering': { key: 'b', arg: true }, 'section-delimiter': { key: 'd', arg: true }, 'footer-numbering': { key: 'f', arg: true }, 'header-numbering': { key: 'h', arg: true }, 'line-increment': { key: 'i', arg: true }, 'join-blank-lines': { key: 'l', arg: true }, 'number-format': { key: 'n', arg: true }, 'no-renumber': 'p', 'number-separator': { key: 's', arg: true }, 'starting-line-number': { key: 'v', arg: true }, 'number-width': { key: 'w', arg: true } } });
    var style = o.get('b') || 't', format = o.get('n') || 'rn', width = Number(o.get('w') || 6), separator = o.get('s') != null ? o.get('s') : '\t';
    var number = Number(o.get('v') || 1), increment = Number(o.get('i') || 1);
    if (!/^(a|t|n|p.+)$/.test(style)) throw new UsageError('invalid body numbering style: ' + quoteName(style));
    if (['ln', 'rn', 'rz'].indexOf(format) < 0) throw new UsageError('invalid line numbering format: ' + quoteName(format));
    var pattern = style.charAt(0) === 'p' ? new RegExp(translateRegex(style.slice(1), 'BRE')) : null;
    var blankPad = ' '.repeat(width + separator.length);
    return forEachInput(ctx, o.operands, function (text) {
      var out = '';
      records(text).forEach(function (record) {
        var ended = record.charAt(record.length - 1) === '\n', body = ended ? record.slice(0, -1) : record;
        var numbered = style === 'a' || (style === 't' && body !== '') || (pattern && pattern.test(body));
        // GNU pads unnumbered lines with width + separator-length spaces.
        if (!numbered) { out += blankPad + record; return; }
        var digits = String(number);
        out += (format === 'ln' ? digits.padEnd(width) : format === 'rz' ? digits.padStart(width, '0') : digits.padStart(width)) + separator + record;
        number += increment;
      });
      ctx.stdout.write(out);
    });
  });

  // ---- sort -----------------------------------------------------------------
  function parseSortKey(spec) {
    var m = String(spec).match(/^(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*)(?:,(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*))?$/);
    if (!m || Number(m[1]) === 0) throw new UsageError('invalid number at field start: invalid count at start of ' + quoteName(spec));
    var opts = (m[3] || '') + (m[6] || '');
    return { startField: Number(m[1]), startChar: Number(m[2] || 1), endField: m[4] ? Number(m[4]) : Infinity, endChar: m[5] ? Number(m[5]) : 0, opts: opts, startBlanks: (m[3] || '').indexOf('b') >= 0, endBlanks: (m[6] || '').indexOf('b') >= 0 };
  }
  function versionCompare(a, b) {
    var re = /(\d+|\D+)/g, pa = a.match(re) || [], pb = b.match(re) || [];
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i], y = pb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      var dx = /^\d/.test(x), dy = /^\d/.test(y);
      if (dx && dy) { var diff = BigInt(x) - BigInt(y); if (diff) return diff < 0n ? -1 : 1; continue; }
      if (x !== y) return compareBytes(x, y);
    }
    return 0;
  }
  // 1..12 for a leading month abbreviation (any case), 0 otherwise.
  function monthIndex(s) {
    var abbr = s.trim().slice(0, 3).toLowerCase();
    for (var i = 0; i < MONTHS.length; i++) if (MONTHS[i].toLowerCase() === abbr) return i + 1;
    return 0;
  }
  function numericPrefix(s) { var m = s.match(/^\s*(-?(\d+\.?\d*|\.\d+))/); return m ? Number(m[1]) : 0; }
  function humanValue(s) {
    var m = s.match(/^\s*(-?(\d+\.?\d*|\.\d+))([KMGTPEZY]?)/i);
    if (!m) return 0;
    return Number(m[1]) * (m[3] ? Math.pow(1024, 'KMGTPEZY'.indexOf(m[3].toUpperCase()) + 1) : 1);
  }

  utility('sort', { usageCode: 2 }, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'bcCdfghiMnRrsuVz', params: 'kotST', long: { 'ignore-leading-blanks': 'b', check: { key: 'c', arg: 'optional' }, 'dictionary-order': 'd', 'ignore-case': 'f', 'general-numeric-sort': 'g', 'human-numeric-sort': 'h', 'ignore-nonprinting': 'i', 'month-sort': 'M', 'numeric-sort': 'n', 'random-sort': 'R', reverse: 'r', stable: 's', unique: 'u', 'version-sort': 'V', 'zero-terminated': 'z', key: { key: 'k', arg: true }, output: { key: 'o', arg: true }, 'field-separator': { key: 't', arg: true }, 'buffer-size': { key: 'S', arg: true }, 'temporary-directory': { key: 'T', arg: true }, parallel: { key: 'parallel', arg: true }, sort: { key: 'sortBy', arg: true } } });
    var globalOpts = o.list.filter(function (p) { return 'bdfgiMhnRrV'.indexOf(p[0]) >= 0 && p[0].length === 1; }).map(function (p) { return p[0]; }).join('');
    var sortBy = { general: 'g', human: 'h', month: 'M', numeric: 'n', random: 'R', version: 'V' }[o.get('sortBy')];
    if (sortBy) globalOpts += sortBy;
    var sep = o.get('t'), keys = o.all('k').map(parseSortKey), recordSep = o.has('z') ? '\0' : '\n';
    if (sep != null && sep.length !== 1) { if (sep === '\\0') sep = '\0'; else throw new UsageError('multi-character tab ' + quoteName(sep)); }
    keys.forEach(function (k) { if (!k.opts.replace(/b/g, '')) { k.opts += globalOpts.replace(/b/g, ''); if (globalOpts.indexOf('b') >= 0) { k.startBlanks = true; k.endBlanks = true; } } });
    var input = '';
    var status = await forEachInput(ctx, o.operands, function (text) {
      input += text;
      if (text && text.charAt(text.length - 1) !== recordSep) input += recordSep;
    }, function (operand, e) { return 'cannot read: ' + operand + ': ' + errorReason(e); });
    if (status) return 2;
    var items = lines(input, recordSep);
    function fieldsOf(line) {
      // Without -t, a field is a run of blanks followed by non-blanks.
      if (sep != null) {
        var parts = line.split(sep), pos = 0;
        return parts.map(function (p) { var f = { start: pos, end: pos + p.length }; pos += p.length + 1; return f; });
      }
      var fields = [], re = /[ \t]*[^ \t]+|[ \t]+$/g, m;
      while ((m = re.exec(line))) fields.push({ start: m.index, end: m.index + m[0].length });
      return fields;
    }
    function extract(line, key) {
      var fields = fieldsOf(line);
      var sf = fields[key.startField - 1];
      if (!sf) return '';
      var start = sf.start;
      if (key.startBlanks) while (start < sf.end && /[ \t]/.test(line[start])) start++;
      start = Math.min(start + key.startChar - 1, sf.end);
      var end;
      if (key.endField === Infinity || key.endField > fields.length) end = line.length;
      else {
        var ef = fields[key.endField - 1];
        if (key.endChar === 0) end = ef.end;
        else {
          var es = ef.start;
          if (key.endBlanks) while (es < ef.end && /[ \t]/.test(line[es])) es++;
          end = Math.min(es + key.endChar, ef.end);
        }
      }
      return end > start ? line.slice(start, end) : '';
    }
    function compareWith(a, b, opts) {
      if (opts.indexOf('b') >= 0) { a = a.replace(/^[ \t]+/, ''); b = b.replace(/^[ \t]+/, ''); }
      if (opts.indexOf('d') >= 0) { a = a.replace(/[^A-Za-z0-9 \t]/g, ''); b = b.replace(/[^A-Za-z0-9 \t]/g, ''); }
      if (opts.indexOf('i') >= 0) { a = a.replace(/[^\x20-\x7e]/g, ''); b = b.replace(/[^\x20-\x7e]/g, ''); }
      if (opts.indexOf('f') >= 0) { a = a.toUpperCase(); b = b.toUpperCase(); }
      var r;
      if (opts.indexOf('n') >= 0) r = numericPrefix(a) - numericPrefix(b);
      else if (opts.indexOf('g') >= 0) {
        var x = parseFloat(a), y = parseFloat(b);
        if (isNaN(x) || isNaN(y)) r = isNaN(x) ? (isNaN(y) ? 0 : -1) : 1; else r = x - y;
      }
      else if (opts.indexOf('h') >= 0) r = humanValue(a) - humanValue(b);
      else if (opts.indexOf('M') >= 0) r = monthIndex(a) - monthIndex(b);
      else if (opts.indexOf('V') >= 0) r = versionCompare(a, b);
      else r = compareBytes(a, b);
      r = r < 0 ? -1 : r > 0 ? 1 : 0;
      return opts.indexOf('r') >= 0 ? -r : r;
    }
    var stable = o.has('s'), unique = o.has('u'), reverseAll = globalOpts.indexOf('r') >= 0;
    function compareKeys(a, b) {
      if (!keys.length) return compareWith(a, b, globalOpts);
      for (var i = 0; i < keys.length; i++) {
        var r = compareWith(extract(a, keys[i]), extract(b, keys[i]), keys[i].opts);
        if (r) return r;
      }
      return 0;
    }
    function compare(a, b) {
      var r = compareKeys(a, b);
      if (r || stable || unique) return r;
      // Last-resort comparison of whole lines (bytewise; reversed with -r).
      if (!keys.length && globalOpts.replace(/[rb]/g, '') === '') return 0;
      var last = compareBytes(a, b);
      return reverseAll ? -last : last;
    }
    if (o.has('c') || o.has('C')) {
      for (var i = 1; i < items.length; i++) {
        var r = compare(items[i - 1], items[i]);
        if (r > 0 || (unique && r === 0)) {
          if (!o.has('C') && o.get('c') !== 'quiet' && o.get('c') !== 'silent') ctx.error(displayInput(o.operands[0] || '-').replace('standard input', '-') + ':' + (i + 1) + ': disorder: ' + items[i]);
          return 1;
        }
      }
      return 0;
    }
    var indexed = items.map(function (line, index) { return { line: line, index: index }; });
    indexed.sort(function (x, y) { return compare(x.line, y.line) || x.index - y.index; });
    var sorted = indexed.map(function (x) { return x.line; });
    if (unique) sorted = sorted.filter(function (line, i) { return i === 0 || compareKeys(sorted[i - 1], line) !== 0; });
    var output = sorted.map(function (line) { return line + recordSep; }).join('');
    if (o.get('o') != null) { await ctx.vfs.writeFile(ctx.resolve(o.get('o')), output); return 0; }
    ctx.stdout.write(output);
    return 0;
  });

  // ---- uniq -------------------------------------------------------------------
  utility('uniq', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'cdDiuz', params: 'fsw', numeric: true, long: { count: 'c', repeated: 'd', 'all-repeated': { key: 'D', arg: 'optional' }, group: { key: 'group', arg: 'optional' }, 'ignore-case': 'i', unique: 'u', 'skip-fields': { key: 'f', arg: true }, 'skip-chars': { key: 's', arg: true }, 'check-chars': { key: 'w', arg: true }, 'zero-terminated': 'z' } });
    if (o.has('c') && o.has('D')) throw new UsageError('printing all duplicated lines and repeat counts is meaningless');
    if (o.operands.length > 2) throw new UsageError('extra operand ' + quoteName(o.operands[2]));
    var skipFields = Number(o.get('f') || o.get('#') || 0), skipChars = Number(o.get('s') || 0), check = o.get('w') != null ? Number(o.get('w')) : Infinity;
    var sep = o.has('z') ? '\0' : '\n', input = o.operands[0] || '-';
    var text;
    try { text = await ctx.readFile(input); }
    catch (e) { ctx.error(input + ': ' + errorReason(e)); return 1; }
    function keyOf(line) {
      var rest = line;
      for (var f = 0; f < skipFields; f++) rest = rest.replace(/^[ \t]*[^ \t]*/, '');
      rest = rest.slice(skipChars).slice(0, check);
      return o.has('i') ? rest.toLowerCase() : rest;
    }
    var groups = [];
    lines(text, sep).forEach(function (line) {
      var last = groups[groups.length - 1];
      if (last && keyOf(last.lines[0]) === keyOf(line)) last.lines.push(line);
      else groups.push({ lines: [line] });
    });
    var out = '', allRepeated = o.has('D') ? (o.get('D') === true ? 'none' : o.get('D')) : null, groupMode = o.get('group');
    var printedGroup = false;
    groups.forEach(function (g, gi) {
      var dup = g.lines.length > 1;
      if (groupMode) {
        if ((groupMode === 'prepend' || groupMode === 'both') || (printedGroup && groupMode !== 'append')) out += sep;
        out += g.lines.map(function (l) { return l + sep; }).join('');
        printedGroup = true;
        if ((groupMode === 'append' || groupMode === 'both') && gi === groups.length - 1) out += sep;
        return;
      }
      if (allRepeated) {
        if (!dup) return;
        if ((allRepeated === 'prepend' || (allRepeated === 'separate' && printedGroup))) out += sep;
        out += g.lines.map(function (l) { return l + sep; }).join('');
        printedGroup = true;
        return;
      }
      if (o.has('d') && !dup) return;
      if (o.has('u') && dup) return;
      out += (o.has('c') ? String(g.lines.length).padStart(7) + ' ' : '') + g.lines[0] + sep;
    });
    if (o.operands[1] != null) { await ctx.vfs.writeFile(ctx.resolve(o.operands[1]), out); return 0; }
    ctx.stdout.write(out);
    return 0;
  });

  // ---- cut ----------------------------------------------------------------------
  function parseRangeList(spec, kind) {
    return String(spec).split(/[,\s]+/).filter(function (s) { return s !== ''; }).map(function (part) {
      var m = part.match(/^(\d*)(-?)(\d*)$/);
      if (!m || (!m[1] && !m[3]) || (!m[2] && !m[1])) throw new UsageError('invalid ' + kind + ' value ' + quoteName(part));
      var lo = m[1] ? Number(m[1]) : 1, hi = m[2] ? (m[3] ? Number(m[3]) : Infinity) : lo;
      if (lo === 0 || hi === 0) throw new UsageError(kind === 'field' ? 'fields are numbered from 1' : 'byte/character positions are numbered from 1');
      if (hi < lo) throw new UsageError('invalid decreasing range');
      return { lo: lo, hi: hi };
    });
  }
  utility('cut', {}, async function (ctx) {
    var o = getopt(ctx.args, { flags: 'snz', params: 'bcfd', long: { bytes: { key: 'b', arg: true }, characters: { key: 'c', arg: true }, fields: { key: 'f', arg: true }, delimiter: { key: 'd', arg: true }, 'only-delimited': 's', complement: 'complement', 'output-delimiter': { key: 'od', arg: true }, 'zero-terminated': 'z' } });
    var modes = ['b', 'c', 'f'].filter(function (k) { return o.has(k); });
    if (modes.length === 0) throw new UsageError('you must specify a list of bytes, characters, or fields');
    if (modes.length > 1) throw new UsageError('only one list may be specified');
    var mode = modes[0], ranges = parseRangeList(o.get(mode), mode === 'f' ? 'field' : 'byte/character');
    var delim = o.get('d');
    if (delim != null && mode !== 'f') throw new UsageError('an input delimiter may be specified only when operating on fields');
    if (o.has('s') && mode !== 'f') throw new UsageError('suppressing non-delimited lines makes sense\n\tonly when operating on fields');
    if (delim == null) delim = '\t';
    if (Array.from(delim).length !== 1) { if (delim === '') delim = '\0'; else throw new UsageError('the delimiter must be a single character'); }
    var outputDelim = o.get('od'), complement = o.has('complement'), sep = o.has('z') ? '\0' : '\n';
    function selected(i) { var hit = ranges.some(function (r) { return i >= r.lo && i <= r.hi; }); return complement ? !hit : hit; }
    return forEachInput(ctx, o.operands, function (text) {
      var out = '';
      lines(text, sep).forEach(function (line) {
        if (mode === 'f') {
          if (line.indexOf(delim) < 0) { if (!o.has('s')) out += line + sep; return; }
          out += line.split(delim).filter(function (_, i) { return selected(i + 1); }).join(outputDelim != null ? outputDelim : delim) + sep;
          return;
        }
        // -b counts bytes, -c counts characters.
        var units = mode === 'b' ? Array.prototype.slice.call(toBytes(line)) : Array.from(line), pieces = [], run = [];
        units.forEach(function (u, i) { if (selected(i + 1)) run.push(u); else if (run.length) { pieces.push(run); run = []; } });
        if (run.length) pieces.push(run);
        var rendered = pieces.map(function (p) { return mode === 'b' ? decodeBytes(new Uint8Array(p)) : p.join(''); });
        out += rendered.join(outputDelim != null ? outputDelim : '') + sep;
      });
      ctx.stdout.write(out);
    });
  });

  // ---- date ---------------------------------------------------------------
  // zone: 'UTC', null (host local time) or an IANA name (via Intl).
  function normalizeZone(zone) {
    if (zone == null || zone === '') return zone === '' ? 'UTC' : null;
    if (/^(UTC|GMT|Z|UTC0|GMT0|Etc\/UTC)$/i.test(zone)) return 'UTC';
    return zone;
  }
  function zoneParts(date, zone) {
    var t = date.getTime();
    if (zone === 'UTC') return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), ms: date.getUTCMilliseconds(), weekday: date.getUTCDay(), offset: 0, name: 'UTC' };
    if (zone && typeof Intl !== 'undefined') {
      try {
        var parts = {};
        new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', timeZoneName: 'short' })
          .formatToParts(date).forEach(function (part) { parts[part.type] = part.value; });
        var wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
        var offset = Math.round((wall - (t - ((t % 1000) + 1000) % 1000)) / 60000);
        var name = parts.timeZoneName && !/^GMT[+-]/.test(parts.timeZoneName) ? parts.timeZoneName : formatOffset(offset, 0).slice(0, offset % 60 ? 5 : 3);
        return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), ms: ((t % 1000) + 1000) % 1000, weekday: DAYS.indexOf(parts.weekday), offset: offset, name: name === 'GMT' ? 'GMT' : name };
      } catch (_) {
        // Unknown zone names behave like UTC under that name, as in glibc.
        var utc = zoneParts(date, 'UTC'); utc.name = zone; return utc;
      }
    }
    var localOffset = -date.getTimezoneOffset(), localName = null;
    if (typeof Intl !== 'undefined') {
      try {
        var zoneName = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date).filter(function (p) { return p.type === 'timeZoneName'; })[0];
        if (zoneName && !/^GMT[+-]/.test(zoneName.value)) localName = zoneName.value;
      } catch (_) { /* fall through */ }
    }
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(), ms: date.getMilliseconds(), weekday: date.getDay(), offset: localOffset, name: localName || (localOffset === 0 ? 'UTC' : formatOffset(localOffset, 0).slice(0, localOffset % 60 ? 5 : 3)) };
  }
  function formatOffset(offset, colons) {
    var sign = offset < 0 ? '-' : '+', abs = Math.abs(offset), h = String(Math.floor(abs / 60)).padStart(2, '0'), m = String(abs % 60).padStart(2, '0');
    return colons === 0 ? sign + h + m : colons === 1 ? sign + h + ':' + m : colons === 2 ? sign + h + ':' + m + ':00' : sign + h + (abs % 60 ? ':' + m : '');
  }
  // Wall-clock fields in `zone` -> Date.
  function zonedDate(y, mo, d, h, mi, s, ms, zone) {
    if (zone === 'UTC') return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
    if (!zone) return new Date(y, mo - 1, d, h, mi, s, ms);
    var guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    for (var i = 0; i < 2; i++) guess = Date.UTC(y, mo - 1, d, h, mi, s, ms) - zoneParts(new Date(guess), zone).offset * 60000;
    return new Date(guess);
  }

  function strftime(date, format, zone) {
    var p = zoneParts(date, zone);
    var dayStart = Date.UTC(p.year, p.month - 1, p.day), yday = Math.round((dayStart - Date.UTC(p.year, 0, 1)) / 86400000);
    var thursday = new Date(dayStart + (3 - (p.weekday + 6) % 7) * 86400000);
    var isoYear = thursday.getUTCFullYear(), isoWeek = Math.floor(Math.round((thursday - Date.UTC(isoYear, 0, 1)) / 86400000) / 7) + 1;
    function num(value, width, pad) { return { numeric: true, text: String(value), width: width, pad: pad || '0' }; }
    function directive(c, colons) {
      switch (c) {
        case 'a': return DAYS[p.weekday];
        case 'A': return DAYS_LONG[p.weekday];
        case 'b': case 'h': return MONTHS[p.month - 1];
        case 'B': return MONTHS_LONG[p.month - 1];
        case 'c': return strftime(date, '%a %b %e %H:%M:%S %Y', zone);
        case 'C': return num(Math.floor(p.year / 100), 2);
        case 'd': return num(p.day, 2);
        case 'D': return strftime(date, '%m/%d/%y', zone);
        case 'e': return num(p.day, 2, ' ');
        case 'F': return strftime(date, '%Y-%m-%d', zone);
        case 'g': return num(isoYear % 100, 2);
        case 'G': return num(isoYear, 1);
        case 'H': return num(p.hour, 2);
        case 'I': return num(p.hour % 12 || 12, 2);
        case 'j': return num(yday + 1, 3);
        case 'k': return num(p.hour, 2, ' ');
        case 'l': return num(p.hour % 12 || 12, 2, ' ');
        case 'm': return num(p.month, 2);
        case 'M': return num(p.minute, 2);
        case 'n': return '\n';
        case 'N': return num(String(p.ms * 1000000).padStart(9, '0'), 9);
        case 'p': return p.hour < 12 ? 'AM' : 'PM';
        case 'P': return p.hour < 12 ? 'am' : 'pm';
        case 'q': return num(Math.floor((p.month - 1) / 3) + 1, 1);
        case 'r': return strftime(date, '%I:%M:%S %p', zone);
        case 'R': return strftime(date, '%H:%M', zone);
        case 's': return num(Math.floor(date.getTime() / 1000), 1);
        case 'S': return num(p.second, 2);
        case 't': return '\t';
        case 'T': return strftime(date, '%H:%M:%S', zone);
        case 'u': return num(p.weekday || 7, 1);
        case 'U': return num(Math.floor((yday + 7 - p.weekday) / 7), 2);
        case 'V': return num(isoWeek, 2);
        case 'w': return num(p.weekday, 1);
        case 'W': return num(Math.floor((yday + 7 - (p.weekday + 6) % 7) / 7), 2);
        case 'x': return strftime(date, '%m/%d/%y', zone);
        case 'X': return strftime(date, '%H:%M:%S', zone);
        case 'y': return num(p.year % 100, 2);
        case 'Y': return num(p.year, 1);
        case 'z': return formatOffset(p.offset, colons);
        case 'Z': return p.name;
        case '+': return strftime(date, '%a %b %e %H:%M:%S %Z %Y', zone);
        case '%': return '%';
      }
      return null;
    }
    return format.replace(/%([-_0^#]*)(\d*)(:{0,3})([a-zA-Z%+])/g, function (whole, flags, width, colons, c) {
      var value = directive(c, colons.length);
      if (value === null || (colons && c !== 'z')) return whole;
      var text;
      if (typeof value === 'object') {
        var digits = value.text, negative = digits.charAt(0) === '-';
        if (negative) digits = digits.slice(1);
        if (c === 'N' && width) digits = digits.slice(0, Number(width));
        var w = width ? Number(width) : value.width, padChar = flags.indexOf('_') >= 0 ? ' ' : flags.indexOf('0') >= 0 ? '0' : value.pad;
        if (flags.indexOf('-') >= 0) digits = digits.replace(/^[0 ]+(?=.)/, '');
        else if (digits.length < w - (negative ? 1 : 0)) digits = padChar === '0' ? digits.padStart(w - (negative ? 1 : 0), '0') : digits.padStart(w - (negative ? 1 : 0), ' ');
        text = (negative ? '-' : '') + digits;
        if (padChar === ' ' && negative) text = text.replace(/^-( +)/, '$1-');
      } else {
        text = value;
        if (width && text.length < Number(width)) text = text.padStart(Number(width), flags.indexOf('0') >= 0 ? '0' : ' ');
      }
      if (flags.indexOf('^') >= 0) text = text.toUpperCase();
      if (flags.indexOf('#') >= 0) text = (c === 'p' || c === 'Z') ? text.toLowerCase() : text.toUpperCase();
      return text;
    });
  }

  // GNU `date -d` subset: @epoch, ISO 8601, MM/DD[/YYYY], month names,
  // times with am/pm and zones, now/today/yesterday/tomorrow, noon/midnight,
  // weekday names (next/last/this), and relative items ("2 days ago").
  function parseDateString(input, now, zone) {
    var s = String(input).trim().toLowerCase(), m;
    if ((m = s.match(/^@(-?\d+(?:\.\d+)?)$/))) return new Date(Number(m[1]) * 1000);
    var base = zoneParts(now, zone), date = null, time = null, offset = null, weekday = null, weekdayShift = 0;
    var rel = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 }, sawTime = false;
    var units = { year: 'y', month: 'mo', fortnight: 'd', week: 'd', day: 'd', hour: 'h', minute: 'mi', min: 'mi', second: 's', sec: 's' };
    var factor = { fortnight: 14, week: 7 };
    var monthRe = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
    function monthNumber(name) { return monthIndex(name); }
    function addRel(unit, amount) { rel[units[unit]] += amount * (factor[unit] || 1); }
    var rest = s;
    while (true) {
      rest = rest.replace(/^[\s,]+/, '');
      if (!rest) break;
      var matched = false;
      function take(re, fn) {
        if (matched) return;
        var mm = rest.match(re);
        if (mm) { matched = true; rest = rest.slice(mm[0].length); fn(mm); }
      }
      take(/^(\d{4})-(\d{1,2})-(\d{1,2})(t(?=\d))?/, function (mm) { date = [Number(mm[1]), Number(mm[2]), Number(mm[3])]; });
      take(/^(\d{4})(\d{2})(\d{2})(?!\d)/, function (mm) { date = [Number(mm[1]), Number(mm[2]), Number(mm[3])]; });
      take(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?!\d)/, function (mm) { var y = Number(mm[3]); if (mm[3].length === 2) y += y < 69 ? 2000 : 1900; date = [y, Number(mm[1]), Number(mm[2])]; });
      take(/^(\d{1,2})\/(\d{1,2})(?![\d\/])/, function (mm) { date = [base.year, Number(mm[1]), Number(mm[2])]; });
      take(new RegExp('^' + monthRe + '\\s+(\\d{1,2})(?:(?:,\\s*|\\s+)(\\d{4}))?(?![\\d:])'), function (mm) { date = [mm[3] ? Number(mm[3]) : base.year, monthNumber(mm[1]), Number(mm[2])]; });
      take(new RegExp('^(\\d{1,2})[\\s-]+' + monthRe + '(?:[\\s-]+(\\d{4}))?(?![\\d:])'), function (mm) { date = [mm[3] ? Number(mm[3]) : base.year, monthNumber(mm[2]), Number(mm[1])]; });
      take(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(am|pm|a\.m\.|p\.m\.)?/, function (mm) {
        var h = Number(mm[1]);
        if (mm[5]) { h = h % 12; if (mm[5].charAt(0) === 'p') h += 12; }
        time = [h, Number(mm[2]), Number(mm[3] || 0), mm[4] ? Number((mm[4] + '00').slice(0, 3)) : 0]; sawTime = true;
      });
      take(/^(\d{1,2})\s*(am|pm)\b/, function (mm) { time = [Number(mm[1]) % 12 + (mm[2] === 'pm' ? 12 : 0), 0, 0, 0]; sawTime = true; });
      if (sawTime || date) take(/^(z|utc|gmt)\b/, function () { offset = 0; });
      if (sawTime) take(/^([+-])(\d{2}):?(\d{2})(?!\d)/, function (mm) { offset = (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3])); });
      take(/^(now|today)\b/, function () {});
      take(/^yesterday\b/, function () { rel.d -= 1; });
      take(/^tomorrow\b/, function () { rel.d += 1; });
      take(/^noon\b/, function () { time = [12, 0, 0, 0]; });
      take(/^midnight\b/, function () { time = [0, 0, 0, 0]; });
      take(/^(next|last|this)?\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b\.?/, function (mm) {
        weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(mm[2]);
        weekdayShift = mm[1] === 'next' ? 1 : mm[1] === 'last' ? -1 : 0;
      });
      take(/^(next|last|this)\s+(year|month|fortnight|week|day|hour|minute|min|second|sec)s?\b/, function (mm) {
        addRel(mm[2], mm[1] === 'next' ? 1 : mm[1] === 'last' ? -1 : 0);
      });
      take(/^([+-]?\s*\d+)?\s*(year|month|fortnight|week|day|hour|minute|min|second|sec)s?\b/, function (mm) {
        var amount = mm[1] ? Number(mm[1].replace(/\s+/g, '')) : 1;
        addRel(mm[2], amount);
      });
      take(/^ago\b/, function () {
        // "ago" negates every relative item seen so far.
        Object.keys(rel).forEach(function (k) { rel[k] = -rel[k]; });
      });
      if (!matched) return null;
    }
    var y = date ? date[0] : base.year, mo = date ? date[1] : base.month, d = date ? date[2] : base.day;
    if (date && (mo < 1 || mo > 12 || d < 1 || d > 31)) return null;
    var t = time || (date || weekday !== null ? [0, 0, 0, 0] : [base.hour, base.minute, base.second, base.ms]);
    if (time && (t[0] > 23 || t[1] > 59 || t[2] > 60)) return null;
    if (weekday !== null) {
      var current = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), delta = (weekday - current + 7) % 7;
      if (weekdayShift > 0 && delta === 0) delta = 7;
      if (weekdayShift < 0) delta = delta === 0 ? -7 : delta - 7;
      d += delta;
    }
    var wall = new Date(Date.UTC(y + rel.y, mo - 1 + rel.mo, d + rel.d, t[0], t[1], t[2], t[3]));
    var result = offset !== null
      ? new Date(wall.getTime() - offset * 60000)
      : zonedDate(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds(), zone);
    return new Date(result.getTime() + ((rel.h * 60 + rel.mi) * 60 + rel.s) * 1000);
  }

  utility('date', { usage: '[OPTION]... [+FORMAT]' }, async function (ctx) {
    // -I takes an optional attached argument (-Iseconds); normalise it first.
    var args = ctx.args.map(function (a) { var m = a.match(/^-I(.*)$/); return m ? '--iso-8601=' + (m[1] || 'date') : a; });
    var o = getopt(args, { flags: 'Ru', params: 'drsf', long: { date: { key: 'd', arg: true }, 'iso-8601': { key: 'I', arg: 'optional' }, 'rfc-email': 'R', 'rfc-2822': 'R', 'rfc-3339': { key: 'rfc3339', arg: true }, reference: { key: 'r', arg: true }, set: { key: 's', arg: true }, utc: 'u', universal: 'u', file: { key: 'f', arg: true } } });
    var zone = o.has('u') ? 'UTC' : normalizeZone(ctx.timezone), date;
    if (o.has('s')) { ctx.error('cannot set date: Operation not permitted'); return 1; }
    if (o.operands.length > 1) throw new UsageError('extra operand ' + quoteName(o.operands[1]));
    if (o.operands.length && o.operands[0].charAt(0) !== '+') { ctx.error('invalid date ' + quoteName(o.operands[0])); return 1; }
    async function render(d) {
      var format = o.operands.length ? o.operands[0].slice(1) : null;
      var iso = o.get('I'), rfc3339 = o.get('rfc3339');
      if (iso) format = { date: '%Y-%m-%d', hours: '%Y-%m-%dT%H%:z', minutes: '%Y-%m-%dT%H:%M%:z', seconds: '%Y-%m-%dT%H:%M:%S%:z', ns: '%Y-%m-%dT%H:%M:%S,%N%:z' }[iso === true ? 'date' : iso];
      else if (o.has('R')) format = '%a, %d %b %Y %H:%M:%S %z';
      else if (rfc3339) format = { date: '%Y-%m-%d', seconds: '%Y-%m-%d %H:%M:%S%:z', ns: '%Y-%m-%d %H:%M:%S.%N%:z' }[rfc3339];
      if (format === undefined) throw new UsageError('invalid argument ' + quoteName(iso || rfc3339));
      return strftime(d, format == null ? '%a %b %e %H:%M:%S %Z %Y' : format, zone) + '\n';
    }
    if (o.has('f')) {
      var listing = await ctx.readFile(o.get('f')), status = 0, out = '';
      for (var line of lines(listing)) {
        var parsed = parseDateString(line, ctx.now(), zone);
        if (!parsed) { ctx.error('invalid date ' + quoteName(line)); status = 1; continue; }
        out += await render(parsed);
      }
      ctx.stdout.write(out);
      return status;
    }
    if (o.has('r')) {
      var st = await ctx.vfs.stat(ctx.resolve(o.get('r')));
      if (!st) { ctx.error(o.get('r') + ': No such file or directory'); return 1; }
      date = st.mtime != null ? new Date(st.mtime) : ctx.now();
    } else if (o.has('d')) {
      date = parseDateString(o.get('d'), ctx.now(), zone);
      if (!date || isNaN(date.getTime())) { ctx.error('invalid date ' + quoteName(o.get('d'))); return 1; }
    } else date = ctx.now();
    ctx.stdout.write(await render(date));
    return 0;
  });

  // ---- regular expressions ----------------------------------------------------
  function escapeRegexChar(c) { return /[\\^$.*+?()[\]{}|\/-]/.test(c) ? '\\' + c : c; }
  function escapeRegex(text) { return Array.from(String(text)).map(escapeRegexChar).join(''); }

  // POSIX bracket expression starting at pattern[start] === '['.
  function translateBracket(pattern, start, backslashEscapes) {
    var j = start + 1, negate = false, body = '';
    if (pattern[j] === '^') { negate = true; j++; }
    if (pattern[j] === ']') { body += '\\]'; j++; }
    while (j < pattern.length && pattern[j] !== ']') {
      if (pattern[j] === '[' && /[:=.]/.test(pattern[j + 1] || '')) {
        var kind = pattern[j + 1], close = pattern.indexOf(kind + ']', j + 2);
        if (close < 0) throw new SyntaxError('Unmatched [, [^, [:, [., or [=');
        var name = pattern.slice(j + 2, close);
        if (kind === ':') {
          if (!POSIX_CLASSES[name]) throw new SyntaxError('Invalid character class name');
          body += POSIX_CLASSES[name];
        } else body += escapeRegex(name);
        j = close + 2; continue;
      }
      var ch = pattern[j];
      // backslashEscapes: true = every \x is an escape (awk); 'control' =
      // only \n, \t and \\ are (GNU sed); falsy = backslash is literal (POSIX).
      if (backslashEscapes === 'control' && ch === '\\' && /[nt\\]/.test(pattern[j + 1] || '')) { body += '\\' + pattern[j + 1]; j += 2; continue; }
      if (backslashEscapes === true && ch === '\\' && j + 1 < pattern.length) { body += '\\' + pattern[j + 1]; j += 2; continue; }
      body += /[\\\[\]^]/.test(ch) ? '\\' + ch : ch;
      j++;
    }
    if (j >= pattern.length) throw new SyntaxError('Unmatched [, [^, [:, [., or [=');
    return { text: '[' + (negate ? '^' : '') + body + ']', end: j + 1 };
  }

  // POSIX BRE/ERE (GNU flavour) and Emacs syntax -> JavaScript RegExp source.
  // options.controlEscapes: \n \t \r \f \v \a are control characters (sed, awk).
  // options.bracketEscapes: passed to translateBracket.
  function translateRegex(pattern, dialect, options) {
    options = options || {};
    var ere = dialect === 'ERE', emacs = dialect === 'EMACS', bre = !ere && !emacs;
    var controls = { n: '\\n', t: '\\t', r: '\\r', f: '\\f', v: '\\v', a: '\\x07' };
    var out = '', i = 0, n = pattern.length, atStart = true, depth = 0;
    var gnuEscapes = { w: '\\w', W: '\\W', s: '\\s', S: '\\S', b: '\\b', B: '\\B', '<': '\\b(?=\\w)', '>': '\\b(?<=\\w)', '`': '^', "'": '$' };
    function breAnchorEnd(at) { return at === n - 1 || pattern.slice(at + 1, at + 3) === '\\)' || pattern.slice(at + 1, at + 3) === '\\|'; }
    while (i < n) {
      var c = pattern[i];
      if (c === '\\') {
        var d = pattern[i + 1];
        if (d === undefined) throw new SyntaxError('Trailing backslash');
        i += 2;
        if (!ere && d === '(') { out += '('; depth++; atStart = true; continue; }
        if (!ere && d === ')') { if (!depth) throw new SyntaxError('Unmatched ) or \\)'); out += ')'; depth--; atStart = false; continue; }
        if (!ere && d === '|') { out += '|'; atStart = true; continue; }
        if (bre && d === '{') {
          var close = pattern.indexOf('\\}', i);
          if (close < 0) throw new SyntaxError('Unmatched \\{');
          var interval = pattern.slice(i, close);
          if (!/^\d*(,\d*)?$/.test(interval)) throw new SyntaxError('Invalid content of \\{\\}');
          out += '{' + (interval.charAt(0) === ',' ? '0' + interval : interval) + '}';
          i = close + 2; atStart = false; continue;
        }
        if (bre && (d === '+' || d === '?')) { out += atStart ? '\\' + d : d; atStart = false; continue; }
        if (/[1-9]/.test(d)) { out += '\\' + d; atStart = false; continue; }
        if (options.controlEscapes && controls[d]) { out += controls[d]; atStart = false; continue; }
        if (gnuEscapes[d]) { out += gnuEscapes[d]; atStart = false; continue; }
        out += escapeRegexChar(d); atStart = false; continue;
      }
      if (c === '[') { var br = translateBracket(pattern, i, options.bracketEscapes || false); out += br.text; i = br.end; atStart = false; continue; }
      if (c === '*') { out += atStart ? '\\*' : '*'; i++; atStart = false; continue; }
      if (c === '^') {
        if (!bre || atStart) { out += '^'; i++; continue; }
        out += '\\^'; i++; atStart = false; continue;
      }
      if (c === '$') {
        out += (!bre || breAnchorEnd(i)) ? '$' : '\\$'; i++; atStart = false; continue;
      }
      if (c === '.') { out += '.'; i++; atStart = false; continue; }
      if (ere && c === '(') { out += '('; depth++; i++; atStart = true; continue; }
      if (ere && c === ')') {
        if (!depth) { out += '\\)'; i++; atStart = false; continue; }
        out += ')'; depth--; i++; atStart = false; continue;
      }
      if (ere && c === '|') { out += '|'; i++; atStart = true; continue; }
      if ((ere || emacs) && (c === '+' || c === '?')) { out += atStart ? '\\' + c : c; i++; atStart = false; continue; }
      if (ere && c === '{') {
        var m = pattern.slice(i).match(/^\{(\d*)(,(\d*))?\}/);
        if (m && !atStart && (m[1] || m[3])) { out += '{' + (m[1] || '0') + (m[2] ? ',' + m[3] : '') + '}'; i += m[0].length; atStart = false; continue; }
        out += '\\{'; i++; atStart = false; continue;
      }
      out += escapeRegexChar(c); i++; atStart = false;
    }
    if (depth) throw new SyntaxError('Unmatched ( or \\(');
    return out;
  }

  // Rust regex (ripgrep) -> JavaScript: inline flags, (?P<name>), \A \z, POSIX classes.
  function translateRust(pattern) {
    var flags = '';
    var source = pattern.replace(/^\(\?([imsxU]+)\)/, function (_, f) { flags += f.replace(/[xU]/g, ''); return ''; })
      .replace(/\(\?P</g, '(?<').replace(/\\A/g, '^').replace(/\\z/g, '$')
      .replace(/\[:(\^?)([a-z]+):\]/g, function (whole, neg, name) { return POSIX_CLASSES[name] && !neg ? POSIX_CLASSES[name] : whole; });
    return { source: source, flags: flags };
  }

  // A set of compiled patterns, tested per line.
  function makeMatcher(regexps) {
    var globals = regexps.map(function (r) { return new RegExp(r.source, r.flags.replace('g', '') + 'g'); });
    return {
      test: function (line) { return regexps.some(function (r) { r.lastIndex = 0; return r.test(line); }); },
      // Non-overlapping matches, leftmost first, longest on ties.
      matches: function (line) {
        var all = [];
        globals.forEach(function (g) {
          g.lastIndex = 0;
          var m;
          while ((m = g.exec(line))) {
            if (m[0] === '') { g.lastIndex++; continue; }
            all.push({ index: m.index, end: m.index + m[0].length, text: m[0], match: m });
          }
        });
        all.sort(function (a, b) { return a.index - b.index || b.end - a.end; });
        var out = [], last = -1;
        all.forEach(function (m) { if (m.index >= last) { out.push(m); last = m.end; } });
        return out;
      }
    };
  }

  // Shared line scanner for grep and rg. Emits matched/context lines with
  // prefixes and `--` group separators. Returns { count, matched }.
  function scanLines(text, matcher, cfg, write, state) {
    var sep = cfg.sep || '\n', recs = lines(text, sep), count = 0, lastPrinted = -1, afterLeft = 0, stopAt = -1;
    var useContext = cfg.before > 0 || cfg.after > 0;
    function prefix(index, kind, column) {
      var p = '';
      if (cfg.name != null) p += cfg.name + (cfg.nullName ? '\0' : kind);
      if (cfg.lineNumber) p += (index + 1) + kind;
      if (column != null) p += column + kind;
      return p;
    }
    function emit(index, kind) {
      // `--` between non-adjacent groups, including across files.
      if (useContext && state.printed && (lastPrinted < 0 || index > lastPrinted + 1) && cfg.groupSeparator !== '') {
        write((cfg.groupSeparator == null ? '--' : cfg.groupSeparator) + '\n');
      }
      var line = recs[index];
      if (kind === ':' && cfg.onlyMatching) {
        matcher.matches(line).forEach(function (m) {
          write(prefix(index, ':', cfg.column ? m.index + 1 : null) + (cfg.replace != null ? m.text.replace(new RegExp(cfg.replaceSource, cfg.replaceFlags), cfg.replace) : m.text) + '\n');
        });
      } else if (kind === ':' && cfg.vimgrep) {
        matcher.matches(line).forEach(function (m) { write(prefix(index, ':', m.index + 1) + line + '\n'); });
      } else {
        var shown = line;
        if (kind === ':' && cfg.replace != null) shown = line.replace(new RegExp(cfg.replaceSource, cfg.replaceFlags + 'g'), cfg.replace);
        var col = null;
        if (cfg.column && kind === ':') { var first = matcher.matches(line)[0]; col = first ? first.index + 1 : 1; }
        write(prefix(index, kind, col) + shown + (cfg.sep === '\0' ? '\0' : '\n'));
      }
      lastPrinted = index;
      state.printed = true;
    }
    for (var i = 0; i < recs.length; i++) {
      if (stopAt >= 0) {
        if (afterLeft > 0 && !cfg.quietBody) { emit(i, '-'); afterLeft--; continue; }
        break;
      }
      var hit = matcher.test(recs[i]) !== !!cfg.invert;
      if (hit) {
        count++;
        if (cfg.quietBody) { if (cfg.maxCount && count >= cfg.maxCount) break; if (cfg.stopAtFirst) break; continue; }
        for (var b = Math.max(lastPrinted + 1, i - cfg.before); b < i; b++) emit(b, '-');
        if (!(cfg.onlyMatching && cfg.invert)) emit(i, ':');
        else lastPrinted = i;
        afterLeft = cfg.after;
        if (cfg.maxCount && count >= cfg.maxCount) stopAt = i;
      } else if (afterLeft > 0 && !cfg.quietBody) { emit(i, '-'); afterLeft--; }
    }
    return { count: count, matched: count > 0 };
  }

  function isBinary(text) { return text.indexOf('\0') >= 0; }

  // Glob matching for --include/--exclude/-g style filters ('*' spans '/' unless pathMode).
  function globTest(glob, text, options) {
    options = options || {};
    var re = '^', i = 0;
    while (i < glob.length) {
      var c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      if (c === '*') { re += options.pathMode ? '[^/]*' : '.*'; i++; continue; }
      if (c === '?') { re += options.pathMode ? '[^/]' : '.'; i++; continue; }
      if (c === '[') { try { var br = translateBracket(glob.replace(/\[!/g, '[^'), i, true); re += br.text; i = br.end; continue; } catch (_) { re += '\\['; i++; continue; } }
      if (c === '{') {
        var close = glob.indexOf('}', i);
        if (close > i) { re += '(?:' + glob.slice(i + 1, close).split(',').map(escapeRegex).join('|') + ')'; i = close + 1; continue; }
      }
      if (c === '\\' && i + 1 < glob.length) { re += escapeRegexChar(glob[i + 1]); i += 2; continue; }
      re += escapeRegexChar(c); i++;
    }
    return new RegExp(re + '$', options.icase ? 'i' : '').test(text);
  }

  // ---- grep -------------------------------------------------------------------
  utility('grep', { usageCode: 2, usage: '[OPTION]... PATTERNS [FILE]...' }, async function (ctx) {
    var o = getopt(ctx.args, {
      flags: 'EFGPiyvwxclLnhHoqsrRzaIUbTZV', params: 'efmABCdD', numeric: true,
      long: { 'extended-regexp': 'E', 'fixed-strings': 'F', 'basic-regexp': 'G', 'perl-regexp': 'P', regexp: { key: 'e', arg: true }, file: { key: 'f', arg: true }, 'ignore-case': 'i', 'no-ignore-case': 'noi', 'word-regexp': 'w', 'line-regexp': 'x', 'null-data': 'z', 'no-messages': 's', 'invert-match': 'v', 'max-count': { key: 'm', arg: true }, 'byte-offset': 'b', 'line-number': 'n', 'no-line-number': 'non', 'with-filename': 'H', 'no-filename': 'h', label: { key: 'label', arg: true }, 'only-matching': 'o', quiet: 'q', silent: 'q', 'binary-files': { key: 'binary', arg: true }, text: 'a', directories: { key: 'd', arg: true }, devices: { key: 'D', arg: true }, recursive: 'r', 'dereference-recursive': 'R', include: { key: 'include', arg: true }, exclude: { key: 'exclude', arg: true }, 'exclude-dir': { key: 'exclude-dir', arg: true }, 'files-without-match': 'L', 'files-with-matches': 'l', count: 'c', 'initial-tab': 'T', null: 'Z', 'before-context': { key: 'B', arg: true }, 'after-context': { key: 'A', arg: true }, context: { key: 'C', arg: true }, color: { key: 'color', arg: 'optional' }, colour: { key: 'color', arg: 'optional' }, 'line-buffered': 'lb', 'group-separator': { key: 'gs', arg: true }, 'no-group-separator': 'ngs' }
    });
    var patterns = [], operands = o.operands.slice(), status = { error: false };
    o.list.forEach(function (p) { if (p[0] === 'e') patterns = patterns.concat(String(p[1]).split('\n')); });
    var patternFiles = o.all('f');
    for (var pf = 0; pf < patternFiles.length; pf++) {
      try { patterns = patterns.concat(lines(await ctx.readFile(patternFiles[pf]))); }
      catch (e) { ctx.error(patternFiles[pf] + ': ' + errorReason(e)); return 2; }
    }
    if (!o.has('e') && !patternFiles.length) {
      if (!operands.length) { ctx.stderr.write("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n"); return 2; }
      patterns = operands.shift().split('\n');
    }
    var dialect = { E: 'ERE', F: 'FIXED', G: 'BRE', P: 'PCRE' }[o.last(['E', 'F', 'G', 'P']) || 'G'];
    var icase = o.last(['i', 'y', 'noi']) === 'i' || o.last(['i', 'y', 'noi']) === 'y';
    var regexps;
    try {
      regexps = patterns.map(function (p) {
        var source = dialect === 'FIXED' ? escapeRegex(p) : dialect === 'PCRE' ? p : translateRegex(p, dialect);
        if (o.has('x')) source = '^(?:' + source + ')$';
        else if (o.has('w')) source = '(?<![A-Za-z0-9_])(?:' + source + ')(?![A-Za-z0-9_])';
        return new RegExp(source, icase ? 'i' : '');
      });
    } catch (e) { ctx.error(e.message.replace(/^Invalid regular expression: /, '')); return 2; }
    var matcher = makeMatcher(regexps);
    var context = o.get('C') != null ? Number(o.get('C')) : o.get('#') != null ? Number(o.get('#')) : 0;
    var after = o.get('A') != null ? Number(o.get('A')) : context, before = o.get('B') != null ? Number(o.get('B')) : context;
    var recursive = o.has('r') || o.has('R'), implicitDot = false;
    if (!operands.length) { if (recursive) { operands = ['.']; implicitDot = true; } else operands = ['-']; }
    var quiet = o.has('q'), listMode = o.has('l') ? 'l' : o.has('L') ? 'L' : null, countMode = o.has('c');
    var maxCount = o.get('m') != null ? Number(o.get('m')) : 0;
    var includes = o.all('include'), excludes = o.all('exclude'), excludeDirs = o.all('exclude-dir');
    var anyMatch = false, out = '', state = { printed: false };
    var showNames = o.has('H') ? true : o.has('h') ? false : null;
    // Decide filename prefixes the way GNU does: more than one operand, or recursion into a directory.
    if (showNames === null) {
      showNames = operands.length > 1;
      if (!showNames && recursive && operands[0] !== '-') {
        var only = await ctx.vfs.stat(ctx.resolve(operands[0]));
        showNames = !!only && only.type === 'dir';
      }
    }
    if (maxCount === 0 && o.get('m') != null) return 1;
    function write(s) { out += s; }
    function searchText(text, name) {
      if (!o.has('a') && o.get('binary') !== 'text' && isBinary(text)) {
        if (o.get('binary') === 'without-match') return;
        var found = matcher.test(text.split('\0').join('\n')) !== o.has('v') || (o.has('v') && lines(text).some(function (l) { return !matcher.test(l); }));
        if (found) {
          anyMatch = true;
          if (quiet) return 'stop';
          if (listMode === 'l') write(name + (o.has('Z') ? '\0' : '\n'));
          else if (countMode) write((showNames ? name + ':' : '') + '1\n');
          else if (!listMode) write('Binary file ' + name + ' matches\n');
        } else if (listMode === 'L') write(name + (o.has('Z') ? '\0' : '\n'));
        return;
      }
      var quietBody = quiet || listMode || countMode;
      var result = scanLines(text, matcher, {
        sep: o.has('z') ? '\0' : '\n', invert: o.has('v'), onlyMatching: o.has('o'), maxCount: maxCount,
        before: quietBody ? 0 : before, after: quietBody ? 0 : after, lineNumber: o.has('n') && !o.has('non'),
        name: showNames ? name : null, nullName: o.has('Z'), quietBody: quietBody, stopAtFirst: quiet || listMode === 'l' || listMode === 'L',
        groupSeparator: o.has('ngs') ? '' : o.get('gs')
      }, write, state);
      if (result.matched) anyMatch = true;
      if (quiet && result.matched) return 'stop';
      if (countMode) write((showNames ? name + (o.has('Z') ? '\0' : ':') : '') + result.count + '\n');
      if (listMode === 'l' && result.matched) write(name + (o.has('Z') ? '\0' : '\n'));
      if (listMode === 'L' && !result.matched) write(name + (o.has('Z') ? '\0' : '\n'));
    }
    async function searchPath(path, shown, top) {
      var st = await ctx.vfs.stat(path);
      if (!st) { if (!o.has('s')) ctx.error(shown + ': No such file or directory'); status.error = true; return; }
      if (st.type === 'dir') {
        if (!recursive || o.get('d') === 'skip') {
          if (o.get('d') !== 'skip') { if (!o.has('s')) ctx.error(shown + ': Is a directory'); status.error = true; }
          return;
        }
        if (!top && excludeDirs.some(function (g) { return globTest(g, basename(path)); })) return;
        var children = await ctx.vfs.readDir(path);
        for (var i = 0; i < children.length; i++) {
          var childShown = shown === '.' && implicitDot ? children[i].name : shown.replace(/\/$/, '') + '/' + children[i].name;
          if (await searchPath(resolvePath(path, children[i].name), childShown, false) === 'stop') return 'stop';
        }
        return;
      }
      var base = basename(path);
      if (!top || recursive) {
        if (includes.length && !includes.some(function (g) { return globTest(g, base); })) return;
        if (excludes.some(function (g) { return globTest(g, base); })) return;
      }
      var text;
      try { text = await ctx.readFile(path); }
      catch (e) { if (!o.has('s')) ctx.error(shown + ': ' + errorReason(e)); status.error = true; return; }
      return searchText(text, shown);
    }
    for (var k = 0; k < operands.length; k++) {
      var operand = operands[k];
      if (operand === '-') {
        if (searchText(ctx.stdin.readAll(), o.get('label') || '(standard input)') === 'stop') break;
        continue;
      }
      var resolved = ctx.resolve(operand);
      var r;
      if (/^\/dev\/(fd\/\d+|stdin)$/.test(resolved)) {
        try { r = searchText(await ctx.readFile(operand), operand); }
        catch (e) { ctx.error(operand + ': ' + errorReason(e)); status.error = true; }
      } else r = await searchPath(resolved, operand, true);
      if (r === 'stop') break;
    }
    ctx.stdout.write(out);
    if (quiet && anyMatch) return 0;
    if (status.error) return 2;
    return anyMatch ? 0 : 1;
  });

  // ---- rg (ripgrep) -------------------------------------------------------------
  var RG_TYPES = {
    c: ['*.c', '*.h'], cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.hxx', '*.h', '*.inl'], cs: ['*.cs'], csharp: ['*.cs'], css: ['*.css', '*.scss'],
    go: ['*.go'], html: ['*.html', '*.htm', '*.xhtml'], java: ['*.java'], js: ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.vue'], json: ['*.json', '*.jsonl'],
    kotlin: ['*.kt', '*.kts'], lua: ['*.lua'], make: ['Makefile', 'makefile', 'GNUmakefile', '*.mk', '*.mak'], markdown: ['*.md', '*.markdown', '*.mdx', '*.mkd'],
    md: ['*.md', '*.markdown', '*.mdx', '*.mkd'], php: ['*.php'], py: ['*.py', '*.pyi'], python: ['*.py', '*.pyi'], rb: ['*.rb', 'Gemfile', 'Rakefile'], ruby: ['*.rb', 'Gemfile', 'Rakefile'],
    rust: ['*.rs'], sh: ['*.sh', '*.bash', '*.zsh', '.bashrc', '.zshrc', '.profile'], sql: ['*.sql'], swift: ['*.swift'], toml: ['*.toml', 'Cargo.lock'],
    ts: ['*.ts', '*.tsx', '*.mts', '*.cts'], typescript: ['*.ts', '*.tsx', '*.mts', '*.cts'], txt: ['*.txt'], xml: ['*.xml', '*.xsd', '*.xsl', '*.svg'], yaml: ['*.yaml', '*.yml']
  };

  // .gitignore-style rule list. Rules are { re, negate, dirOnly, anchored, base }.
  function parseIgnoreFile(text, base) {
    var rules = [];
    lines(text).forEach(function (raw) {
      var line = raw.replace(/\r$/, '');
      if (!line.trim() || line.charAt(0) === '#') return;
      line = line.replace(/(?<!\\)\s+$/, '');
      var negate = line.charAt(0) === '!';
      if (negate) line = line.slice(1);
      if (line.charAt(0) === '\\') line = line.slice(1);
      var dirOnly = /\/$/.test(line);
      if (dirOnly) line = line.replace(/\/+$/, '');
      var anchored = line.indexOf('/') >= 0;
      line = line.replace(/^\//, '');
      rules.push({ glob: line, negate: negate, dirOnly: dirOnly, anchored: anchored, base: base });
    });
    return rules;
  }
  function ignoredBy(rules, absPath, isDir) {
    var result = null;
    rules.forEach(function (rule) {
      var prefix = rule.base === '/' ? '/' : rule.base + '/';
      if (absPath.indexOf(prefix) !== 0) return;
      if (rule.dirOnly && !isDir) return;
      var rel = absPath.slice(prefix.length);
      var target = rule.anchored ? rel : basename(absPath);
      if (globTest(rule.glob, target, { pathMode: true })) result = !rule.negate;
    });
    return result;
  }

  utility('rg', { usageCode: 2, usage: '[OPTIONS] PATTERN [PATH ...]' }, async function (ctx) {
    var o = getopt(ctx.args, {
      flags: 'iSsvwxFnNlLcoqHIzaUup0.', params: 'efABCmgtTrdjM',
      long: { regexp: { key: 'e', arg: true }, file: { key: 'f', arg: true }, 'ignore-case': 'i', 'smart-case': 'S', 'case-sensitive': 's', 'invert-match': 'v', 'word-regexp': 'w', 'line-regexp': 'x', 'fixed-strings': 'F', 'line-number': 'n', 'no-line-number': 'N', 'files-with-matches': 'l', 'files-without-match': 'fwm', count: 'c', 'count-matches': 'cm', 'only-matching': 'o', quiet: 'q', 'with-filename': 'H', 'no-filename': 'I', text: 'a', 'max-count': { key: 'm', arg: true }, 'after-context': { key: 'A', arg: true }, 'before-context': { key: 'B', arg: true }, context: { key: 'C', arg: true }, glob: { key: 'g', arg: true }, iglob: { key: 'iglob', arg: true }, type: { key: 't', arg: true }, 'type-not': { key: 'T', arg: true }, 'type-list': 'tl', replace: { key: 'r', arg: true }, 'max-depth': { key: 'd', arg: true }, maxdepth: { key: 'd', arg: true }, hidden: '.', 'no-hidden': 'nh', 'no-ignore': 'ni', 'no-ignore-vcs': 'niv', 'no-ignore-dot': 'nid', unrestricted: 'u', files: 'files', heading: 'heading', 'no-heading': 'noheading', pretty: 'p', vimgrep: 'vimgrep', column: 'column', 'no-column': 'nocolumn', null: '0', 'null-data': 'nd', sort: { key: 'sort', arg: true }, sortr: { key: 'sortr', arg: true }, 'sort-files': 'sortfiles', threads: { key: 'j', arg: true }, color: { key: 'color', arg: true }, colors: { key: 'colors', arg: true }, follow: 'L', 'no-messages': 'nomsg', 'no-config': 'nocfg', 'trim': 'trim', 'multiline': 'U', 'max-columns': { key: 'M', arg: true }, 'context-separator': { key: 'cs', arg: true }, 'field-match-separator': { key: 'fms', arg: true }, 'line-regexp-dummy': 'lrd', stats: 'stats', json: 'json', 'search-zip': 'z', 'require-git': 'rq', 'no-require-git': 'nrq' }
    });
    if (o.has('tl')) {
      ctx.stdout.write(Object.keys(RG_TYPES).sort().map(function (t) { return t + ': ' + RG_TYPES[t].join(', ') + '\n'; }).join(''));
      return 0;
    }
    if (o.has('json')) { ctx.error('--json is not supported by bash.js'); return 2; }
    var patterns = [], operands = o.operands.slice();
    o.list.forEach(function (p) { if (p[0] === 'e') patterns.push(String(p[1])); });
    var patternFiles = o.all('f');
    for (var pf = 0; pf < patternFiles.length; pf++) {
      try { patterns = patterns.concat(lines(await ctx.readFile(patternFiles[pf]))); }
      catch (e) { ctx.error(patternFiles[pf] + ': ' + errorReason(e)); return 2; }
    }
    var listFiles = o.has('files');
    if (!o.has('e') && !patternFiles.length && !listFiles) {
      if (!operands.length) { ctx.error('ripgrep requires at least one pattern to execute a search'); return 2; }
      patterns.push(operands.shift());
    }
    var unrestricted = o.all('u').length;
    var hidden = (o.has('.') || unrestricted >= 2) && !o.has('nh'), noIgnore = o.has('ni') || unrestricted >= 1;
    var caseMode = o.last(['i', 'S', 's']) || 's';
    var regexps = [];
    try {
      patterns.forEach(function (p) {
        var t = o.has('F') ? { source: escapeRegex(p), flags: '' } : translateRust(p);
        var icase = caseMode === 'i' || (caseMode === 'S' && !/[A-Z]/.test(p.replace(/\\./g, ''))) || t.flags.indexOf('i') >= 0;
        var source = t.source;
        if (o.has('x')) source = '^(?:' + source + ')$';
        else if (o.has('w')) source = '(?<![\\w])(?:' + source + ')(?![\\w])';
        regexps.push(new RegExp(source, (icase ? 'i' : '') + (t.flags.indexOf('s') >= 0 ? 's' : '') + (t.flags.indexOf('m') >= 0 ? 'm' : '')));
      });
    } catch (e) { ctx.error('regex parse error:\n    ' + patterns.join('|') + '\nerror: ' + e.message.replace(/^Invalid regular expression: /, '')); return 2; }
    var matcher = makeMatcher(regexps);
    var context = o.get('C') != null ? Number(o.get('C')) : 0;
    var after = o.get('A') != null ? Number(o.get('A')) : context, before = o.get('B') != null ? Number(o.get('B')) : context;
    var maxDepth = o.get('d') != null ? Number(o.get('d')) : Infinity;
    var globs = o.all('g').map(function (g) { return { glob: g.replace(/^!/, ''), negate: g.charAt(0) === '!', icase: false }; })
      .concat(o.all('iglob').map(function (g) { return { glob: g.replace(/^!/, ''), negate: g.charAt(0) === '!', icase: true }; }));
    var typesWanted = o.all('t'), typesNot = o.all('T'), errors = false;
    for (var ti = 0; ti < typesWanted.concat(typesNot).length; ti++) {
      if (!RG_TYPES[typesWanted.concat(typesNot)[ti]]) { ctx.error('unrecognized file type: ' + typesWanted.concat(typesNot)[ti]); return 2; }
    }
    function typeOk(name) {
      function inType(t) { return RG_TYPES[t].some(function (g) { return globTest(g, name); }); }
      if (typesWanted.length && !typesWanted.some(inType)) return false;
      return !typesNot.some(inType);
    }
    function globOk(rel, isDir) {
      if (!globs.length) return true;
      var result = null, hasPositive = globs.some(function (g) { return !g.negate; });
      globs.forEach(function (g) {
        var target = g.glob.indexOf('/') >= 0 ? rel : basename(rel);
        if (globTest(g.glob.replace(/^\//, ''), target, { pathMode: true, icase: g.icase })) result = !g.negate;
      });
      if (result !== null) return result;
      return isDir ? true : !hasPositive;
    }
    // Ignore files: .gitignore (inside a git repository), .ignore and .rgignore.
    async function loadIgnores(dir, inRepo) {
      if (noIgnore) return [];
      var rules = [], names = (inRepo && !o.has('niv') ? ['.gitignore'] : []).concat(o.has('nid') ? [] : ['.ignore', '.rgignore']);
      for (var i = 0; i < names.length; i++) {
        var file = resolvePath(dir, names[i]);
        try { if (await ctx.vfs.isFile(file)) rules = rules.concat(parseIgnoreFile(await ctx.vfs.readFile(file), dir)); }
        catch (_) { /* unreadable ignore files are skipped */ }
      }
      return rules;
    }
    async function repoRoot(dir) {
      for (var d = dir; ; d = dirname(d)) {
        if (await ctx.vfs.exists(resolvePath(d, '.git'))) return d;
        if (d === '/') return null;
      }
    }
    var searchStdin = !operands.length && !listFiles && ctx.stdinRedirected;
    var implicitRoot = !operands.length;
    if (!operands.length) operands = searchStdin ? ['-'] : ['.'];
    var targets = [];
    for (var k = 0; k < operands.length; k++) {
      var operand = operands[k];
      if (operand === '-') { targets.push({ stdin: true, shown: '<stdin>' }); continue; }
      var abs = ctx.resolve(operand), st = await ctx.vfs.stat(abs);
      if (!st) { if (!o.has('nomsg')) ctx.error(operand + ': No such file or directory (os error 2)'); errors = true; continue; }
      if (st.type !== 'dir') { targets.push({ path: abs, shown: operand, explicit: true }); continue; }
      var repo = await repoRoot(abs), rules = [];
      // Ignore files of ancestor directories apply as well.
      var chain = [];
      for (var d = dirname(abs); d !== abs; d = dirname(d)) { chain.unshift(d); if (d === '/') break; }
      for (var ci = 0; ci < chain.length; ci++) rules = rules.concat(await loadIgnores(chain[ci], !!repo && (chain[ci] + '/').indexOf(repo === '/' ? '/' : repo + '/') === 0));
      await (async function walk(dir, shown, depth, inherited) {
        var own = inherited.concat(await loadIgnores(dir, !!repo));
        var children;
        try { children = await ctx.vfs.readDir(dir); }
        catch (e) { ctx.error(shown + ': ' + errorReason(e)); errors = true; return; }
        for (var i = 0; i < children.length; i++) {
          var name = children[i].name, childAbs = resolvePath(dir, name);
          var childShown = implicitRoot && shown === '.' ? name : shown.replace(/\/$/, '') + '/' + name;
          var rel = childAbs.slice(abs === '/' ? 1 : abs.length + 1);
          var isDir = children[i].type ? children[i].type === 'dir' : await ctx.vfs.isDir(childAbs);
          if (!hidden && name.charAt(0) === '.') continue;
          if (name === '.git' && isDir) continue;
          if (ignoredBy(own, childAbs, isDir)) continue;
          if (!globOk(rel, isDir)) continue;
          if (isDir) { if (depth + 1 < maxDepth) await walk(childAbs, childShown, depth + 1, own); continue; }
          if (!typeOk(name)) continue;
          targets.push({ path: childAbs, shown: childShown });
        }
      })(abs, operand, 0, rules);
    }
    targets.sort(function (a, b) { return a.stdin || b.stdin ? 0 : compareBytes(a.shown, b.shown); });
    if (listFiles) {
      var listed = targets.filter(function (t) { return !t.stdin; }).map(function (t) { return t.shown + (o.has('0') ? '\0' : '\n'); }).join('');
      ctx.stdout.write(listed);
      return errors ? 2 : (listed ? 0 : 1);
    }
    var showNames = o.has('H') ? true : o.has('I') ? false : !(targets.length === 1 && (targets[0].explicit || targets[0].stdin) && operands.length === 1);
    var heading = o.has('heading') || o.has('p');
    if (o.has('noheading')) heading = false;
    var lineNumbers = (o.has('n') || o.has('p') || o.has('vimgrep')) && !o.has('N');
    var anyMatch = false, out = '', state = { printed: false }, firstFile = true;
    var replaceSource = regexps.length ? regexps.map(function (r) { return '(?:' + r.source + ')'; }).join('|') : '';
    var replaceFlags = regexps.length && regexps[0].flags.indexOf('i') >= 0 ? 'i' : '';
    var replacement = o.get('r') != null ? String(o.get('r')).replace(/\$(\d+|\{\w+\})/g, function (m) { return m.replace(/[{}]/g, ''); }) : null;
    for (var t = 0; t < targets.length; t++) {
      var target = targets[t], text;
      try { text = target.stdin ? ctx.stdin.readAll() : await ctx.readFile(target.path); }
      catch (e) { ctx.error(target.shown + ': ' + errorReason(e)); errors = true; continue; }
      if (!o.has('a') && isBinary(text)) {
        if (target.explicit && matcher.test(text)) {
          anyMatch = true;
          if (!o.has('q')) out += 'binary file matches (found "\\0" byte around offset ' + text.indexOf('\0') + ')\n';
        }
        continue;
      }
      var quietBody = o.has('q') || o.has('l') || o.has('fwm') || o.has('c') || o.has('cm');
      var fileOut = '';
      var result = scanLines(text, matcher, {
        sep: '\n', invert: o.has('v'), onlyMatching: o.has('o'), maxCount: o.get('m') != null ? Number(o.get('m')) : 0,
        before: quietBody ? 0 : before, after: quietBody ? 0 : after, lineNumber: lineNumbers,
        name: showNames && !heading ? target.shown : null, nullName: o.has('0'), quietBody: quietBody,
        stopAtFirst: o.has('q') || o.has('l') || o.has('fwm'), vimgrep: o.has('vimgrep'), column: (o.has('column') || o.has('vimgrep')) && !o.has('nocolumn'),
        replace: replacement, replaceSource: replaceSource, replaceFlags: replaceFlags, groupSeparator: o.get('cs')
      }, function (s) { fileOut += s; }, heading ? { printed: false } : state);
      if (result.matched) anyMatch = true;
      if (o.has('q') && result.matched) break;
      if (o.has('l')) { if (result.matched) out += target.shown + (o.has('0') ? '\0' : '\n'); continue; }
      if (o.has('fwm')) { if (!result.matched) out += target.shown + (o.has('0') ? '\0' : '\n'); continue; }
      if (o.has('c') || o.has('cm')) {
        if (!result.matched) continue;
        var n = o.has('cm') ? lines(text).reduce(function (sum, line) { return sum + matcher.matches(line).length; }, 0) : result.count;
        out += (showNames ? target.shown + ':' : '') + n + '\n';
        continue;
      }
      if (!fileOut) continue;
      if (heading) {
        out += (firstFile ? '' : '\n') + (showNames ? target.shown + '\n' : '') + fileOut;
      } else out += fileOut;
      firstFile = false;
    }
    ctx.stdout.write(out);
    if (errors) return 2;
    return anyMatch ? 0 : 1;
  });

  // ---- find -----------------------------------------------------------------------
  utility('find', { usage: '[-H] [-L] [-P] [path...] [expression]' }, async function (ctx) {
    var args = ctx.args.slice(), i = 0;
    while (i < args.length && /^-[HLP]$/.test(args[i])) i++;
    var paths = [];
    while (i < args.length && (!/^[-(!]/.test(args[i]) || args[i] === '-')) { paths.push(args[i]); i++; }
    var tokens = args.slice(i), pos = 0, hasAction = false, maxDepth = Infinity, minDepth = 0, depthFirst = false, regexType = 'EMACS';
    var now = ctx.now(), status = 0, quit = false, batches = [], newerNodes = [];
    if (!paths.length) paths = ['.'];
    function fail(message) { throw new UsageError(message); }
    function needArg(name) { if (pos >= tokens.length) fail('missing argument to ' + quoteName(name)); return tokens[pos++]; }
    function numericTest(raw, name) {
      var m = String(raw).match(/^([+-]?)(\d+)$/);
      if (!m) fail('invalid argument ' + quoteName(raw) + ' to ' + quoteName(name));
      var n = Number(m[2]);
      return function (v) { return m[1] === '+' ? v > n : m[1] === '-' ? v < n : v === n; };
    }
    function parsePrimary() {
      var tok = tokens[pos++];
      switch (tok) {
        case '(': { var inner = parseList(); if (tokens[pos] !== ')') fail("invalid expression; I was expecting to find a ')' somewhere but did not see one."); pos++; return inner; }
        case '!': case '-not': { var negated = parseUnary(); return { type: 'not', expr: negated }; }
        case '-name': case '-iname': { var glob = needArg(tok); return { type: 'name', glob: glob, icase: tok === '-iname' }; }
        case '-path': case '-wholename': case '-ipath': case '-iwholename': { var pglob = needArg(tok); return { type: 'path', glob: pglob, icase: tok.charAt(1) === 'i' }; }
        case '-regex': case '-iregex': { var rx = needArg(tok); return { type: 'regex', re: new RegExp('^(?:' + translateRegex(rx, regexType) + ')$', tok === '-iregex' ? 'i' : '') }; }
        case '-type': case '-xtype': {
          var types = needArg(tok).split(',');
          types.forEach(function (t) { if (!/^[fdlbcps]$/.test(t)) fail('Unknown argument to ' + tok + ': ' + t); });
          return { type: 'type', types: types };
        }
        case '-size': {
          var raw = needArg(tok), sm = raw.match(/^([+-]?)(\d+)([bcwkMG]?)$/);
          if (!sm) fail('invalid -size type ' + quoteName(raw));
          var unit = { '': 512, b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 }[sm[3]];
          return { type: 'size', sign: sm[1], n: Number(sm[2]), unit: unit };
        }
        case '-empty': return { type: 'empty' };
        case '-mtime': case '-mmin': case '-atime': case '-amin': case '-ctime': case '-cmin': { return { type: 'time', unit: /min$/.test(tok) ? 60000 : 86400000, test: numericTest(needArg(tok), tok) }; }
        case '-newer': case '-anewer': case '-cnewer': { var newer = { type: 'newer', ref: needArg(tok) }; newerNodes.push(newer); return newer; }
        case '-maxdepth': maxDepth = Number(needArg(tok)); return { type: 'true' };
        case '-mindepth': minDepth = Number(needArg(tok)); return { type: 'true' };
        case '-depth': case '-d': depthFirst = true; return { type: 'true' };
        case '-regextype': { var rt = needArg(tok); regexType = { emacs: 'EMACS', 'posix-basic': 'BRE', 'posix-extended': 'ERE', 'posix-egrep': 'ERE', egrep: 'ERE', grep: 'BRE', 'findutils-default': 'EMACS', 'gnu-awk': 'ERE', awk: 'ERE', 'posix-awk': 'ERE', sed: 'BRE' }[rt]; if (!regexType) fail('Unknown regular expression type ' + quoteName(rt)); return { type: 'true' }; }
        case '-xdev': case '-mount': case '-follow': case '-noleaf': case '-daystart': case '-ignore_readdir_race': case '-nowarn': case '-warn': return { type: 'true' };
        case '-true': return { type: 'true' };
        case '-false': return { type: 'false' };
        case '-readable': case '-writable': return { type: 'true' };
        case '-executable': return { type: 'executable' };
        case '-perm': { var perm = needArg(tok); return { type: 'perm', perm: perm }; }
        case '-user': case '-group': case '-uid': case '-gid': needArg(tok); return { type: 'true' };
        case '-nouser': case '-nogroup': return { type: 'false' };
        case '-links': { return { type: 'links', test: numericTest(needArg(tok), tok) }; }
        case '-prune': return { type: 'prune' };
        case '-quit': return { type: 'quit' };
        case '-print': hasAction = true; return { type: 'print', end: '\n' };
        case '-print0': hasAction = true; return { type: 'print', end: '\0' };
        case '-printf': hasAction = true; return { type: 'printf', format: needArg(tok) };
        case '-fprint': case '-fprint0': hasAction = true; return { type: 'fprint', file: needArg(tok), end: tok === '-fprint0' ? '\0' : '\n' };
        case '-ls': hasAction = true; return { type: 'ls' };
        case '-delete': hasAction = true; depthFirst = true; return { type: 'delete' };
        case '-exec': case '-execdir': case '-ok': case '-okdir': {
          hasAction = true;
          var command = [];
          while (pos < tokens.length && tokens[pos] !== ';' && !(tokens[pos] === '+' && command[command.length - 1] === '{}')) command.push(tokens[pos++]);
          if (pos >= tokens.length || !command.length) fail('missing argument to ' + quoteName(tok));
          var batch = tokens[pos++] === '+';
          var node = { type: 'exec', command: command, batch: batch, dir: /dir$/.test(tok), pending: [] };
          if (batch) batches.push(node);
          return node;
        }
      }
      if (tok === undefined) fail('expected an expression');
      if (tok.charAt(0) === '-') throw new UsageError('unknown predicate `' + tok + "'", { noTry: true });
      fail('paths must precede expression: ' + quoteName(tok));
    }
    function parseUnary() {
      if (tokens[pos] === '!' || tokens[pos] === '-not') { pos++; return { type: 'not', expr: parseUnary() }; }
      return parsePrimary();
    }
    function parseAnd() {
      var left = parseUnary();
      while (pos < tokens.length && tokens[pos] !== ')' && tokens[pos] !== '-o' && tokens[pos] !== '-or' && tokens[pos] !== ',') {
        if (tokens[pos] === '-a' || tokens[pos] === '-and') pos++;
        left = { type: 'and', left: left, right: parseUnary() };
      }
      return left;
    }
    function parseOr() {
      var left = parseAnd();
      while (tokens[pos] === '-o' || tokens[pos] === '-or') { pos++; left = { type: 'or', left: left, right: parseAnd() }; }
      return left;
    }
    function parseList() {
      var left = parseOr();
      while (tokens[pos] === ',') { pos++; left = { type: 'list', left: left, right: parseOr() }; }
      return left;
    }
    var expr = tokens.length ? parseList() : { type: 'true' };
    if (pos < tokens.length) fail(tokens[pos] === ')' ? "invalid expression; you have too many ')'" : 'paths must precede expression: ' + quoteName(tokens[pos]));
    if (!hasAction) expr = { type: 'and', left: expr, right: { type: 'print', end: '\n' } };
    // Reference files are checked once, before the walk, like GNU find.
    for (var nn = 0; nn < newerNodes.length; nn++) {
      newerNodes[nn].refStat = await ctx.vfs.stat(ctx.resolve(newerNodes[nn].ref));
      if (!newerNodes[nn].refStat) { ctx.error(quoteName(newerNodes[nn].ref) + ': No such file or directory'); return 1; }
    }
    var out = '';
    function flushOut() { if (out) { ctx.stdout.write(out); out = ''; } }
    function substitute(command, file) {
      var shown = file.dirMode ? './' + file.name : file.shown;
      return command.map(function (part) { return part.split('{}').join(shown); });
    }
    function printfFind(format, file) {
      return decodeEscapes(format.replace(/\\c[\s\S]*$/, ''), 'fmt').text.replace(/%(-?\d*)([%pfhPsdyYmMtTaAg]|[TAC][a-zA-Z@])/g, function (_, width, directive) {
        var value;
        switch (directive.charAt(0)) {
          case '%': return '%';
          case 'p': value = file.shown; break;
          case 'f': value = file.name; break;
          case 'h': value = posixDirname(file.shown); if (file.depth === 0 && file.shown.indexOf('/') < 0) value = '.'; break;
          case 'P': value = file.rel; break;
          case 's': value = String(file.st.type === 'dir' ? 4096 : file.st.size || 0); break;
          case 'd': value = String(file.depth); break;
          case 'y': case 'Y': value = file.st.type === 'dir' ? 'd' : 'f'; break;
          case 'm': value = ((file.st.mode != null ? file.st.mode : file.st.type === 'dir' ? 493 : 420) & 4095).toString(8); break;
          case 'M': value = modeString(file.st.type, file.st.mode); break;
          case 'g': value = ctx.env.USER || 'user'; break;
          case 'T': case 'A': case 'C': {
            var when = file.st.mtime != null ? new Date(file.st.mtime) : now;
            value = directive.length > 1 ? (directive.charAt(1) === '@' ? String(when.getTime() / 1000) : strftime(when, '%' + directive.charAt(1), normalizeZone(ctx.timezone))) : strftime(when, '%a %b %e %H:%M:%S.0000000000 %Y', normalizeZone(ctx.timezone));
            break;
          }
          case 't': case 'a': value = strftime(file.st.mtime != null ? new Date(file.st.mtime) : now, '%a %b %e %H:%M:%S.0000000000 %Y', normalizeZone(ctx.timezone)); break;
          default: value = '';
        }
        var w = Number(width.replace('-', '')) || 0;
        return width.charAt(0) === '-' ? value.padEnd(w) : value.padStart(w);
      });
    }
    async function evaluate(node, file) {
      switch (node.type) {
        case 'true': return true;
        case 'false': return false;
        case 'not': return !(await evaluate(node.expr, file));
        case 'and': return (await evaluate(node.left, file)) && evaluate(node.right, file);
        case 'or': return (await evaluate(node.left, file)) || evaluate(node.right, file);
        case 'list': await evaluate(node.left, file); return evaluate(node.right, file);
        case 'name': return globTest(node.glob, file.name, { icase: node.icase });
        case 'path': return globTest(node.glob, file.shown, { icase: node.icase });
        case 'regex': return node.re.test(file.shown);
        case 'type': return node.types.indexOf(file.st.type === 'dir' ? 'd' : 'f') >= 0;
        case 'size': {
          var bytes = file.st.type === 'dir' ? 4096 : (file.st.size || 0), units = Math.ceil(bytes / node.unit);
          return node.sign === '+' ? units > node.n : node.sign === '-' ? units < node.n : units === node.n;
        }
        case 'empty':
          if (file.st.type === 'dir') return !(await ctx.vfs.readDir(file.path)).length;
          return !file.st.size;
        case 'time': {
          var mtime = file.st.mtime != null ? +new Date(file.st.mtime) : +now;
          return node.test(Math.floor((+now - mtime) / node.unit));
        }
        case 'newer':
          return file.st.mtime != null && node.refStat.mtime != null && +new Date(file.st.mtime) > +new Date(node.refStat.mtime);
        case 'executable': return file.st.type === 'dir' || (file.st.mode != null && (file.st.mode & 73) !== 0);
        case 'perm': {
          var mode = (file.st.mode != null ? file.st.mode : file.st.type === 'dir' ? 493 : 420) & 4095, spec = node.perm.replace(/^[-\/]/, ''), want = parseInt(spec, 8);
          if (isNaN(want)) return false;
          return node.perm.charAt(0) === '-' ? (mode & want) === want : node.perm.charAt(0) === '/' ? (mode & want) !== 0 : mode === want;
        }
        case 'links': return node.test(file.st.type === 'dir' ? 2 : 1);
        case 'prune': if (!depthFirst) file.pruned = true; return true;
        case 'quit': quit = true; return true;
        case 'print': out += file.shown + node.end; return true;
        case 'fprint': await ctx.vfs.writeFile(ctx.resolve(node.file), file.shown + node.end, { append: true }); return true;
        case 'printf': out += printfFind(node.format, file); return true;
        case 'ls': {
          var size = file.st.type === 'dir' ? 4096 : (file.st.size || 0), user = ctx.env.USER || 'user';
          var d = file.st.mtime != null ? new Date(file.st.mtime) : now;
          out += '      0 ' + String(Math.ceil(size / 4096) * 4).padStart(6) + ' ' + modeString(file.st.type, file.st.mode) + '   1 ' + user.padEnd(8) + ' ' + user.padEnd(8) + ' ' + String(size).padStart(8) + ' ' + MONTHS[d.getMonth()] + ' ' + String(d.getDate()).padStart(2) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + file.shown + '\n';
          return true;
        }
        case 'delete':
          try { await ctx.vfs.remove(file.path, {}); }
          catch (e) { ctx.error('cannot delete ' + quoteName(file.shown) + ': ' + errorReason(e)); status = 1; return false; }
          return true;
        case 'exec': {
          if (node.batch) { node.pending.push(file); return true; }
          flushOut();
          var code = await ctx.exec(substitute(node.command, file), { cwd: node.dir ? dirname(file.path) : undefined });
          return code === 0;
        }
      }
      return false;
    }
    async function runBatches() {
      for (var b = 0; b < batches.length; b++) {
        var node = batches[b];
        if (!node.pending.length) continue;
        flushOut();
        var groups = node.dir ? node.pending.map(function (f) { return [f]; }) : [node.pending];
        for (var g = 0; g < groups.length; g++) {
          var argv = node.command.slice(0, -1).concat(groups[g].map(function (f) { return node.dir ? './' + f.name : f.shown; }));
          if (await ctx.exec(argv, { cwd: node.dir ? dirname(groups[g][0].path) : undefined }) !== 0) status = 1;
        }
        node.pending = [];
      }
    }
    async function visit(path, shown, rel, depth) {
      if (quit) return;
      var st = await ctx.vfs.stat(path);
      if (!st) { ctx.error(quoteName(shown) + ': No such file or directory'); status = 1; return; }
      var file = { path: path, shown: shown, rel: rel, depth: depth, st: st, name: depth === 0 ? posixBasename(shown) || shown : basename(path), pruned: false };
      if (!depthFirst && depth >= minDepth) await evaluate(expr, file);
      if (st.type === 'dir' && !file.pruned && depth < maxDepth && !quit) {
        var children;
        try { children = await ctx.vfs.readDir(path); }
        catch (e) { ctx.error(quoteName(shown) + ': ' + errorReason(e)); status = 1; children = []; }
        for (var c = 0; c < children.length && !quit; c++) {
          var childShown = /\/$/.test(shown) ? shown + children[c].name : shown + '/' + children[c].name;
          await visit(resolvePath(path, children[c].name), childShown, rel ? rel + '/' + children[c].name : children[c].name, depth + 1);
        }
      }
      if (depthFirst && depth >= minDepth && !quit) await evaluate(expr, file);
    }
    for (var p = 0; p < paths.length && !quit; p++) await visit(ctx.resolve(paths[p]), paths[p], '', 0);
    flushOut();
    await runBatches();
    return status;
  });

  // ==========================================================================
  // §10 sed engine
  // ==========================================================================
  function SedError(message) { this.message = message; }

  // Characters that are special in the regex dialect and so must be escaped
  // when an escaped delimiter (`s|a\|b|`) stands for itself.
  function literalDelimiter(delim, ere) {
    var special = ere ? '.[]\\*^$+?(){}|/' : '.[]\\*^$/';
    return special.indexOf(delim) >= 0 ? '\\' + delim : delim;
  }

  function parseSedScript(script, ere) {
    var pos = 0, n = script.length, commands = [], blocks = [], wfiles = [];
    function fail(message, at) { throw new SedError('-e expression #1, char ' + (at == null ? pos : at) + ': ' + message); }
    function skipBlanks() { while (pos < n && (script[pos] === ' ' || script[pos] === '\t')) pos++; }
    function readToEol() { var start = pos; while (pos < n && script[pos] !== '\n') pos++; var text = script.slice(start, pos); if (pos < n) pos++; return text; }
    // Reads up to an unescaped delimiter. mode: 'regex' | 'replacement' | 'plain'.
    function readDelimited(delim, mode) {
      var out = '';
      while (pos < n) {
        var c = script[pos];
        if (c === '\\' && pos + 1 < n) {
          var d = script[pos + 1];
          pos += 2;
          if (d === delim) { out += mode === 'regex' ? literalDelimiter(delim, ere) : mode === 'replacement' && delim === '&' ? '\\&' : delim; continue; }
          if (d === '\n') { out += mode === 'regex' ? '\\n' : mode === 'replacement' ? '\\\n' : '\n'; continue; }
          out += c + d;
          continue;
        }
        if (c === delim) { pos++; return out; }
        if (c === '\n' && mode !== 'replacement') return null;
        out += c; pos++;
      }
      return null;
    }
    function compile(raw, flags) {
      if (raw === '') return null; // empty regex: reuse the last one at run time
      try {
        return new RegExp(translateRegex(raw, ere ? 'ERE' : 'BRE', { controlEscapes: true, bracketEscapes: 'control' }), 's' + (flags.indexOf('I') >= 0 ? 'i' : '') + (flags.indexOf('M') >= 0 ? 'm' : ''));
      } catch (e) { fail(e.message.replace(/^Invalid regular expression: .*: /, '')); }
    }
    function parseAddress() {
      var c = script[pos], m;
      if (c !== undefined && /\d/.test(c)) {
        m = script.slice(pos).match(/^(\d+)(?:~(\d+))?/); pos += m[0].length;
        if (m[2] !== undefined) return { type: 'step', first: Number(m[1]), step: Number(m[2]) };
        return { type: Number(m[1]) === 0 ? 'zero' : 'line', n: Number(m[1]) };
      }
      if (c === '$') { pos++; return { type: 'last' }; }
      if (c === '/' || c === '\\') {
        var delim = c === '/' ? '/' : script[pos + 1];
        pos += c === '/' ? 1 : 2;
        var raw = readDelimited(delim, 'regex');
        if (raw === null) fail('unterminated address regex');
        var flags = '';
        while (script[pos] === 'I' || script[pos] === 'M') flags += script[pos++];
        return { type: 're', re: compile(raw, flags) };
      }
      return null;
    }
    // Text argument of a, i, c (both `a\` + newline and the GNU one-line form).
    function readText() {
      skipBlanks();
      if (script[pos] === '\\') {
        pos++;
        skipBlanks();
        if (script[pos] === '\n') pos++;
      }
      if (pos >= n) fail('expected \\ after `a\', `c\' or `i\'');
      var out = '';
      while (pos < n) {
        var c = script[pos];
        if (c === '\\' && pos + 1 < n) { out += script[pos + 1]; pos += 2; continue; }
        if (c === '\n') { pos++; break; }
        out += c; pos++;
      }
      return out;
    }
    function readLabel() {
      skipBlanks();
      var start = pos;
      while (pos < n && script[pos] !== '\n' && script[pos] !== ';') pos++;
      return script.slice(start, pos).replace(/\s+$/, '');
    }
    function endOfCommand() {
      skipBlanks();
      if (pos >= n) return;
      var c = script[pos];
      if (c === ';' || c === '\n') { pos++; return; }
      if (c === '}' || c === '#') return;
      fail('extra characters after command', pos + 1);
    }
    while (true) {
      while (pos < n && /[\s;]/.test(script[pos])) pos++;
      if (pos >= n) break;
      if (script[pos] === '#') { readToEol(); continue; }
      var command = { a1: parseAddress(), a2: null, negate: false };
      if (command.a1 && script[pos] === ',') {
        pos++; skipBlanks();
        var m = script.slice(pos).match(/^([+~])(\d+)/);
        if (m) { pos += m[0].length; command.a2 = { type: m[1] === '+' ? 'plus' : 'mult', n: Number(m[2]) }; }
        else {
          command.a2 = parseAddress();
          if (!command.a2) fail('unexpected `,\'');
        }
      }
      if (command.a1 && command.a1.type === 'zero' && (!command.a2 || command.a2.type !== 're')) fail('invalid usage of line address 0');
      skipBlanks();
      while (script[pos] === '!') { command.negate = true; pos++; skipBlanks(); }
      var cmd = script[pos++];
      if (cmd === undefined) fail('missing command');
      command.cmd = cmd;
      switch (cmd) {
        case '{': blocks.push(commands.length); commands.push(command); continue;
        case '}':
          if (command.a1) fail('} doesn\'t want any addresses');
          if (!blocks.length) fail('unexpected `}\'');
          commands[blocks.pop()].end = commands.length + 1;
          commands.push(command); endOfCommand(); continue;
        case '=': case 'd': case 'D': case 'g': case 'G': case 'h': case 'H': case 'n': case 'N': case 'p': case 'P': case 'x': case 'z': case 'F':
          break;
        case 'l': case 'L': case 'q': case 'Q': {
          skipBlanks();
          var num = script.slice(pos).match(/^\d+/);
          if (num) { command.n = Number(num[0]); pos += num[0].length; }
          if ((cmd === 'q' || cmd === 'Q') && command.a2) fail('command only uses one address');
          break;
        }
        case 'a': case 'i': case 'c':
          command.text = readText(); commands.push(command); continue;
        case ':':
          if (command.a1) fail(': doesn\'t want any addresses');
          command.label = readLabel();
          if (!command.label) fail('":" lacks a label');
          commands.push(command); endOfCommand(); continue;
        case 'b': case 't': case 'T':
          command.label = readLabel(); break;
        case 'r': case 'R': case 'w': case 'W':
          skipBlanks(); command.file = readToEol();
          if (!command.file) fail('missing filename in r/R/w/W commands');
          if (cmd === 'w' || cmd === 'W') wfiles.push(command.file);
          commands.push(command); continue;
        case 's': {
          var delim = script[pos++];
          if (delim === undefined || delim === '\n' || delim === '\\') fail('unterminated `s\' command');
          var regex = readDelimited(delim, 'regex');
          if (regex === null) fail('unterminated `s\' command');
          var replacement = readDelimited(delim, 'replacement');
          if (replacement === null) fail('unterminated `s\' command');
          command.global = false; command.print = 0; command.nth = 1;
          var flags = '';
          while (pos < n) {
            var f = script[pos];
            if (f === 'g') { command.global = true; pos++; }
            else if (f === 'p') { command.print++; pos++; }
            else if (f === 'i' || f === 'I') { flags += 'I'; pos++; }
            else if (f === 'm' || f === 'M') { flags += 'M'; pos++; }
            else if (f === 'e') fail('the `e\' flag is not supported by bash.js');
            else if (/\d/.test(f)) { var nth = script.slice(pos).match(/^\d+/)[0]; command.nth = Number(nth); pos += nth.length; if (command.nth === 0) fail('number option to `s\' command may not be zero'); }
            else if (f === 'w') { pos++; skipBlanks(); command.file = readToEol(); wfiles.push(command.file); pos--; break; }
            else break;
          }
          if (command.file != null) pos++;
          else if (pos < n && !/[\s;}#]/.test(script[pos])) fail('unknown option to `s\'', pos + 1);
          command.re = compile(regex, flags);
          command.replacement = parseSedReplacement(replacement);
          if (command.file != null) { commands.push(command); continue; }
          break;
        }
        case 'y': {
          var yd = script[pos++];
          var src = readDelimited(yd, 'plain'), dst = src === null ? null : readDelimited(yd, 'plain');
          if (src === null || dst === null) fail('unterminated `y\' command');
          function unescapeY(s) { return s.replace(/\\(.)/g, function (_, c) { return c === 'n' ? '\n' : c === 't' ? '\t' : c; }); }
          src = Array.from(unescapeY(src)); dst = Array.from(unescapeY(dst));
          if (src.length !== dst.length) fail('strings for `y\' command are different lengths');
          command.map = new Map(src.map(function (c, k) { return [c, dst[k]]; }));
          break;
        }
        case 'v': readLabel(); commands.push(command); continue;
        case 'e': fail('the `e\' command is not supported by bash.js');
        default: fail('unknown command: `' + cmd + '\'');
      }
      commands.push(command);
      endOfCommand();
    }
    if (blocks.length) fail('unmatched `{\'', 0);
    var labels = {};
    commands.forEach(function (c, index) { if (c.cmd === ':') labels[c.label] = index; });
    commands.forEach(function (c) {
      if ((c.cmd === 'b' || c.cmd === 't' || c.cmd === 'T') && c.label) {
        if (!(c.label in labels)) throw Object.assign(new SedError('can\'t find label for jump to `' + c.label + '\''), { exitCode: 4 });
        c.target = labels[c.label];
      }
    });
    return { commands: commands, wfiles: wfiles };
  }

  // Replacement: & and \0-\9 groups, \n \t, case conversion \L \U \l \u \E.
  function parseSedReplacement(raw) {
    var parts = [], literal = '';
    function flush() { if (literal) { parts.push({ text: literal }); literal = ''; } }
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (c === '&') { flush(); parts.push({ group: 0 }); continue; }
      if (c !== '\\' || i + 1 >= raw.length) { literal += c; continue; }
      var d = raw[++i];
      if (/\d/.test(d)) { flush(); parts.push({ group: Number(d) }); }
      else if ('LUluE'.indexOf(d) >= 0) { flush(); parts.push({ caseOp: d }); }
      else if (d === 'n') literal += '\n';
      else if (d === 't') literal += '\t';
      else if (d === 'r') literal += '\r';
      else if (d === 'a') literal += '\x07';
      else if (d === 'f') literal += '\f';
      else if (d === 'v') literal += '\v';
      else literal += d;
    }
    flush();
    return parts;
  }
  function applySedReplacement(parts, match) {
    var out = '', mode = null, once = null;
    function add(text) {
      if (!text) return;
      if (once) { out += once === 'u' ? text.charAt(0).toUpperCase() : text.charAt(0).toLowerCase(); text = text.slice(1); once = null; }
      out += mode === 'U' ? text.toUpperCase() : mode === 'L' ? text.toLowerCase() : text;
    }
    parts.forEach(function (p) {
      if (p.caseOp) {
        if (p.caseOp === 'u' || p.caseOp === 'l') once = p.caseOp;
        else { mode = p.caseOp === 'E' ? null : p.caseOp; once = null; }
      } else if (p.group != null) add(match[p.group] == null ? '' : match[p.group]);
      else add(p.text);
    });
    return out;
  }

  // `l` output: C escapes, octal for other non-printables, wrapped lines ending in `\`.
  function sedListing(text, width) {
    var pieces = [];
    Array.prototype.forEach.call(toBytes(text), function (b) {
      var named = { 92: '\\\\', 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' };
      if (named[b]) pieces.push(named[b]);
      else if (b < 32 || b >= 127) pieces.push('\\' + b.toString(8).padStart(3, '0'));
      else pieces.push(String.fromCharCode(b));
    });
    var out = '', column = 0;
    pieces.forEach(function (p) {
      if (width > 1 && column + p.length > width - 1) { out += '\\\n'; column = 0; }
      out += p; column += p.length;
    });
    return out + '$\n';
  }

  // Runs a parsed program over one stream of input records.
  async function runSedStream(ctx, program, sources, o, shared) {
    var commands = program.commands, sep = o.sep, recs = [];
    sources.forEach(function (s) { records(s.text, sep).forEach(function (r) { recs.push({ text: r, file: s.name }); }); });
    var out = '', missingNewline = false, index = 0;
    var ranges = commands.map(function (c) { return { active: !!(c.a1 && c.a1.type === 'zero'), end: 0 }; });
    function write(text) { if (!text) return; if (missingNewline) { out += sep; missingNewline = false; } out += text; }
    function writeLine(text, newline) { if (missingNewline) { out += sep; missingNewline = false; } out += text; if (newline) out += sep; else missingNewline = true; }
    function nextRecord() {
      if (index >= recs.length) return null;
      var r = recs[index++];
      shared.lineNo++;
      shared.file = r.file;
      shared.newline = r.text.charAt(r.text.length - 1) === sep;
      return shared.newline ? r.text.slice(0, -1) : r.text;
    }
    function atLast() { return index >= recs.length && shared.lastStream; }
    function regexFor(re) {
      if (re) { shared.lastRegex = re; return re; }
      if (!shared.lastRegex) throw new SedError('no previous regular expression');
      return shared.lastRegex;
    }
    function matchOne(addr, ps) {
      switch (addr.type) {
        case 'line': return shared.lineNo === addr.n;
        case 'last': return atLast();
        case 'step': return addr.step <= 0 ? shared.lineNo === addr.first : shared.lineNo >= addr.first && (shared.lineNo - addr.first) % addr.step === 0;
        case 're': { var re = regexFor(addr.re); re.lastIndex = 0; return re.test(ps); }
      }
      return false;
    }
    function selected(c, k, ps) {
      if (!c.a1) return !c.negate;
      var hit;
      if (!c.a2) hit = matchOne(c.a1, ps);
      else {
        var st = ranges[k];
        if (!st.active) {
          hit = matchOne(c.a1, ps);
          if (hit) {
            var a2 = c.a2;
            if (a2.type === 'line') st.active = a2.n > shared.lineNo;
            else if (a2.type === 'plus') { st.active = a2.n > 0; st.end = shared.lineNo + a2.n; }
            else if (a2.type === 'mult') { st.end = a2.n <= 0 ? shared.lineNo : Math.ceil(shared.lineNo / a2.n) * a2.n; st.active = st.end > shared.lineNo; }
            else if (a2.type === 'last') st.active = !atLast();
            else st.active = true;
          }
        } else {
          hit = true;
          var b = c.a2;
          if (b.type === 'line') { if (shared.lineNo >= b.n) st.active = false; }
          else if (b.type === 'plus' || b.type === 'mult') { if (shared.lineNo >= st.end) st.active = false; }
          else if (b.type === 'last') { if (atLast()) st.active = false; }
          else if (matchOne(b, ps)) st.active = false;
        }
      }
      return c.negate ? !hit : hit;
    }
    async function readFileText(name) {
      if (name === '/dev/stdin') return ctx.stdin.readAll();
      try { return await ctx.readFile(name); } catch (_) { return null; }
    }
    async function flushQueue(queue) {
      for (var q = 0; q < queue.length; q++) {
        var item = queue[q];
        if (item.text != null) write(item.text);
        // GNU copies `r` files verbatim, even without a final newline.
        else if (item.file != null) { var content = await readFileText(item.file); if (content) write(content); }
      }
    }
    function writeFile(name, text) {
      if (name === '/dev/stdout') { write(text); return; }
      if (name === '/dev/stderr') { ctx.stderr.write(text); return; }
      shared.wfiles.set(name, (shared.wfiles.get(name) || '') + text);
    }
    var ps = null, hold = shared.hold, restart = false;
    while (!shared.quit) {
      if (!restart) { ps = nextRecord(); if (ps === null) break; shared.replaced = false; }
      restart = false;
      var queue = [], autoprint = !o.quiet, pc = 0, endCycle = false;
      while (pc < commands.length && !endCycle) {
        var c = commands[pc];
        if (c.cmd === '}' || c.cmd === ':') { pc++; continue; }
        if (!selected(c, pc, ps)) { pc = c.cmd === '{' ? c.end : pc + 1; continue; }
        pc++;
        switch (c.cmd) {
          case '{': break;
          case '=': write(shared.lineNo + '\n'); break;
          case 'a': queue.push({ text: c.text + '\n' }); break;
          case 'i': write(c.text + '\n'); break;
          case 'c':
            if (!c.a2 || c.negate || !ranges[pc - 1].active) write(c.text + '\n');
            autoprint = false; endCycle = true; break;
          case 'd': autoprint = false; endCycle = true; break;
          case 'D':
            if (ps.indexOf('\n') < 0) { autoprint = false; endCycle = true; break; }
            ps = ps.slice(ps.indexOf('\n') + 1); autoprint = false; endCycle = true; restart = true; break;
          case 'g': ps = hold; break;
          case 'G': ps += '\n' + hold; break;
          case 'h': hold = ps; break;
          case 'H': hold += '\n' + ps; break;
          case 'x': { var t = ps; ps = hold; hold = t; break; }
          case 'l': write(sedListing(ps, c.n != null ? c.n : o.lineWrap)); break;
          case 'n':
            if (index >= recs.length) { shared.quit = true; endCycle = true; break; }
            if (!o.quiet) writeLine(ps, shared.newline);
            ps = nextRecord(); break;
          case 'N':
            if (index >= recs.length) { shared.quit = true; endCycle = true; break; }
            ps += '\n' + nextRecord(); break;
          case 'p': writeLine(ps, true); break;
          case 'P': writeLine(ps.split('\n')[0], true); break;
          case 'q': shared.quit = true; shared.exitCode = c.n || 0; endCycle = true; break;
          case 'Q': shared.quit = true; shared.exitCode = c.n || 0; autoprint = false; endCycle = true; queue = []; break;
          case 'r': queue.push({ file: c.file }); break;
          case 'R': {
            if (!shared.rfiles.has(c.file)) { var rtext = await readFileText(c.file); shared.rfiles.set(c.file, rtext == null ? [] : records(rtext)); }
            var pending = shared.rfiles.get(c.file);
            if (pending.length) { var rline = pending.shift(); queue.push({ text: rline.charAt(rline.length - 1) === '\n' ? rline : rline + '\n' }); }
            break;
          }
          case 'w': writeFile(c.file, ps + '\n'); break;
          case 'W': writeFile(c.file, ps.split('\n')[0] + '\n'); break;
          case 'b': pc = c.target != null ? c.target : commands.length; break;
          case 't': if (shared.replaced) { shared.replaced = false; pc = c.target != null ? c.target : commands.length; } break;
          case 'T': if (!shared.replaced) pc = c.target != null ? c.target : commands.length; else shared.replaced = false; break;
          case 'y': ps = Array.from(ps).map(function (ch) { return c.map.has(ch) ? c.map.get(ch) : ch; }).join(''); break;
          case 'z': ps = ''; break;
          case 'F': write((shared.file === '-' ? '-' : shared.file) + '\n'); break;
          case 's': {
            var re = regexFor(c.re), g = new RegExp(re.source, re.flags + 'g'), result = '', last = 0, count = 0, did = false, prevEnd = -1, m;
            while ((m = g.exec(ps))) {
              if (m[0] === '' && m.index === prevEnd) { g.lastIndex++; if (g.lastIndex > ps.length) break; continue; }
              count++;
              if (count >= c.nth) {
                result += ps.slice(last, m.index) + applySedReplacement(c.replacement, m);
                last = m.index + m[0].length; did = true;
                if (!c.global) break;
              }
              prevEnd = m.index + m[0].length;
              if (m[0] === '') { g.lastIndex++; if (g.lastIndex > ps.length) break; }
            }
            if (did) {
              ps = result + ps.slice(last);
              shared.replaced = true;
              for (var pp = 0; pp < c.print; pp++) writeLine(ps, true);
              if (c.file != null) writeFile(c.file, ps + '\n');
            }
            break;
          }
        }
      }
      if (autoprint) writeLine(ps, shared.newline);
      await flushQueue(queue);
    }
    shared.hold = hold;
    return out;
  }

  utility('sed', { usage: '[OPTION]... {script-only-if-no-other-script} [input-file]...' }, async function (ctx) {
    // -i takes an optional attached suffix: `-i.bak`, `-ni` (no suffix), `-in` (suffix "n").
    var args = [];
    ctx.args.forEach(function (a) {
      var m = /^-([nrEsuzb]*)i(.*)$/.exec(a);
      if (m && a.slice(0, 2) !== '--') { if (m[1]) args.push('-' + m[1]); args.push('--in-place=' + m[2]); }
      else args.push(a);
    });
    var o = getopt(args, {
      flags: 'nrEsuzb', params: 'efl',
      long: { quiet: 'n', silent: 'n', expression: { key: 'e', arg: true }, file: { key: 'f', arg: true }, 'in-place': { key: 'i', arg: 'optional' }, 'line-length': { key: 'l', arg: true }, 'regexp-extended': 'E', separate: 's', unbuffered: 'u', 'null-data': 'z', 'zero-terminated': 'z', posix: 'posix', debug: 'debug', sandbox: 'sandbox', 'follow-symlinks': 'fs', binary: 'b' }
    });
    var chunks = [], operands = o.operands.slice();
    for (var k = 0; k < o.list.length; k++) {
      var p = o.list[k];
      if (p[0] === 'e') chunks.push(String(p[1]));
      if (p[0] === 'f') {
        try { chunks.push((await ctx.readFile(p[1])).replace(/\n$/, '')); }
        catch (e) { ctx.error("couldn't open file " + p[1] + ': ' + errorReason(e)); return 1; }
      }
    }
    if (!chunks.length) {
      if (!operands.length) { ctx.stderr.write('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n'); return 1; }
      chunks.push(operands.shift());
    }
    var script = chunks.join('\n'), quiet = o.has('n');
    if (/^#n(\n|$)/.test(script)) quiet = true;
    var ere = o.has('E') || o.has('r'), program;
    try { program = parseSedScript(script, ere); }
    catch (e) { if (e instanceof SedError) { ctx.error(e.message); return e.exitCode || 1; } throw e; }
    var inPlace = o.has('i'), suffix = inPlace && o.get('i') !== true ? o.get('i') : '';
    var options = { quiet: quiet, sep: o.has('z') ? '\0' : '\n', lineWrap: o.get('l') != null ? Number(o.get('l')) : 70 };
    var shared = { lineNo: 0, hold: '', quit: false, exitCode: 0, replaced: false, lastRegex: null, wfiles: new Map(), rfiles: new Map(), file: '-', newline: true, lastStream: true };
    program.wfiles.forEach(function (f) { if (f !== '/dev/stdout' && f !== '/dev/stderr') shared.wfiles.set(f, ''); });
    if (!operands.length) operands = ['-'];
    var status = 0, sources = [];
    for (var i = 0; i < operands.length; i++) {
      var name = operands[i];
      if (inPlace && name === '-') { ctx.error("couldn't edit -: not a regular file"); status = 4; continue; }
      try {
        if (name !== '-') {
          var st = await ctx.vfs.stat(ctx.resolve(name));
          if (st && st.type === 'dir') { ctx.error(inPlace ? "couldn't edit " + name + ': not a regular file' : 'read error on ' + name + ': Is a directory'); status = inPlace ? 4 : 2; continue; }
        }
        sources.push({ name: name, text: await ctx.readFile(name) });
      } catch (e) { ctx.error("can't read " + name + ': ' + errorReason(e)); status = 2; }
    }
    try {
      if (inPlace || o.has('s')) {
        for (var s = 0; s < sources.length && !shared.quit; s++) {
          shared.lineNo = 0;
          shared.lastStream = true;
          var result = await runSedStream(ctx, program, [sources[s]], options, shared);
          if (inPlace) {
            var target = ctx.resolve(sources[s].name);
            if (suffix) {
              var backup = suffix.indexOf('*') >= 0 ? suffix.replace(/\*/g, basename(target)) : basename(target) + suffix;
              await ctx.vfs.writeFile(backup.indexOf('/') >= 0 ? ctx.resolve(backup) : resolvePath(dirname(target), backup), sources[s].text);
            }
            await ctx.vfs.writeFile(target, result);
          } else ctx.stdout.write(result);
        }
      } else {
        ctx.stdout.write(await runSedStream(ctx, program, sources, options, shared));
      }
    } catch (e) { if (e instanceof SedError) { ctx.error(e.message); return 4; } throw e; }
    var names = Array.from(shared.wfiles.keys());
    for (var w = 0; w < names.length; w++) await ctx.vfs.writeFile(ctx.resolve(names[w]), shared.wfiles.get(names[w]));
    return shared.quit && shared.exitCode ? shared.exitCode : status;
  });

  // ==========================================================================
  // §11 awk engine (POSIX awk plus common gawk extensions)
  // ==========================================================================
  function AwkError(message, exitCode) { this.message = message; this.exitCode = exitCode == null ? 2 : exitCode; }
  var AWK_KEYWORDS = { BEGIN: 1, END: 1, 'function': 1, func: 1, 'if': 1, 'else': 1, 'while': 1, 'for': 1, 'do': 1, 'break': 1, 'continue': 1, next: 1, nextfile: 1, exit: 1, 'return': 1, 'delete': 1, 'in': 1, getline: 1, print: 1, printf: 1 };
  var AWK_BUILTINS = { length: 1, substr: 1, index: 1, split: 1, sub: 1, gsub: 1, match: 1, sprintf: 1, sin: 1, cos: 1, atan2: 1, exp: 1, log: 1, sqrt: 1, 'int': 1, rand: 1, srand: 1, tolower: 1, toupper: 1, system: 1, close: 1, fflush: 1, gensub: 1, strftime: 1, systime: 1, mktime: 1, asort: 1, asorti: 1, and: 1, or: 1, xor: 1, lshift: 1, rshift: 1, compl: 1, strtonum: 1 };

  function awkUnescape(text) {
    return text.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|[\s\S])/g, function (_, e) {
      if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
      if (e.charAt(0) === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
      return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', '/': '/' }[e] || e;
    });
  }

  function lexAwk(source) {
    var tokens = [], i = 0, line = 1, n = source.length;
    function push(type, value, start) { tokens.push({ type: type, value: value, line: line, start: start }); }
    function regexAllowed() {
      var last = tokens[tokens.length - 1];
      if (!last) return true;
      if (last.type === 'num' || last.type === 'str' || last.type === 'name' || last.type === 'builtin' || last.type === 'ere') return false;
      if (last.type === 'op' && (last.value === ')' || last.value === ']' || last.value === '$' || last.value === '++' || last.value === '--')) return false;
      if (last.type === 'kw' && last.value === 'getline') return false;
      return true;
    }
    var ops = ['**=', '**', '+=', '-=', '*=', '/=', '%=', '^=', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '>>', '!~', '{', '}', '(', ')', '[', ']', ';', ',', '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':', '~', '$', '='];
    while (i < n) {
      var c = source[i], start = i;
      if (c === '\\' && source[i + 1] === '\n') { i += 2; line++; continue; }
      if (c === '\\' && source[i + 1] === '\r' && source[i + 2] === '\n') { i += 3; line++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\n') { push('newline', '\n', start); line++; i++; continue; }
      if (c === '#') { while (i < n && source[i] !== '\n') i++; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] || ''))) {
        var num = source.slice(i).match(/^0[xX][0-9a-fA-F]+/) || source.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
        push('num', /^0[xX]/.test(num[0]) ? parseInt(num[0], 16) : Number(num[0]), start); i += num[0].length; continue;
      }
      if (c === '"') {
        var j = i + 1, raw = '';
        while (j < n && source[j] !== '"') {
          if (source[j] === '\\' && j + 1 < n) { if (source[j + 1] === '\n') { j += 2; line++; continue; } raw += source[j] + source[j + 1]; j += 2; continue; }
          if (source[j] === '\n') throw Object.assign(new AwkError('unterminated string', 1), { syntax: true, line: line, column: i });
          raw += source[j++];
        }
        if (j >= n) throw Object.assign(new AwkError('unterminated string', 1), { syntax: true, line: line, column: i });
        push('str', awkUnescape(raw), start); i = j + 1; continue;
      }
      if (c === '/' && regexAllowed()) {
        var k = i + 1, body = '', inBracket = false;
        while (k < n) {
          var ch = source[k];
          if (ch === '\\' && k + 1 < n) { body += source[k + 1] === '/' ? '/' : ch + source[k + 1]; k += 2; continue; }
          if (ch === '[' && !inBracket) { inBracket = true; body += ch; if (source[k + 1] === '^') { body += '^'; k++; } if (source[k + 1] === ']') { body += ']'; k++; } k++; continue; }
          if (ch === ']' && inBracket) { inBracket = false; body += ch; k++; continue; }
          if (ch === '/' && !inBracket) break;
          if (ch === '\n') break;
          body += ch; k++;
        }
        if (source[k] !== '/') throw Object.assign(new AwkError('unterminated regexp', 1), { syntax: true, line: line, column: i });
        push('ere', body, start); i = k + 1; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var word = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)[0];
        i += word.length;
        if (AWK_KEYWORDS[word]) push('kw', word === 'func' ? 'function' : word, start);
        else if (AWK_BUILTINS[word]) push('builtin', word, start);
        else if (source[i] === '(') push('funcname', word, start);
        else push('name', word, start);
        continue;
      }
      var op = null;
      for (var o = 0; o < ops.length; o++) if (source.substr(i, ops[o].length) === ops[o]) { op = ops[o]; break; }
      if (!op) throw Object.assign(new AwkError('invalid char \'' + c + '\' in expression', 1), { syntax: true, line: line, column: i });
      push('op', op, start); i += op.length;
    }
    tokens.push({ type: 'eof', value: '', line: line, start: n });
    return tokens;
  }

  function parseAwk(source) {
    var tokens = lexAwk(source), p = 0, functions = {}, items = [];
    function peek(k) { return tokens[p + (k || 0)]; }
    function is(value, k) { var t = peek(k); return (t.type === 'op' || t.type === 'kw') && t.value === value; }
    function fail(message, token) {
      token = token || peek();
      throw Object.assign(new AwkError(message || (token.type === 'eof' || token.type === 'newline' ? 'unexpected newline or end of string' : 'syntax error'), 1), { syntax: true, line: token.line, column: token.start });
    }
    function expect(value) { if (!is(value)) fail(); return tokens[p++]; }
    function skipNewlines() { while (peek().type === 'newline') p++; }
    function skipTerminators() { while (peek().type === 'newline' || is(';')) p++; }
    function isLvalue(node) { return node.type === 'var' || node.type === 'index' || node.type === 'field'; }

    function parseBlock() {
      expect('{');
      var body = [];
      while (true) {
        skipTerminators();
        if (is('}')) { p++; break; }
        if (peek().type === 'eof') fail();
        body.push(parseStatement());
      }
      return { type: 'block', body: body };
    }
    function simpleEnd() {
      // A simple statement ends at a newline, ';', '}' or end of input.
      var t = peek();
      if (t.type === 'newline' || t.type === 'eof' || is(';') || is('}')) return;
      fail();
    }
    function parseStatement() {
      var t = peek();
      if (is('{')) return parseBlock();
      if (is(';')) { p++; return { type: 'block', body: [] }; }
      if (t.type === 'kw') {
        switch (t.value) {
          case 'if': {
            p++; expect('('); var cond = parseExpr(); expect(')'); skipNewlines();
            var then = parseStatement(), save = p;
            skipTerminators();
            if (is('else')) { p++; skipNewlines(); return { type: 'if', cond: cond, then: then, otherwise: parseStatement() }; }
            p = save;
            return { type: 'if', cond: cond, then: then };
          }
          case 'while': {
            p++; expect('('); var wc = parseExpr(); expect(')');
            if (is(';')) { p++; return { type: 'while', cond: wc, body: { type: 'block', body: [] } }; }
            skipNewlines();
            return { type: 'while', cond: wc, body: parseStatement() };
          }
          case 'do': {
            p++; skipNewlines(); var body = parseStatement(); skipTerminators();
            if (!is('while')) fail();
            p++; expect('('); var dc = parseExpr(); expect(')'); simpleEnd();
            return { type: 'do', body: body, cond: dc };
          }
          case 'for': {
            p++; expect('(');
            if (peek().type === 'name' && is('in', 1) && peek(2).type === 'name' && is(')', 3)) {
              var keyName = tokens[p].value, arrayName = tokens[p + 2].value; p += 4; skipNewlines();
              return { type: 'forin', key: { type: 'var', name: keyName }, array: arrayName, body: parseStatement() };
            }
            var init = is(';') ? null : parseSimpleStatement();
            expect(';'); skipNewlines();
            var fc = is(';') ? null : parseExpr();
            expect(';'); skipNewlines();
            var step = is(')') ? null : parseSimpleStatement();
            expect(')');
            if (is(';')) { p++; return { type: 'for', init: init, cond: fc, step: step, body: { type: 'block', body: [] } }; }
            skipNewlines();
            return { type: 'for', init: init, cond: fc, step: step, body: parseStatement() };
          }
        }
      }
      var s = parseSimpleStatement();
      simpleEnd();
      return s;
    }
    function parseSimpleStatement() {
      var t = peek();
      if (t.type === 'kw') {
        switch (t.value) {
          case 'break': p++; return { type: 'break' };
          case 'continue': p++; return { type: 'continue' };
          case 'next': p++; return { type: 'next' };
          case 'nextfile': p++; return { type: 'nextfile' };
          case 'exit': p++; return { type: 'exit', value: atEnd() ? null : parseExpr() };
          case 'return': p++; return { type: 'return', value: atEnd() ? null : parseExpr() };
          case 'delete': {
            p++;
            if (peek().type !== 'name') fail();
            var name = tokens[p++].value;
            if (is('[')) { p++; var subs = parseExprList(); expect(']'); return { type: 'delete', name: name, subs: subs }; }
            return { type: 'delete', name: name, subs: null };
          }
          case 'print': case 'printf': return parsePrint();
        }
      }
      return { type: 'expr', expr: parseExpr() };
    }
    function atEnd() { var t = peek(); return t.type === 'newline' || t.type === 'eof' || is(';') || is('}'); }
    function parsePrint() {
      var kind = tokens[p++].value, args = [];
      if (!atEnd() && !is('>') && !is('>>') && !is('|')) {
        // `print (a, b) > "f"`: a parenthesised list is the argument list.
        if (is('(')) {
          var save = p;
          p++;
          var list = parseExprList(false);
          if (is(')')) {
            p++;
            if (atEnd() || is('>') || is('>>') || is('|')) args = list;
            else { p = save; args = parseExprList(true); }
          } else { p = save; args = parseExprList(true); }
        } else args = parseExprList(true);
      }
      var redirect = null;
      if (is('>') || is('>>') || is('|')) {
        var mode = tokens[p++].value;
        redirect = { mode: mode, target: parseConcat(true, true) };
      }
      if (kind === 'printf' && !args.length) fail();
      return { type: kind, args: args, redirect: redirect };
    }
    function parseExprList(noGt) {
      var list = [parseExpr(noGt)];
      while (is(',')) { p++; skipNewlines(); list.push(parseExpr(noGt)); }
      return list;
    }
    var ASSIGN_OPS = { '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '^=': 1, '**=': 1 };
    function parseExpr(noGt, noIn) { return parseTernary(noGt, noIn); }
    function parseTernary(noGt, noIn) {
      var cond = parseOr(noGt, noIn);
      if (is('?')) {
        p++; skipNewlines();
        var a = parseTernary(noGt, noIn); skipNewlines();
        expect(':'); skipNewlines();
        var b = parseTernary(noGt, noIn);
        return { type: 'cond', cond: cond, a: a, b: b };
      }
      if (peek().type === 'op' && ASSIGN_OPS[peek().value] && isLvalue(cond)) {
        // `/=` right after an lvalue is division-assignment, not a regex.
        var op = tokens[p++].value; skipNewlines();
        return { type: 'assign', op: op === '**=' ? '^=' : op, target: cond, value: parseTernary(noGt, noIn) };
      }
      return cond;
    }
    function parseOr(noGt, noIn) {
      var left = parseAnd(noGt, noIn);
      while (is('||')) { p++; skipNewlines(); left = { type: 'or', left: left, right: parseAnd(noGt, noIn) }; }
      return left;
    }
    function parseAnd(noGt, noIn) {
      var left = parseIn(noGt, noIn);
      while (is('&&')) { p++; skipNewlines(); left = { type: 'and', left: left, right: parseIn(noGt, noIn) }; }
      return left;
    }
    function parseIn(noGt, noIn) {
      var left = parseMatch(noGt, noIn);
      while (!noIn && is('in')) {
        p++;
        if (peek().type !== 'name') fail();
        left = { type: 'in', keys: left.type === 'group' ? left.items : [left], array: tokens[p++].value };
      }
      return left;
    }
    function parseMatch(noGt, noIn) {
      var left = parseCompare(noGt, noIn);
      while (is('~') || is('!~')) { var op = tokens[p++].value; left = { type: 'match', negate: op === '!~', left: left, right: parseCompare(noGt, noIn) }; }
      return left;
    }
    function parseCompare(noGt, noIn) {
      var left = parseConcat(noGt, noIn);
      while (is('|') && is('getline', 1)) {
        p += 2;
        var target = optionalLvalue();
        left = { type: 'getline', kind: 'cmd', source: left, target: target };
      }
      var t = peek();
      if (t.type === 'op' && (t.value === '<' || t.value === '<=' || t.value === '==' || t.value === '!=' || t.value === '>=' || (t.value === '>' && !noGt))) {
        p++;
        return { type: 'compare', op: t.value, left: left, right: parseConcat(noGt, noIn) };
      }
      return left;
    }
    function startsOperand(t) {
      if (t.type === 'num' || t.type === 'str' || t.type === 'ere' || t.type === 'name' || t.type === 'funcname' || t.type === 'builtin') return true;
      if (t.type === 'op') return t.value === '$' || t.value === '(' || t.value === '!' || t.value === '++' || t.value === '--' || t.value === '-' || t.value === '+';
      return t.type === 'kw' && t.value === 'getline';
    }
    function parseConcat(noGt, noIn) {
      var left = parseAdditive(noGt, noIn);
      while (true) {
        var t = peek();
        if (!startsOperand(t) || (t.type === 'op' && (t.value === '-' || t.value === '+' || t.value === '!')) || (t.type === 'kw' && t.value === 'in')) break;
        left = { type: 'concat', left: left, right: parseAdditive(noGt, noIn) };
      }
      return left;
    }
    function parseAdditive(noGt, noIn) {
      var left = parseMultiplicative(noGt, noIn);
      while (is('+') || is('-')) { var op = tokens[p++].value; left = { type: 'binary', op: op, left: left, right: parseMultiplicative(noGt, noIn) }; }
      return left;
    }
    function parseMultiplicative(noGt, noIn) {
      var left = parseUnary(noGt, noIn);
      while (is('*') || is('/') || is('%')) { var op = tokens[p++].value; left = { type: 'binary', op: op, left: left, right: parseUnary(noGt, noIn) }; }
      return left;
    }
    function parseUnary(noGt, noIn) {
      if (is('!')) { p++; return { type: 'not', expr: parseUnary(noGt, noIn) }; }
      if (is('-')) { p++; return { type: 'neg', expr: parseUnary(noGt, noIn) }; }
      if (is('+')) { p++; return { type: 'plus', expr: parseUnary(noGt, noIn) }; }
      return parsePower(noGt, noIn);
    }
    function parsePower(noGt, noIn) {
      var base = parsePostfix(noGt, noIn);
      if (is('^') || is('**')) {
        p++;
        var exponent = is('-') ? (p++, { type: 'neg', expr: parsePower(noGt, noIn) }) : is('+') ? (p++, parsePower(noGt, noIn)) : is('!') ? (p++, { type: 'not', expr: parsePower(noGt, noIn) }) : parsePower(noGt, noIn);
        return { type: 'binary', op: '^', left: base, right: exponent };
      }
      return base;
    }
    function parsePostfix(noGt, noIn) {
      var e = parsePrimary(noGt, noIn);
      if (isLvalue(e) && (is('++') || is('--'))) return { type: 'postinc', op: tokens[p++].value, target: e };
      return e;
    }
    function optionalLvalue() {
      var t = peek();
      if (t.type === 'name' || is('$')) return parsePrimary(true, true);
      return null;
    }
    function parsePrimary(noGt, noIn) {
      var t = tokens[p];
      switch (t.type) {
        case 'num': p++; return { type: 'num', value: t.value };
        case 'str': p++; return { type: 'str', value: t.value };
        case 'ere': p++; return { type: 'regex', source: t.value };
        case 'name':
          p++;
          if (is('[')) { p++; var subs = parseExprList(); expect(']'); return { type: 'index', name: t.value, subs: subs }; }
          return { type: 'var', name: t.value };
        case 'funcname': {
          p++; expect('(');
          var args = is(')') ? [] : parseExprList();
          expect(')');
          return { type: 'call', name: t.value, args: args, token: t };
        }
        case 'builtin': {
          p++;
          if (is('(')) {
            p++;
            var bargs = is(')') ? [] : parseExprList();
            expect(')');
            return { type: 'builtin', name: t.value, args: bargs };
          }
          if (t.value === 'length') return { type: 'builtin', name: 'length', args: [] };
          fail(null, t);
        }
      }
      if (t.type === 'kw' && t.value === 'getline') {
        p++;
        var target = optionalLvalue();
        if (is('<')) { p++; return { type: 'getline', kind: 'file', source: parsePrimaryOperand(), target: target }; }
        return { type: 'getline', kind: 'main', target: target };
      }
      if (t.type === 'op') {
        if (t.value === '$') { p++; return { type: 'field', index: parsePrimaryOperand() }; }
        if (t.value === '(') {
          p++;
          var items = parseExprList();
          expect(')');
          return items.length > 1 ? { type: 'group', items: items } : { type: 'paren', expr: items[0] };
        }
        if (t.value === '++' || t.value === '--') {
          p++;
          var operand = parsePrimary(noGt, noIn);
          if (!isLvalue(operand)) fail();
          return { type: 'preinc', op: t.value, target: operand };
        }
        if (t.value === '-' || t.value === '+' || t.value === '!') return parseUnary(noGt, noIn);
      }
      fail(null, t);
    }
    // Operand of `$` and of `getline <`: a primary, with prefix ++/-- and unary minus.
    function parsePrimaryOperand() {
      if (is('++') || is('--')) { var op = tokens[p++].value; return { type: 'preinc', op: op, target: parsePrimary(true, true) }; }
      if (is('-')) { p++; return { type: 'neg', expr: parsePrimaryOperand() }; }
      return parsePrimary(true, true);
    }

    while (true) {
      skipTerminators();
      var t = peek();
      if (t.type === 'eof') break;
      if (t.type === 'kw' && t.value === 'function') {
        p++;
        var nameToken = tokens[p++];
        if (nameToken.type !== 'name' && nameToken.type !== 'funcname') fail(null, nameToken);
        expect('(');
        var params = [];
        while (!is(')')) {
          if (peek().type !== 'name') fail();
          params.push(tokens[p++].value);
          if (is(',')) { p++; skipNewlines(); }
        }
        p++; skipNewlines();
        functions[nameToken.value] = { params: params, body: parseBlock() };
        continue;
      }
      if (t.type === 'kw' && (t.value === 'BEGIN' || t.value === 'END')) {
        p++; skipNewlines();
        if (!is('{')) fail();
        items.push({ kind: t.value, action: parseBlock() });
        continue;
      }
      var pattern = is('{') ? null : parseExpr(), pattern2 = null;
      if (pattern && is(',')) { p++; skipNewlines(); pattern2 = parseExpr(); }
      var action = is('{') ? parseBlock() : null;
      items.push({ kind: 'main', pattern: pattern, pattern2: pattern2, action: action });
    }
    return { items: items, functions: functions };
  }

  // Strings read from input that look like numbers ("strnum") compare numerically.
  function StrNum(text, number) { this.s = text; this.n = number; }
  StrNum.prototype.toString = function () { return this.s; };
  var AWK_NUMERIC = /^[ \t\n\r\f\v]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\f\v]*$/;
  function awkInput(text) { return AWK_NUMERIC.test(text) ? new StrNum(text, Number(text.trim())) : text; }
  function awkNumber(v) {
    if (typeof v === 'number') return v;
    if (v === undefined) return 0;
    if (v instanceof StrNum) return v.n;
    var m = String(v).match(/^[ \t\n\r\f\v]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
    if (m) return Number(m[1]);
    var special = String(v).match(/^[ \t\n]*([+-])(inf|nan)/i);
    if (special) return special[2].toLowerCase() === 'inf' ? (special[1] === '-' ? -Infinity : Infinity) : NaN;
    return 0;
  }
  function awkFormatNumber(n, format) {
    if (Number.isInteger(n)) return Object.is(n, -0) ? '-0' : BigInt(n).toString();
    if (isNaN(n)) return 'nan';
    if (!isFinite(n)) return n < 0 ? '-inf' : 'inf';
    return formatPrintf(format, [n], AWK_PRINTF_HOOKS).text;
  }
  var AWK_PRINTF_HOOKS = {
    noEscapes: true, noRepeat: true, conversions: 'cdiouxXeEfFgGaAs',
    integer: function (v) { var n = awkNumber(v); return isFinite(n) ? BigInt(Math.trunc(n)) : 0n; },
    float: function (v) { return awkNumber(v); },
    string: function (v) { return awkString(v, '%.6g'); },
    char: function (v) {
      if (typeof v === 'number') return String.fromCodePoint(Math.max(0, Math.trunc(v)) & 0x1fffff || 0);
      return Array.from(awkString(v, '%.6g'))[0] || '';
    }
  };
  function awkString(v, format) {
    if (v === undefined) return '';
    if (typeof v === 'number') return awkFormatNumber(v, format);
    return String(v);
  }
  function awkBool(v) {
    if (typeof v === 'number') return v !== 0;
    if (v === undefined) return false;
    if (v instanceof StrNum) return v.n !== 0;
    return v !== '';
  }
  function awkIsNumeric(v) { return typeof v === 'number' || v === undefined || v instanceof StrNum; }

  // An input reader that splits text into records per RS.
  function AwkReader(text) { this.text = text; this.pos = 0; }
  AwkReader.prototype.next = function (rs, regexFor) {
    var text = this.text;
    if (rs === '') {
      // Paragraph mode: blank lines separate records; leading newlines skipped.
      while (this.pos < text.length && text[this.pos] === '\n') this.pos++;
      if (this.pos >= text.length) return null;
      var m = /\n\n+/g; m.lastIndex = this.pos;
      var hit = m.exec(text), end = hit ? hit.index : text.length;
      var record = text.slice(this.pos, end).replace(/\n+$/, '');
      this.pos = hit ? hit.index + hit[0].length : text.length;
      return { record: record, rt: hit ? hit[0] : '' };
    }
    if (this.pos >= text.length) return null;
    if (rs.length === 1) {
      var at = text.indexOf(rs, this.pos);
      var rec = at < 0 ? text.slice(this.pos) : text.slice(this.pos, at);
      this.pos = at < 0 ? text.length : at + 1;
      return { record: rec, rt: at < 0 ? '' : rs };
    }
    var re = regexFor(rs, 'g');
    re.lastIndex = this.pos;
    var found = re.exec(text);
    while (found && found[0] === '') { re.lastIndex++; found = re.lastIndex <= text.length ? re.exec(text) : null; }
    var r2 = found ? text.slice(this.pos, found.index) : text.slice(this.pos);
    this.pos = found ? found.index + found[0].length : text.length;
    return { record: r2, rt: found ? found[0] : '' };
  };

  var AWK_BREAK = { signal: 'break' }, AWK_CONTINUE = { signal: 'continue' }, AWK_NEXT = { signal: 'next' }, AWK_NEXTFILE = { signal: 'nextfile' };
  function AwkExit(code) { this.code = code; }
  function AwkReturn(value) { this.value = value; }

  async function runAwk(ctx, program, setup) {
    var globals = new Map(), frame = null, fields = null, record = '', recordFs = ' ', nf = 0;
    var regexCache = new Map(), readers = new Map(), outputs = new Map(), rangeActive = new Map();
    var mainReader = null, argIndex = 1, usedFileOperand = false, exiting = null, seed = 0, previousSeed = 0, randState = 0;
    function slot(name) {
      if (frame && frame.has(name)) return frame.get(name);
      var s = globals.get(name);
      if (!s) { s = { kind: 'unset', value: undefined }; globals.set(name, s); }
      return s;
    }
    function scalarValue(name) {
      if (name === 'NF') { splitIfNeeded(); return nf; }
      var s = slot(name);
      if (s.kind === 'array') throw new AwkError('attempt to use array `' + name + '\' in a scalar context');
      return s.value;
    }
    function setScalar(name, value) {
      if (name === 'NF') { setNF(awkNumber(value)); return value; }
      var s = slot(name);
      if (s.kind === 'array') throw new AwkError('attempt to use array `' + name + '\' in a scalar context');
      s.kind = 'scalar'; s.value = value;
      return value;
    }
    function arrayOf(name) {
      var s = slot(name);
      if (s.kind === 'array') return s.value;
      if (s.kind === 'scalar') throw new AwkError('attempt to use scalar `' + name + '\' as an array');
      s.kind = 'array'; s.value = new Map();
      if (s.link && s.link.kind === 'unset') { s.link.kind = 'array'; s.link.value = s.value; }
      return s.value;
    }
    function special(name) { var s = globals.get(name); return s ? s.value : undefined; }
    function convfmt() { return awkString(special('CONVFMT'), '%.6g') || '%.6g'; }
    function str(v) { return awkString(v, convfmt()); }
    function outStr(v) { return typeof v === 'number' ? awkFormatNumber(v, awkString(special('OFMT'), '%.6g') || '%.6g') : awkString(v, '%.6g'); }
    function subscript(values) { return values.map(function (v) { return typeof v === 'number' && Number.isInteger(v) ? BigInt(v).toString() : str(v); }).join(str(special('SUBSEP'))); }
    function regexFor(source, flags) {
      var key = source + '\u0000' + (flags || '');
      var re = regexCache.get(key);
      if (!re) {
        try { re = new RegExp(translateRegex(source, 'ERE', { controlEscapes: true, bracketEscapes: true }), flags || ''); }
        catch (e) { throw new AwkError('invalid regexp: ' + e.message.replace(/^Invalid regular expression: /, '')); }
        regexCache.set(key, re);
      }
      re.lastIndex = 0;
      return re;
    }
    async function regexOf(node, flags) {
      if (node.type === 'regex') return regexFor(node.source, flags);
      return regexFor(str(await ev(node)), flags);
    }

    // ---- records and fields ----
    function splitWith(text, fs, paragraph) {
      if (fs === ' ') return text.split(/[ \t\n]+/).filter(function (f) { return f !== ''; });
      if (text === '') return [];
      if (fs === '') return Array.from(text);
      var pieces;
      if (fs.length === 1 && fs !== '\\') pieces = text.split(fs === '\t' ? '\t' : fs);
      else {
        var re = regexFor(fs, 'g'), last = 0, m;
        pieces = [];
        while ((m = re.exec(text))) {
          if (m[0] === '') { re.lastIndex++; continue; }
          pieces.push(text.slice(last, m.index)); last = m.index + m[0].length;
        }
        pieces.push(text.slice(last));
      }
      if (paragraph) pieces = [].concat.apply([], pieces.map(function (piece) { return piece.split('\n'); }));
      return pieces;
    }
    function splitIfNeeded() {
      if (fields) return;
      fields = splitWith(record, recordFs, special('RS') === '').map(awkInput);
      nf = fields.length;
    }
    function setRecord(text) { record = text; fields = null; recordFs = str(special('FS')); }
    function rebuild() { record = fields.slice(0, nf).map(str).join(str(special('OFS'))); }
    function setNF(n) {
      splitIfNeeded();
      n = Math.max(0, Math.trunc(n));
      while (fields.length < n) fields.push(undefined);
      fields.length = n; nf = n;
      rebuild();
    }
    function getField(i) {
      if (i < 0) throw new AwkError('attempt to access field ' + i);
      if (i === 0) return awkInput(record);
      splitIfNeeded();
      return i <= nf ? fields[i - 1] : undefined;
    }
    function setField(i, value) {
      if (i < 0) throw new AwkError('attempt to access field ' + i);
      if (i === 0) { setRecord(str(value)); return value; }
      splitIfNeeded();
      while (fields.length < i) fields.push(undefined);
      fields[i - 1] = value;
      if (i > nf) nf = i;
      rebuild();
      return value;
    }

    // ---- input ----
    function applyAssignment(text) {
      var at = text.indexOf('=');
      setScalar(text.slice(0, at), awkInput(awkUnescape(text.slice(at + 1))));
    }
    async function openNextMain() {
      var argv = arrayOf('ARGV');
      while (argIndex < awkNumber(scalarValue('ARGC'))) {
        var arg = argv.get(String(argIndex++));
        arg = arg === undefined ? '' : str(arg);
        if (arg === '') continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { applyAssignment(arg); continue; }
        usedFileOperand = true;
        try {
          var text = await ctx.readFile(arg);
          setScalar('FILENAME', arg); setScalar('FNR', 0);
          return new AwkReader(text);
        } catch (e) {
          if (e.code !== 'EISDIR') throw new AwkError('cannot open file `' + arg + '\' for reading: ' + errorReason(e));
          ctx.stderr.write('awk: cmd. line:1: warning: command line argument `' + arg + '\' is a directory: skipped\n');
        }
      }
      if (!usedFileOperand) { usedFileOperand = true; setScalar('FNR', 0); return new AwkReader(ctx.stdin.readAll()); }
      return null;
    }
    async function nextMainRecord() {
      while (true) {
        if (!mainReader) { mainReader = await openNextMain(); if (!mainReader) return null; }
        var got = mainReader.next(str(special('RS')), regexFor);
        if (got) { setScalar('RT', got.rt); return got.record; }
        mainReader = null;
      }
    }
    async function readerFor(kind, name) {
      var key = kind + ':' + name;
      if (!readers.has(key)) {
        var text = null;
        if (kind === 'file') {
          if (name === '-' || name === '/dev/stdin') text = ctx.stdin.readAll();
          else { try { text = await ctx.readFile(name); } catch (_) { text = null; } }
        } else {
          await flushOutputs(false);
          var result = await ctx.exec(name, { capture: true });
          text = result.stdout;
        }
        readers.set(key, text === null ? null : new AwkReader(text));
      }
      return readers.get(key);
    }

    // ---- output ----
    async function output(text, redirect) {
      if (!redirect) { ctx.stdout.write(text); return; }
      var name = str(await ev(redirect.target));
      if (redirect.mode !== '|' && (name === '/dev/stdout' || name === '-')) { ctx.stdout.write(text); return; }
      if (redirect.mode !== '|' && name === '/dev/stderr') { ctx.stderr.write(text); return; }
      var key = (redirect.mode === '|' ? 'pipe:' : 'file:') + name, o = outputs.get(key);
      if (!o) { o = { mode: redirect.mode, name: name, data: '', written: false }; outputs.set(key, o); }
      o.data += text;
    }
    async function closeOutput(o) {
      if (o.mode === '|') { var code = await ctx.exec(o.name, { stdin: o.data }); o.data = ''; return code; }
      var path = ctx.resolve(o.name);
      if (!o.written) { await ctx.vfs.writeFile(path, o.data, { append: o.mode === '>>' }); o.written = true; }
      else if (o.data) await ctx.vfs.writeFile(path, o.data, { append: true });
      o.data = '';
      return 0;
    }
    async function flushOutputs(includePipes) {
      var list = Array.from(outputs.values());
      for (var i = 0; i < list.length; i++) if (list[i].mode !== '|' || includePipes) await closeOutput(list[i]);
    }

    // ---- evaluation ----
    async function assignTo(target, value) {
      switch (target.type) {
        case 'var': return setScalar(target.name, value);
        case 'index': arrayOf(target.name).set(subscript(await evalAll(target.subs)), value); return value;
        case 'field': return setField(Math.trunc(awkNumber(await ev(target.index))), value);
      }
      throw new AwkError('invalid assignment target');
    }
    async function evalAll(nodes) { var out = []; for (var i = 0; i < nodes.length; i++) out.push(await ev(nodes[i])); return out; }
    function arith(op, a, b) {
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': if (b === 0) throw new AwkError('division by zero attempted'); return a / b;
        case '%': if (b === 0) throw new AwkError('division by zero attempted in `%\''); return a % b;
        case '^': return Math.pow(a, b);
      }
    }
    function compareValues(a, b) {
      if (awkIsNumeric(a) && awkIsNumeric(b)) { var x = awkNumber(a), y = awkNumber(b); return x < y ? -1 : x > y ? 1 : x === y ? 0 : NaN; }
      var s = str(a), t = str(b);
      return s < t ? -1 : s > t ? 1 : 0;
    }
    async function ev(node) {
      switch (node.type) {
        case 'num': return node.value;
        case 'str': return node.value;
        case 'regex': return regexFor(node.source).test(record) ? 1 : 0;
        case 'paren': return ev(node.expr);
        case 'group': throw new AwkError('syntax error: unexpected list');
        case 'var': return scalarValue(node.name);
        case 'index': {
          var key = subscript(await evalAll(node.subs)), arr = arrayOf(node.name);
          if (!arr.has(key)) arr.set(key, undefined);
          return arr.get(key);
        }
        case 'field': return getField(Math.trunc(awkNumber(await ev(node.index))));
        case 'assign': {
          if (node.op === '=') return assignTo(node.target, copyValue(await ev(node.value)));
          var right = awkNumber(await ev(node.value)), left = awkNumber(await ev(node.target));
          return assignTo(node.target, arith(node.op.slice(0, -1), left, right));
        }
        case 'cond': return awkBool(await ev(node.cond)) ? ev(node.a) : ev(node.b);
        case 'or': return awkBool(await ev(node.left)) || awkBool(await ev(node.right)) ? 1 : 0;
        case 'and': return awkBool(await ev(node.left)) && awkBool(await ev(node.right)) ? 1 : 0;
        case 'in': return arrayOf(node.array).has(subscript(await evalAll(node.keys))) ? 1 : 0;
        case 'match': {
          var subject = str(await ev(node.left)), re = await regexOf(node.right);
          return re.test(subject) !== node.negate ? 1 : 0;
        }
        case 'compare': {
          var c = compareValues(await ev(node.left), await ev(node.right));
          switch (node.op) {
            case '<': return c < 0 ? 1 : 0;
            case '<=': return c <= 0 ? 1 : 0;
            case '>': return c > 0 ? 1 : 0;
            case '>=': return c >= 0 ? 1 : 0;
            case '==': return c === 0 ? 1 : 0;
            case '!=': return c !== 0 ? 1 : 0;
          }
          return 0;
        }
        case 'concat': return str(await ev(node.left)) + str(await ev(node.right));
        case 'binary': return arith(node.op, awkNumber(await ev(node.left)), awkNumber(await ev(node.right)));
        case 'not': return awkBool(await ev(node.expr)) ? 0 : 1;
        case 'neg': return -awkNumber(await ev(node.expr));
        case 'plus': return awkNumber(await ev(node.expr));
        case 'preinc': {
          var v = awkNumber(await ev(node.target)) + (node.op === '++' ? 1 : -1);
          return assignTo(node.target, v);
        }
        case 'postinc': {
          var old = awkNumber(await ev(node.target));
          await assignTo(node.target, old + (node.op === '++' ? 1 : -1));
          return old;
        }
        case 'getline': return getline(node);
        case 'call': return callFunction(node);
        case 'builtin': return builtin(node);
      }
      throw new AwkError('unknown expression ' + node.type);
    }
    function copyValue(v) { return v; }
    async function getline(node) {
      var got;
      if (node.kind === 'main') {
        got = await nextMainRecord();
        if (got === null) return 0;
        setScalar('NR', awkNumber(special('NR')) + 1);
        setScalar('FNR', awkNumber(special('FNR')) + 1);
      } else {
        var name = str(await ev(node.source)), reader = await readerFor(node.kind === 'file' ? 'file' : 'cmd', name);
        if (!reader) return -1;
        var rec = reader.next(str(special('RS')), regexFor);
        if (!rec) return 0;
        got = rec.record;
        setScalar('RT', rec.rt);
        if (node.kind === 'cmd') setScalar('NR', awkNumber(special('NR')) + 1);
      }
      if (node.target) await assignTo(node.target, awkInput(got));
      else setRecord(got);
      return 1;
    }
    async function callFunction(node) {
      var fn = program.functions[node.name];
      if (!fn) throw new AwkError('function `' + node.name + '\' not defined');
      if (node.args.length > fn.params.length) throw new AwkError('function `' + node.name + '\' called with more arguments than declared');
      var newFrame = new Map();
      for (var i = 0; i < fn.params.length; i++) {
        var arg = node.args[i];
        if (!arg) { newFrame.set(fn.params[i], { kind: 'unset', value: undefined }); continue; }
        if (arg.type === 'var') {
          var s = slot(arg.name);
          if (s.kind === 'array') { newFrame.set(fn.params[i], s); continue; }
          if (s.kind === 'unset') { newFrame.set(fn.params[i], { kind: 'unset', value: undefined, link: s }); continue; }
        }
        newFrame.set(fn.params[i], { kind: 'scalar', value: await ev(arg) });
      }
      if (setup.depth++ > 1000) throw new AwkError('function call nesting too deep');
      var saved = frame;
      frame = newFrame;
      try { await exec(fn.body); return undefined; }
      catch (e) { if (e instanceof AwkReturn) return e.value; throw e; }
      finally { frame = saved; setup.depth--; }
    }
    function nextRandom() { randState = (randState * 1103515245 + 12345) % 2147483648; return randState / 2147483648; }
    function substitute(re, replacement, target, global, gensubMode) {
      var g = new RegExp(re.source, re.flags.replace('g', '') + 'g'), out = '', last = 0, count = 0, prevEnd = -1, m;
      var which = global === true ? 0 : global;
      var occurrence = 0;
      while ((m = g.exec(target))) {
        if (m[0] === '' && m.index === prevEnd) { g.lastIndex++; if (g.lastIndex > target.length) break; continue; }
        occurrence++;
        if (which === 0 || occurrence === which) {
          var text = '';
          for (var i = 0; i < replacement.length; i++) {
            var ch = replacement[i];
            if (ch === '\\' && i + 1 < replacement.length) {
              var next = replacement[i + 1];
              if (next === '&') { text += '&'; i++; continue; }
              if (next === '\\') { text += '\\'; i++; continue; }
              if (gensubMode && /\d/.test(next)) { text += m[Number(next)] == null ? '' : m[Number(next)]; i++; continue; }
              text += ch; continue;
            }
            text += ch === '&' ? m[0] : ch;
          }
          out += target.slice(last, m.index) + text;
          last = m.index + m[0].length;
          count++;
          if (which !== 0) break;
        }
        prevEnd = m.index + m[0].length;
        if (m[0] === '') { g.lastIndex++; if (g.lastIndex > target.length) break; }
      }
      return { text: out + target.slice(last), count: count };
    }
    function awkSort(values, byIndex) {
      return values.sort(function (a, b) {
        var na = awkIsNumeric(a) && !(typeof a === 'string'), nb = awkIsNumeric(b) && !(typeof b === 'string');
        if (byIndex) { var sa = String(a), sb = String(b); var da = AWK_NUMERIC.test(sa), db = AWK_NUMERIC.test(sb); if (da && db) return Number(sa) - Number(sb); if (da !== db) return da ? -1 : 1; return sa < sb ? -1 : sa > sb ? 1 : 0; }
        if (na && nb) return awkNumber(a) - awkNumber(b);
        if (na !== nb) return na ? -1 : 1;
        var x = str(a), y = str(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
    async function builtin(node) {
      var a = node.args, name = node.name;
      switch (name) {
        case 'length': {
          if (!a.length) return Array.from(record).length;
          if (a[0].type === 'var') { var s = slot(a[0].name); if (s.kind === 'array') return s.value.size; }
          return Array.from(str(await ev(a[0]))).length;
        }
        case 'substr': {
          var chars = Array.from(str(await ev(a[0]))), start = awkNumber(await ev(a[1]));
          var len = a.length > 2 ? awkNumber(await ev(a[2])) : Infinity;
          // gawk 5: the start is truncated and clamped to 1 without shortening
          // the length (substr("hello", 0, 2) is "he").
          if (isNaN(start) || isNaN(len)) return '';
          var first = Math.max(1, Math.trunc(start)), count = len === Infinity ? Infinity : Math.trunc(len);
          if (count <= 0) return '';
          return chars.slice(first - 1, count === Infinity ? undefined : first - 1 + count).join('');
        }
        case 'index': {
          var hay = str(await ev(a[0])), needle = str(await ev(a[1]));
          var at = hay.indexOf(needle);
          return at < 0 ? 0 : Array.from(hay.slice(0, at)).length + 1;
        }
        case 'split': {
          var text = str(await ev(a[0])), target = arrayOf(a[1].name), fs;
          if (a.length > 2) fs = a[2].type === 'regex' ? null : str(await ev(a[2]));
          else fs = str(special('FS'));
          var parts;
          if (a.length > 2 && a[2].type === 'regex') {
            var sre = regexFor(a[2].source, 'g'), lastPos = 0, mm; parts = [];
            if (text !== '') {
              while ((mm = sre.exec(text))) { if (mm[0] === '') { sre.lastIndex++; continue; } parts.push(text.slice(lastPos, mm.index)); lastPos = mm.index + mm[0].length; }
              parts.push(text.slice(lastPos));
            }
          } else parts = splitWith(text, fs, false);
          target.clear();
          parts.forEach(function (piece, k) { target.set(String(k + 1), awkInput(piece)); });
          return parts.length;
        }
        case 'sub': case 'gsub': {
          var re = await regexOf(a[0]), replacement = str(await ev(a[1]));
          var targetNode = a[2] || { type: 'field', index: { type: 'num', value: 0 } };
          var result = substitute(re, replacement, str(await ev(targetNode)), name === 'gsub' ? true : 1, false);
          if (result.count) await assignTo(targetNode, result.text);
          return result.count;
        }
        case 'gensub': {
          var gre = await regexOf(a[0]), grepl = str(await ev(a[1])), how = await ev(a[2]);
          var subject = a.length > 3 ? str(await ev(a[3])) : record;
          var howStr = str(how), which = /^[gG]/.test(howStr) ? true : Math.max(1, Math.trunc(awkNumber(how)) || 1);
          return substitute(gre, grepl.replace(/\\0/g, '&'), subject, which, true).text;
        }
        case 'match': {
          var mtext = str(await ev(a[0])), mre = await regexOf(a[1]), found = mre.exec(mtext);
          var rstart = found ? Array.from(mtext.slice(0, found.index)).length + 1 : 0, rlength = found ? Array.from(found[0]).length : -1;
          setScalar('RSTART', rstart); setScalar('RLENGTH', rlength);
          if (a.length > 2) {
            var marr = arrayOf(a[2].name); marr.clear();
            if (found) found.forEach(function (g, k) {
              if (g === undefined) return;
              marr.set(String(k), g);
              var pos = mtext.indexOf(g, found.index);
              marr.set(k + str(special('SUBSEP')) + 'start', Array.from(mtext.slice(0, pos)).length + 1);
              marr.set(k + str(special('SUBSEP')) + 'length', Array.from(g).length);
            });
          }
          return rstart;
        }
        case 'sprintf': {
          if (!a.length) throw new AwkError('sprintf: no arguments');
          var values = await evalAll(a);
          return formatPrintf(str(values[0]), values.slice(1), AWK_PRINTF_HOOKS).text;
        }
        case 'sin': return Math.sin(awkNumber(await ev(a[0])));
        case 'cos': return Math.cos(awkNumber(await ev(a[0])));
        case 'atan2': return Math.atan2(awkNumber(await ev(a[0])), awkNumber(await ev(a[1])));
        case 'exp': return Math.exp(awkNumber(await ev(a[0])));
        case 'log': return Math.log(awkNumber(await ev(a[0])));
        case 'sqrt': return Math.sqrt(awkNumber(await ev(a[0])));
        case 'int': return Math.trunc(awkNumber(await ev(a[0])));
        case 'rand': return nextRandom();
        case 'srand': {
          previousSeed = seed;
          seed = a.length ? awkNumber(await ev(a[0])) : Math.floor(ctx.now().getTime() / 1000);
          randState = Math.abs(Math.trunc(seed)) % 2147483648;
          return previousSeed;
        }
        case 'tolower': return str(await ev(a[0])).toLowerCase();
        case 'toupper': return str(await ev(a[0])).toUpperCase();
        case 'system': {
          await flushOutputs(false);
          return ctx.exec(str(await ev(a[0])));
        }
        case 'close': {
          var cname = str(await ev(a[0])), closed = -1;
          for (var key of Array.from(outputs.keys())) {
            if (outputs.get(key).name === cname) { closed = await closeOutput(outputs.get(key)); outputs.delete(key); }
          }
          ['file:', 'cmd:'].forEach(function (prefix) { if (readers.has(prefix + cname)) { readers.delete(prefix + cname); if (closed < 0) closed = 0; } });
          return closed;
        }
        case 'fflush': return 0;
        case 'systime': return Math.floor(ctx.now().getTime() / 1000);
        case 'strftime': {
          var sfmt = a.length ? str(await ev(a[0])) : '%a %b %e %H:%M:%S %Z %Y';
          var when = a.length > 1 ? awkNumber(await ev(a[1])) : Math.floor(ctx.now().getTime() / 1000);
          var utc = a.length > 2 && awkBool(await ev(a[2]));
          return strftime(new Date(when * 1000), sfmt, utc ? 'UTC' : normalizeZone(ctx.timezone));
        }
        case 'mktime': {
          var spec = str(await ev(a[0])).trim().split(/\s+/).map(Number);
          if (spec.length < 6 || spec.some(isNaN)) return -1;
          return Math.floor(zonedDate(spec[0], spec[1], spec[2], spec[3], spec[4], spec[5], 0, normalizeZone(ctx.timezone)).getTime() / 1000);
        }
        case 'asort': case 'asorti': {
          var source = arrayOf(a[0].name), dest = a.length > 1 ? arrayOf(a[1].name) : source;
          var items = name === 'asort' ? Array.from(source.values()) : Array.from(source.keys());
          items = awkSort(items, name === 'asorti');
          dest.clear();
          items.forEach(function (v, k) { dest.set(String(k + 1), v); });
          return items.length;
        }
        case 'and': case 'or': case 'xor': {
          var nums = (await evalAll(a)).map(function (v) { return BigInt(Math.trunc(awkNumber(v))); });
          var acc = nums[0];
          for (var q = 1; q < nums.length; q++) acc = name === 'and' ? acc & nums[q] : name === 'or' ? acc | nums[q] : acc ^ nums[q];
          return Number(acc);
        }
        case 'lshift': return Number(BigInt(Math.trunc(awkNumber(await ev(a[0])))) << BigInt(Math.trunc(awkNumber(await ev(a[1])))));
        case 'rshift': return Number(BigInt(Math.trunc(awkNumber(await ev(a[0])))) >> BigInt(Math.trunc(awkNumber(await ev(a[1])))));
        case 'compl': return Number(~BigInt(Math.trunc(awkNumber(await ev(a[0])))) & ((1n << 53n) - 1n));
        case 'strtonum': {
          var sv = await ev(a[0]);
          if (typeof sv === 'number') return sv;
          var st = str(sv).trim();
          if (/^[+-]?0[xX][0-9a-fA-F]+/.test(st)) return parseInt(st, 16);
          if (/^[+-]?0[0-7]+$/.test(st)) return parseInt(st, 8);
          return awkNumber(st);
        }
      }
      throw new AwkError('function `' + name + '\' not supported');
    }

    // ---- statements ----
    async function exec(node) {
      switch (node.type) {
        case 'block': for (var i = 0; i < node.body.length; i++) await exec(node.body[i]); return;
        case 'expr': await ev(node.expr); return;
        case 'print': {
          var text;
          if (!node.args.length) text = record;
          else text = (await evalAll(node.args)).map(outStr).join(str(special('OFS')));
          await output(text + str(special('ORS')), node.redirect);
          return;
        }
        case 'printf': {
          var values = await evalAll(node.args);
          await output(formatPrintf(str(values[0]), values.slice(1), AWK_PRINTF_HOOKS).text, node.redirect);
          return;
        }
        case 'if':
          if (awkBool(await ev(node.cond))) await exec(node.then);
          else if (node.otherwise) await exec(node.otherwise);
          return;
        case 'while':
          while (awkBool(await ev(node.cond))) {
            try { await exec(node.body); }
            catch (e) { if (e === AWK_BREAK) break; if (e !== AWK_CONTINUE) throw e; }
          }
          return;
        case 'do':
          do {
            try { await exec(node.body); }
            catch (e) { if (e === AWK_BREAK) break; if (e !== AWK_CONTINUE) throw e; }
          } while (awkBool(await ev(node.cond)));
          return;
        case 'for':
          if (node.init) await exec(node.init);
          while (!node.cond || awkBool(await ev(node.cond))) {
            try { await exec(node.body); }
            catch (e) { if (e === AWK_BREAK) break; if (e !== AWK_CONTINUE) throw e; }
            if (node.step) await exec(node.step);
          }
          return;
        case 'forin': {
          var keys = Array.from(arrayOf(node.array).keys());
          for (var k = 0; k < keys.length; k++) {
            if (!arrayOf(node.array).has(keys[k])) continue;
            await assignTo(node.key, awkInput(keys[k]));
            try { await exec(node.body); }
            catch (e) { if (e === AWK_BREAK) break; if (e !== AWK_CONTINUE) throw e; }
          }
          return;
        }
        case 'break': throw AWK_BREAK;
        case 'continue': throw AWK_CONTINUE;
        case 'next': throw AWK_NEXT;
        case 'nextfile': throw AWK_NEXTFILE;
        case 'exit': throw new AwkExit(node.value ? Math.trunc(awkNumber(await ev(node.value))) & 255 : null);
        case 'return': throw new AwkReturn(node.value ? await ev(node.value) : undefined);
        case 'delete': {
          var arr = arrayOf(node.name);
          if (node.subs) arr.delete(subscript(await evalAll(node.subs)));
          else arr.clear();
          return;
        }
      }
      throw new AwkError('unknown statement ' + node.type);
    }

    // ---- program ----
    [['FS', ' '], ['OFS', ' '], ['ORS', '\n'], ['RS', '\n'], ['SUBSEP', '\x1c'], ['CONVFMT', '%.6g'], ['OFMT', '%.6g'], ['NR', 0], ['FNR', 0], ['RSTART', 0], ['RLENGTH', -1], ['FILENAME', ''], ['RT', '']]
      .forEach(function (pair) { globals.set(pair[0], { kind: 'scalar', value: pair[1] }); });
    var environ = new Map();
    Object.keys(ctx.env).forEach(function (k) { environ.set(k, awkInput(String(ctx.env[k]))); });
    globals.set('ENVIRON', { kind: 'array', value: environ });
    var argvMap = new Map([['0', 'awk']]);
    setup.operands.forEach(function (op, i) { argvMap.set(String(i + 1), awkInput(op)); });
    globals.set('ARGV', { kind: 'array', value: argvMap });
    globals.set('ARGC', { kind: 'scalar', value: setup.operands.length + 1 });
    if (setup.fs != null) setScalar('FS', setup.fs);
    setup.assignments.forEach(applyAssignment);

    var begins = program.items.filter(function (it) { return it.kind === 'BEGIN'; });
    var mains = program.items.filter(function (it) { return it.kind === 'main'; });
    var ends = program.items.filter(function (it) { return it.kind === 'END'; });
    var exitCode = 0;
    async function runRules(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.kind === 'main') {
          var matched;
          if (!rule.pattern) matched = true;
          else if (rule.pattern2) {
            if (rangeActive.get(rule)) { matched = true; if (awkBool(await ev(rule.pattern2))) rangeActive.set(rule, false); }
            else if (awkBool(await ev(rule.pattern))) { matched = true; rangeActive.set(rule, !awkBool(await ev(rule.pattern2))); }
            else matched = false;
          } else matched = awkBool(await ev(rule.pattern));
          if (!matched) continue;
          if (!rule.action) { await output(record + str(special('ORS')), null); continue; }
        }
        await exec(rule.action);
      }
    }
    try {
      try { await runRules(begins); }
      catch (e) { if (e instanceof AwkExit) { exiting = e; } else if (e === AWK_NEXT || e === AWK_NEXTFILE) throw new AwkError('`next\' used in BEGIN action'); else throw e; }
      if (!exiting && (mains.length || ends.length)) {
        var rec;
        while ((rec = await nextMainRecord()) !== null) {
          setScalar('NR', awkNumber(special('NR')) + 1);
          setScalar('FNR', awkNumber(special('FNR')) + 1);
          setRecord(rec);
          try { await runRules(mains); }
          catch (e) {
            if (e === AWK_NEXT) continue;
            if (e === AWK_NEXTFILE) { mainReader = null; continue; }
            if (e instanceof AwkExit) { exiting = e; break; }
            throw e;
          }
        }
      }
      if (exiting && exiting.code != null) exitCode = exiting.code;
      try { await runRules(ends); }
      catch (e) { if (e instanceof AwkExit) { if (e.code != null) exitCode = e.code; } else throw e; }
    } finally {
      await flushOutputs(true);
    }
    return exitCode || setup.status || 0;
  }

  utility('awk', { usage: '[POSIX or GNU style options] -f progfile [--] file ...' }, async function (ctx) {
    var args = ctx.args, i = 0, fs = null, assignments = [], programFiles = [], programText = null;
    while (i < args.length) {
      var a = args[i];
      if (a === '--') { i++; break; }
      if (a === '-F' || a === '--field-separator') { fs = args[++i]; i++; continue; }
      if (/^-F./.test(a)) { fs = a.slice(2); i++; continue; }
      if (/^--field-separator=/.test(a)) { fs = a.slice(18); i++; continue; }
      if (a === '-v' || a === '--assign') { assignments.push(args[++i]); i++; continue; }
      if (/^-v./.test(a)) { assignments.push(a.slice(2)); i++; continue; }
      if (a === '-f' || a === '--file') { programFiles.push(args[++i]); i++; continue; }
      if (a === '-e' || a === '--source') { programText = (programText ? programText + '\n' : '') + args[++i]; i++; continue; }
      if (a === '--posix' || a === '--traditional' || a === '-P' || a === '-c' || a === '--re-interval' || a === '-r' || a === '--characters-as-bytes' || a === '-b' || a === '--sandbox' || a === '-S') { i++; continue; }
      if (a.charAt(0) === '-' && a.length > 1) { ctx.error(a + ': unknown option'); return 2; }
      break;
    }
    if (fs === undefined || assignments.some(function (x) { return x === undefined || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x); })) {
      ctx.error("fatal: `" + (assignments.filter(function (x) { return x && !/=/.test(x); })[0] || '') + "' is not a legal variable name");
      return 2;
    }
    if (fs === 't') fs = '\t';
    else if (fs != null) fs = awkUnescape(fs);
    for (var f = 0; f < programFiles.length; f++) {
      try { programText = (programText ? programText + '\n' : '') + await ctx.readFile(programFiles[f]); }
      catch (e) { ctx.error('fatal: can\'t open source file `' + programFiles[f] + '\' for reading: ' + errorReason(e)); return 2; }
    }
    if (programText === null) {
      if (i >= args.length) { ctx.stderr.write('Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\nUsage: awk [POSIX or GNU style options] [--] \'program\' file ...\n'); return 2; }
      programText = args[i++];
    }
    var program;
    try { program = parseAwk(programText); }
    catch (e) {
      if (e instanceof AwkError && e.syntax) {
        var sourceLines = programText.split('\n'), lineText = sourceLines[(e.line || 1) - 1] || '';
        var lineStart = programText.split('\n').slice(0, (e.line || 1) - 1).join('\n').length + ((e.line || 1) > 1 ? 1 : 0);
        var column = Math.max(0, Math.min(lineText.length, (e.column == null ? lineText.length : e.column - lineStart)));
        ctx.stderr.write('awk: cmd. line:' + (e.line || 1) + ': ' + lineText + '\nawk: cmd. line:' + (e.line || 1) + ': ' + ' '.repeat(column) + '^ ' + e.message + '\n');
        return 1;
      }
      throw e;
    }
    var setup = { operands: args.slice(i), fs: fs, assignments: assignments, status: 0, depth: 0 };
    try { return await runAwk(ctx, program, setup); }
    catch (e) {
      if (e instanceof AwkError) {
        ctx.stderr.write('awk: cmd. line:1: ' + (/division by zero/.test(e.message) ? 'error' : 'fatal') + ': ' + e.message + '\n');
        return /division by zero/.test(e.message) ? 1 : e.exitCode;
      }
      if (e === AWK_BREAK || e === AWK_CONTINUE) { ctx.stderr.write('awk: cmd. line:1: error: `break\' is not allowed outside a loop\n'); return 1; }
      if (e instanceof AwkReturn) { ctx.stderr.write('awk: cmd. line:1: error: `return\' used outside function context\n'); return 1; }
      throw e;
    }
  });

  // ==========================================================================
  // §12 diff and patch
  // ==========================================================================
  // Myers O(ND) diff over arrays of comparison keys. Returns change groups
  // { i1, i2, j1, j2 } (half-open ranges into a and b).
  function diffSequences(a, b) {
    var start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    var n = endA - start, m = endB - start, max = n + m, offset = max + 1;
    var v = new Int32Array(2 * max + 3), trace = [];
    var found = n === 0 && m === 0;
    for (var d = 0; d <= max && !found; d++) {
      trace.push(v.slice(offset - d - 1, offset + d + 2));
      for (var k = -d; k <= d; k += 2) {
        var x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        var y = x - k;
        while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) { found = true; break; }
      }
    }
    // Backtrack through the saved frontiers to recover the edit script.
    var ops = [], x2 = n, y2 = m;
    for (var dd = trace.length - 1; dd >= 0 && (x2 > 0 || y2 > 0); dd--) {
      var saved = trace[dd], base = dd + 1;
      function at(kk) { return saved[base + kk]; }
      var k2 = x2 - y2;
      var prevK = (k2 === -dd || (k2 !== dd && at(k2 - 1) < at(k2 + 1))) ? k2 + 1 : k2 - 1;
      var prevX = dd === 0 ? 0 : at(prevK), prevY = prevX - prevK;
      while (x2 > prevX && y2 > prevY) { ops.push('='); x2--; y2--; }
      if (dd > 0) { ops.push(x2 === prevX ? '+' : '-'); if (x2 === prevX) y2--; else x2--; }
    }
    while (x2 > 0 && y2 > 0) { ops.push('='); x2--; y2--; }
    ops.reverse();
    var changes = [], i = start, j = start, current = null;
    ops.forEach(function (op) {
      if (op === '=') { if (current) { changes.push(current); current = null; } i++; j++; return; }
      if (!current) current = { i1: i, i2: i, j1: j, j2: j };
      if (op === '-') { i++; current.i2 = i; } else { j++; current.j2 = j; }
    });
    if (current) changes.push(current);
    return changes;
  }

  function diffKey(record, o) {
    var text = record;
    if (o.stripCr) text = text.replace(/\r(\n?)$/, '$1');
    var nl = text.charAt(text.length - 1) === '\n' ? '\n' : '';
    var body = nl ? text.slice(0, -1) : text;
    if (o.ignoreCase) body = body.toLowerCase();
    if (o.ignoreAllSpace) body = body.replace(/[ \t\r\f\v]+/g, '');
    else if (o.ignoreSpaceChange) body = body.replace(/[ \t\r\f\v]+/g, ' ').replace(/ $/, '');
    else if (o.ignoreTrailingSpace) body = body.replace(/[ \t\r\f\v]+$/, '');
    return body + nl;
  }

  // Groups changes into hunks with `context` lines around them.
  function diffHunks(changes, lengthA, lengthB, context) {
    var hunks = [];
    changes.forEach(function (c) {
      var last = hunks[hunks.length - 1];
      if (last && c.i1 - last.changes[last.changes.length - 1].i2 <= 2 * context) last.changes.push(c);
      else hunks.push({ changes: [c] });
    });
    hunks.forEach(function (h) {
      var first = h.changes[0], lastChange = h.changes[h.changes.length - 1];
      h.i1 = Math.max(0, first.i1 - context); h.j1 = Math.max(0, first.j1 - (first.i1 - h.i1));
      h.i2 = Math.min(lengthA, lastChange.i2 + context); h.j2 = Math.min(lengthB, lastChange.j2 + (h.i2 - lastChange.i2));
    });
    return hunks;
  }

  // Unified headers use ISO-style times; context headers use ctime style.
  function diffTimestamp(st, ctx, contextStyle) {
    var when = st && st.mtime != null ? new Date(st.mtime) : ctx.now();
    var zone = normalizeZone(ctx.timezone);
    if (contextStyle) return strftime(when, '%a %b %e %H:%M:%S %Y', zone);
    return strftime(when, '%Y-%m-%d %H:%M:%S', zone) + '.' + String(when.getTime() % 1000).padStart(3, '0') + '000000 ' + strftime(when, '%z', zone);
  }

  // Formats a diff between two texts. Returns '' when they are equal.
  function formatDiff(textA, textB, o) {
    var recA = records(textA), recB = records(textB);
    var keysA = recA.map(function (r) { return diffKey(r, o); }), keysB = recB.map(function (r) { return diffKey(r, o); });
    var changes = diffSequences(keysA, keysB);
    if (o.ignoreBlankLines) changes = changes.filter(function (c) {
      return !(recA.slice(c.i1, c.i2).concat(recB.slice(c.j1, c.j2)).every(function (r) { return /^\s*$/.test(r); }));
    });
    if (!changes.length) return '';
    function body(r) { return r.charAt(r.length - 1) === '\n' ? r.slice(0, -1) : r; }
    function line(prefix, r) { return prefix + body(r) + '\n' + (r.charAt(r.length - 1) === '\n' ? '' : '\\ No newline at end of file\n'); }
    function range(a, b) { return a === b ? String(a) : a + ',' + b; }
    var out = '';
    if (o.format === 'normal') {
      changes.forEach(function (c) {
        var del = c.i2 > c.i1, add = c.j2 > c.j1;
        out += (del ? range(c.i1 + 1, c.i2) : String(c.i1)) + (del && add ? 'c' : del ? 'd' : 'a') + (add ? range(c.j1 + 1, c.j2) : String(c.j1)) + '\n';
        recA.slice(c.i1, c.i2).forEach(function (r) { out += line('< ', r); });
        if (del && add) out += '---\n';
        recB.slice(c.j1, c.j2).forEach(function (r) { out += line('> ', r); });
      });
      return out;
    }
    if (o.format === 'side') {
      // GNU layout: column widths from the total width and 8-column tabs;
      // padding uses tabs, then spaces.
      var width = o.width || 130, tab = 8;
      var off = Math.floor((width + tab + 3) / (2 * tab)) * tab;
      var half = Math.max(0, Math.min(off - 3, width - off)), col2 = half ? off : width;
      var sepCol = Math.floor((half + col2 - 1) / 2);
      function tabTo(from, to) {
        var s = '';
        while ((Math.floor(from / tab) + 1) * tab <= to) { s += '\t'; from = (Math.floor(from / tab) + 1) * tab; }
        return s + ' '.repeat(Math.max(0, to - from));
      }
      function halfLine(r) {
        var text = '', col = 0, chars = Array.from(body(r));
        for (var c = 0; c < chars.length; c++) {
          var next = chars[c] === '\t' ? (Math.floor(col / tab) + 1) * tab : col + 1;
          if (next > half) break;
          text += chars[c]; col = next;
        }
        return { text: text, col: col };
      }
      function hasNewline(r) { return r.charAt(r.length - 1) === '\n'; }
      var i = 0, j = 0;
      function emitPair(l, mark, r) {
        var line = '', col = 0;
        if (l != null) { var h = halfLine(l); line += h.text; col = h.col; }
        if (mark === '|' && hasNewline(l) !== hasNewline(r)) mark = hasNewline(l) ? '/' : '\\';
        if (mark !== ' ') { line += tabTo(col, sepCol) + mark; col = sepCol + 1; }
        if (r != null) { if (col < col2) line += tabTo(col, col2); line += halfLine(r).text; }
        out += line + '\n';
      }
      changes.concat([{ i1: recA.length, i2: recA.length, j1: recB.length, j2: recB.length }]).forEach(function (c) {
        while (i < c.i1) { if (!o.suppressCommon) emitPair(recA[i], ' ', recB[j]); i++; j++; }
        var dels = c.i2 - c.i1, adds = c.j2 - c.j1;
        for (var k = 0; k < Math.max(dels, adds); k++) {
          if (k < dels && k < adds) emitPair(recA[c.i1 + k], '|', recB[c.j1 + k]);
          else if (k < dels) emitPair(recA[c.i1 + k], '<', null);
          else emitPair(null, '>', recB[c.j1 + k]);
        }
        i = c.i2; j = c.j2;
      });
      return out;
    }
    var hunks = diffHunks(changes, recA.length, recB.length, o.context);
    if (o.format === 'unified') {
      out += '--- ' + o.labelA + '\n+++ ' + o.labelB + '\n';
      hunks.forEach(function (h) {
        var countA = h.i2 - h.i1, countB = h.j2 - h.j1;
        out += '@@ -' + (countA ? h.i1 + 1 : h.i1) + (countA === 1 ? '' : ',' + countA) + ' +' + (countB ? h.j1 + 1 : h.j1) + (countB === 1 ? '' : ',' + countB) + ' @@\n';
        var i = h.i1, j = h.j1;
        h.changes.forEach(function (c) {
          while (i < c.i1) { out += line(' ', recA[i]); i++; j++; }
          recA.slice(c.i1, c.i2).forEach(function (r) { out += line('-', r); });
          recB.slice(c.j1, c.j2).forEach(function (r) { out += line('+', r); });
          i = c.i2; j = c.j2;
        });
        while (i < h.i2) { out += line(' ', recA[i]); i++; }
      });
      return out;
    }
    // Context format.
    out += '*** ' + o.labelA + '\n--- ' + o.labelB + '\n';
    hunks.forEach(function (h) {
      out += '***************\n';
      var countA = h.i2 - h.i1, countB = h.j2 - h.j1;
      out += '*** ' + (countA ? range(h.i1 + 1, h.i2) : String(h.i1)) + ' ****\n';
      var anyDel = h.changes.some(function (c) { return c.i2 > c.i1; }), anyAdd = h.changes.some(function (c) { return c.j2 > c.j1; });
      function section(isOld) {
        var text = '', pos = isOld ? h.i1 : h.j1, end = isOld ? h.i2 : h.j2, recs = isOld ? recA : recB;
        h.changes.forEach(function (c) {
          var from = isOld ? c.i1 : c.j1, to = isOld ? c.i2 : c.j2;
          while (pos < from) { text += line('  ', recs[pos]); pos++; }
          var mark = (c.i2 > c.i1 && c.j2 > c.j1) ? '! ' : isOld ? '- ' : '+ ';
          for (; pos < to; pos++) text += line(mark, recs[pos]);
        });
        while (pos < end) { text += line('  ', recs[pos]); pos++; }
        return text;
      }
      if (anyDel) out += section(true);
      out += '--- ' + (countB ? range(h.j1 + 1, h.j2) : String(h.j1)) + ' ----\n';
      if (anyAdd) out += section(false);
    });
    return out;
  }

  utility('diff', { usageCode: 2, usage: '[OPTION]... FILES' }, async function (ctx) {
    var o = getopt(ctx.args, {
      flags: 'abBcdeEfhHiNnpqrsStTuwyZ', params: 'CUWxXDFIlLS', numeric: true,
      long: { text: 'a', 'ignore-space-change': 'b', 'ignore-blank-lines': 'B', context: { key: 'C', arg: 'optional' }, unified: { key: 'U', arg: 'optional' }, 'ignore-case': 'i', 'ignore-all-space': 'w', 'ignore-trailing-space': 'Z', 'strip-trailing-cr': 'cr', brief: 'q', 'report-identical-files': 's', 'new-file': 'N', 'unidirectional-new-file': 'P', recursive: 'r', 'side-by-side': 'y', width: { key: 'W', arg: true }, 'suppress-common-lines': 'scl', label: { key: 'L', arg: true }, normal: 'normal', exclude: { key: 'x', arg: true }, 'exclude-from': { key: 'X', arg: true }, color: { key: 'color', arg: 'optional' }, minimal: 'd', 'expand-tabs': 't', 'initial-tab': 'T', 'show-c-function': 'p', 'speed-large-files': 'H', 'starting-file': { key: 'S', arg: true }, 'no-dereference': 'nd', 'from-file': { key: 'from', arg: true }, 'to-file': { key: 'to', arg: true } }
    });
    var formatKey = o.last(['c', 'C', 'u', 'U', 'y', 'normal', 'q', 'e', 'n', '#']);
    var context = 3;
    o.list.forEach(function (p) { if ((p[0] === 'C' || p[0] === 'U') && p[1] !== true) context = Number(p[1]); if (p[0] === '#') context = Number(p[1]); });
    if (isNaN(context) || context < 0) throw new UsageError('invalid context length ' + quoteName(o.get('C') || o.get('U')));
    var format = { c: 'context', C: 'context', u: 'unified', U: 'unified', y: 'side', '#': o.has('c') ? 'context' : 'unified' }[formatKey] || 'normal';
    if (o.has('e')) { ctx.error('ed script output (-e) is not supported by bash.js'); return 2; }
    var labels = o.all('L'), excludes = o.all('x');
    var opts = { ignoreCase: o.has('i'), ignoreAllSpace: o.has('w'), ignoreSpaceChange: o.has('b'), ignoreTrailingSpace: o.has('Z'), stripCr: o.has('cr'), ignoreBlankLines: o.has('B'), context: context, format: format, width: o.get('W') ? Number(o.get('W')) : 130, suppressCommon: o.has('scl') };
    var operands = o.operands.slice();
    if (o.get('from') != null) operands.unshift(o.get('from'));
    if (o.get('to') != null) operands.push(o.get('to'));
    if (operands.length < 2) throw new UsageError(operands.length ? 'missing operand after ' + quoteName(operands[0]) : 'missing operand');
    if (operands.length > 2) throw new UsageError('extra operand ' + quoteName(operands[2]));
    var optionWords = ctx.args.filter(function (a) { return o.operands.indexOf(a) < 0; });
    var out = '', status = 0;
    async function load(name) {
      if (name === '-') return { text: ctx.stdin.readAll(), st: { type: 'file' } };
      // Process substitutions and /dev/stdin are not in the file system.
      if (/^\/dev\/(fd\/\d+|stdin)$/.test(ctx.resolve(name))) {
        try { return { text: await ctx.readFile(name), st: { type: 'file' } }; } catch (_) { return null; }
      }
      var st = await ctx.vfs.stat(ctx.resolve(name));
      if (!st) return null;
      if (st.type === 'dir') return { dir: true, st: st };
      return { text: await ctx.readFile(name), st: st };
    }
    async function compareFiles(nameA, nameB, a, b, header) {
      if (!a || !b) {
        if (!o.has('N') && !(o.has('P') && !a)) {
          ctx.error((a ? nameB : nameA) + ': No such file or directory'); status = 2; return;
        }
        a = a || { text: '', st: null }; b = b || { text: '', st: null };
      }
      if (a.text === b.text && !(o.has('N') && (!a.st || !b.st) && a.text !== b.text)) {
        if (o.has('s')) out += 'Files ' + nameA + ' and ' + nameB + ' are identical\n';
        return;
      }
      if (!o.has('a') && (isBinary(a.text) || isBinary(b.text))) {
        out += 'Binary files ' + nameA + ' and ' + nameB + ' differ\n'; status = Math.max(status, 1); return;
      }
      if (o.has('q')) {
        if (formatDiff(a.text, b.text, Object.assign({}, opts, { format: 'normal' }))) { out += 'Files ' + nameA + ' and ' + nameB + ' differ\n'; status = Math.max(status, 1); }
        return;
      }
      var labelA = labels[0] != null ? labels[0] : nameA + '\t' + diffTimestamp(a.st, ctx, format === 'context');
      var labelB = labels[1] != null ? labels[1] : nameB + '\t' + diffTimestamp(b.st, ctx, format === 'context');
      var text = formatDiff(a.text, b.text, Object.assign({}, opts, { labelA: labelA, labelB: labelB }));
      if (!text) { if (o.has('s')) out += 'Files ' + nameA + ' and ' + nameB + ' are identical\n'; return; }
      if (header) out += header;
      out += text;
      status = Math.max(status, 1);
    }
    async function compareDirs(dirA, dirB) {
      var namesA = (await ctx.vfs.readDir(ctx.resolve(dirA))).map(function (e) { return e.name; });
      var namesB = (await ctx.vfs.readDir(ctx.resolve(dirB))).map(function (e) { return e.name; });
      var all = Array.from(new Set(namesA.concat(namesB))).sort(compareBytes)
        .filter(function (name) { return !excludes.some(function (g) { return globTest(g, name); }); });
      for (var i = 0; i < all.length; i++) {
        var name = all[i], pathA = dirA.replace(/\/$/, '') + '/' + name, pathB = dirB.replace(/\/$/, '') + '/' + name;
        var inA = namesA.indexOf(name) >= 0, inB = namesB.indexOf(name) >= 0;
        if (!inA || !inB) {
          if (o.has('N') || (o.has('P') && !inA)) {
            var existing = await load(inA ? pathA : pathB);
            if (existing && existing.dir) { out += 'Only in ' + (inA ? dirA : dirB) + ': ' + name + '\n'; status = Math.max(status, 1); continue; }
            await compareFiles(pathA, pathB, inA ? existing : null, inB ? existing : null, 'diff ' + optionWords.join(' ') + ' ' + pathA + ' ' + pathB + '\n');
            continue;
          }
          out += 'Only in ' + (inA ? dirA : dirB) + ': ' + name + '\n'; status = Math.max(status, 1); continue;
        }
        var a = await load(pathA), b = await load(pathB);
        if (a.dir && b.dir) {
          if (o.has('r')) await compareDirs(pathA, pathB);
          else out += 'Common subdirectories: ' + pathA + ' and ' + pathB + '\n';
          continue;
        }
        if (a.dir !== b.dir) {
          out += (a.dir ? 'File ' + pathB + ' is a regular file while file ' + pathA + ' is a directory\n' : 'File ' + pathA + ' is a regular file while file ' + pathB + ' is a directory\n').replace(/^File (\S+) is a regular file while file (\S+) is a directory$/m, function (m) { return m; });
          status = Math.max(status, 1); continue;
        }
        await compareFiles(pathA, pathB, a, b, o.has('q') ? '' : 'diff ' + optionWords.join(' ').replace(/^\s*/, '') + (optionWords.length ? ' ' : '') + pathA + ' ' + pathB + '\n');
      }
    }
    var nameA = operands[0], nameB = operands[1];
    var a = await load(nameA), b = await load(nameB);
    if (a && b && a.dir && b.dir) await compareDirs(nameA, nameB);
    else {
      // A directory operand compares against the file of the same name inside it.
      if (a && a.dir && b) { nameA = nameA.replace(/\/$/, '') + '/' + posixBasename(nameB); a = await load(nameA); }
      else if (b && b.dir && a) { nameB = nameB.replace(/\/$/, '') + '/' + posixBasename(nameA); b = await load(nameB); }
      await compareFiles(nameA, nameB, a, b, '');
    }
    ctx.stdout.write(out);
    return status;
  });

  // Parses a patch into file patches: { oldName, newName, hunks, header }.
  // Hunk lines are { type: ' ' | '-' | '+', text, eol }.
  function parsePatch(text) {
    var all = records(text), files = [], i = 0;
    function body(r) { return r.replace(/\r?\n$/, ''); }
    function fileName(spec) { var name = body(spec).replace(/\t.*$/, ''); return name.replace(/^"(.*)"$/, '$1').replace(/\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)? [+-]\d{4}$/, ''); }
    function markNoEol(lines) { if (lines.length) lines[lines.length - 1].eol = false; }
    var pending = { header: [], git: {} };
    while (i < all.length) {
      var line = body(all[i]);
      if (/^diff --git /.test(line)) { pending = { header: [all[i]], git: {} }; i++; continue; }
      if (/^new file mode/.test(line)) { pending.git.created = true; pending.header.push(all[i]); i++; continue; }
      if (/^deleted file mode/.test(line)) { pending.git.deleted = true; pending.header.push(all[i]); i++; continue; }
      if (/^--- /.test(line) && i + 1 < all.length && /^\+\+\+ /.test(body(all[i + 1]))) {
        var file = { oldName: fileName(line.slice(4)), newName: fileName(body(all[i + 1]).slice(4)), hunks: [], header: pending.header.concat([all[i], all[i + 1]]), startLine: i + 1, git: pending.git, format: 'unified' };
        pending = { header: [], git: {} };
        i += 2;
        while (i < all.length) {
          var h = body(all[i]).match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (!h) break;
          var hunk = { oldStart: Number(h[1]), oldCount: h[2] == null ? 1 : Number(h[2]), newStart: Number(h[3]), newCount: h[4] == null ? 1 : Number(h[4]), lines: [], startLine: i + 1 };
          i++;
          var seenOld = 0, seenNew = 0;
          while (i < all.length && (seenOld < hunk.oldCount || seenNew < hunk.newCount)) {
            var raw = all[i], t = raw.charAt(0), content = body(raw).slice(1);
            if (raw === '\n' || raw === '\r\n' || raw === '') { t = ' '; content = ''; }
            if (t === '\\') { markNoEol(hunk.lines); i++; continue; }
            if (t !== ' ' && t !== '-' && t !== '+') break;
            hunk.lines.push({ type: t, text: content, eol: true });
            if (t !== '+') seenOld++;
            if (t !== '-') seenNew++;
            i++;
          }
          if (i < all.length && all[i].charAt(0) === '\\') { markNoEol(hunk.lines); i++; }
          file.hunks.push(hunk);
        }
        files.push(file);
        continue;
      }
      if (/^\*\*\* /.test(line) && i + 1 < all.length && /^--- /.test(body(all[i + 1])) && i + 2 < all.length && /^\*{15}/.test(body(all[i + 2]))) {
        var cfile = { oldName: fileName(line.slice(4)), newName: fileName(body(all[i + 1]).slice(4)), hunks: [], header: [all[i], all[i + 1]], startLine: i + 1, git: {}, format: 'context' };
        i += 2;
        while (i < all.length && /^\*{15}/.test(body(all[i]))) {
          i++;
          var oh = body(all[i] || '').match(/^\*\*\* (\d+)(?:,(\d+))? \*\*\*\*/);
          if (!oh) break;
          i++;
          var oldLines = [], newLines = [];
          while (i < all.length && !/^--- \d+(,\d+)? ----/.test(body(all[i]))) {
            if (all[i].charAt(0) === '\\') { markNoEol(oldLines); i++; continue; }
            oldLines.push({ mark: all[i].charAt(0), text: body(all[i]).slice(2), eol: true }); i++;
          }
          var nh = body(all[i] || '').match(/^--- (\d+)(?:,(\d+))? ----/);
          if (!nh) break;
          i++;
          while (i < all.length && /^[ +!\\-]/.test(all[i]) && !/^\*{15}/.test(body(all[i])) && !(/^--- /.test(body(all[i])) && /^\+\+\+ /.test(body(all[i + 1] || ''))) && !/^\*\*\* /.test(body(all[i]))) {
            if (all[i].charAt(0) === '\\') { markNoEol(newLines); i++; continue; }
            newLines.push({ mark: all[i].charAt(0), text: body(all[i]).slice(2), eol: true }); i++;
          }
          if (!oldLines.length) oldLines = newLines.filter(function (l) { return l.mark === ' '; });
          if (!newLines.length) newLines = oldLines.filter(function (l) { return l.mark === ' '; });
          var merged = [], a = 0, b = 0;
          while (a < oldLines.length || b < newLines.length) {
            if (a < oldLines.length && b < newLines.length && oldLines[a].mark === ' ' && newLines[b].mark === ' ') { merged.push({ type: ' ', text: newLines[b].text, eol: newLines[b].eol }); a++; b++; continue; }
            while (a < oldLines.length && oldLines[a].mark !== ' ') { merged.push({ type: '-', text: oldLines[a].text, eol: oldLines[a].eol }); a++; }
            while (b < newLines.length && newLines[b].mark !== ' ') { merged.push({ type: '+', text: newLines[b].text, eol: newLines[b].eol }); b++; }
            if (a < oldLines.length && b >= newLines.length) { merged.push({ type: '-', text: oldLines[a].text, eol: oldLines[a].eol }); a++; }
            else if (b < newLines.length && a >= oldLines.length) { merged.push({ type: '+', text: newLines[b].text, eol: newLines[b].eol }); b++; }
          }
          var oStart = Number(oh[1]), oEnd = oh[2] ? Number(oh[2]) : oStart, nStart = Number(nh[1]), nEnd = nh[2] ? Number(nh[2]) : nStart;
          cfile.hunks.push({ oldStart: oStart, oldCount: merged.filter(function (l) { return l.type !== '+'; }).length || (oEnd >= oStart && oStart ? oEnd - oStart + 1 : 0), newStart: nStart, newCount: merged.filter(function (l) { return l.type !== '-'; }).length, lines: merged });
        }
        files.push(cfile);
        continue;
      }
      var nm = line.match(/^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/);
      if (nm) {
        var nfile = files.length && files[files.length - 1].format === 'normal' ? files[files.length - 1] : null;
        if (!nfile) { nfile = { oldName: null, newName: null, hunks: [], header: [], startLine: i + 1, git: {}, format: 'normal' }; files.push(nfile); }
        var o1 = Number(nm[1]), o2 = nm[2] ? Number(nm[2]) : o1, n1 = Number(nm[4]), n2 = nm[5] ? Number(nm[5]) : n1, kind = nm[3];
        var nhunk = { oldStart: kind === 'a' ? o1 : o1, oldCount: kind === 'a' ? 0 : o2 - o1 + 1, newStart: kind === 'd' ? n1 : n1, newCount: kind === 'd' ? 0 : n2 - n1 + 1, lines: [] };
        if (kind === 'a') nhunk.oldStart = o1 + 0;
        i++;
        while (i < all.length && /^(< |> |---$|\\)/.test(body(all[i]))) {
          var nl = body(all[i]);
          if (nl.charAt(0) === '\\') markNoEol(nhunk.lines);
          else if (nl !== '---') nhunk.lines.push({ type: nl.charAt(0) === '<' ? '-' : '+', text: nl.slice(2), eol: true });
          i++;
        }
        nfile.hunks.push(nhunk);
        continue;
      }
      pending.header.push(all[i]);
      i++;
    }
    return files;
  }

  utility('patch', { usage: '[OPTION]... [ORIGFILE [PATCHFILE]]' }, async function (ctx) {
    var o = getopt(ctx.args, {
      flags: 'bcEefNnRstuvlZTU', params: 'pidoBrzFDYVg',
      long: { strip: { key: 'p', arg: true }, input: { key: 'i', arg: true }, directory: { key: 'd', arg: true }, output: { key: 'o', arg: true }, reverse: 'R', forward: 'N', 'dry-run': 'dry', backup: 'b', suffix: { key: 'z', arg: true }, 'remove-empty-files': 'E', silent: 's', quiet: 's', force: 'f', batch: 't', fuzz: { key: 'F', arg: true }, 'ignore-whitespace': 'l', 'reject-file': { key: 'r', arg: true }, binary: 'binary', verbose: 'v', unified: 'u', context: 'c', normal: 'n', 'no-backup-if-mismatch': 'nobk', 'backup-if-mismatch': 'bk', posix: 'posix', 'set-utc': 'Z', 'set-time': 'T', 'reject-format': { key: 'rf', arg: true }, 'read-only': { key: 'ro', arg: true }, follow: 'follow', merge: { key: 'merge', arg: 'optional' }, quoting: { key: 'qs', arg: true } }
    });
    var strip = o.get('p') != null ? Number(o.get('p')) : null, fuzzMax = o.get('F') != null ? Number(o.get('F')) : 2;
    var dryRun = o.has('dry'), silent = o.has('s'), reverse = o.has('R'), loose = o.has('l');
    var out = '', status = 0, baseDir = o.get('d') != null ? ctx.resolve(o.get('d')) : ctx.cwd;
    function say(text) { if (!silent) out += text; }
    function resolve(name) { return resolvePath(baseDir, name); }
    var patchText;
    var patchSource = o.get('i') != null ? o.get('i') : o.operands[1];
    try { patchText = patchSource != null ? await ctx.readFile(patchSource) : ctx.stdin.readAll(); }
    catch (e) { ctx.error("**** Can't open patch file " + patchSource + ' : ' + errorReason(e)); return 2; }
    var files = parsePatch(patchText);
    if (!files.length || files.every(function (f) { return !f.hunks.length && !f.git.created && !f.git.deleted; })) {
      if (patchText.trim()) { ctx.error('**** Only garbage was found in the patch input.'); return 2; }
      return 0;
    }
    function stripName(name) {
      if (!name || name === '/dev/null') return null;
      if (strip === null) return name;
      var parts = name.split('/');
      if (strip >= parts.length) return null;
      return parts.slice(strip).join('/');
    }
    async function chooseTarget(file) {
      if (o.operands[0] != null) return o.operands[0];
      var candidates = [stripName(file.oldName), stripName(file.newName)].filter(Boolean);
      for (var c = 0; c < candidates.length; c++) if (await ctx.vfs.isFile(resolve(candidates[c]))) return candidates[c];
      if (strip === null) {
        // Without -p, fall back to base names that exist.
        for (var b = 0; b < candidates.length; b++) if (await ctx.vfs.isFile(resolve(posixBasename(candidates[b])))) return posixBasename(candidates[b]);
      }
      var creating = file.oldName === '/dev/null' || file.git.created || file.hunks.every(function (h) { return h.oldCount === 0 && h.oldStart === 0; });
      if (creating) return stripName(file.newName) || (strip === null && file.newName ? posixBasename(file.newName) : null);
      return null;
    }
    // A hunk seen from the side being applied (-R swaps the sides).
    function hunkSides(h, flip) {
      var rev = flip ? !reverse : reverse;
      var lines = h.lines.map(function (l) { return { type: rev ? (l.type === '+' ? '-' : l.type === '-' ? '+' : ' ') : l.type, text: l.text, eol: l.eol }; });
      var prefix = 0, suffix = 0;
      while (prefix < lines.length && lines[prefix].type === ' ') prefix++;
      while (suffix < lines.length - prefix && lines[lines.length - 1 - suffix].type === ' ') suffix++;
      var start = rev ? h.newStart : h.oldStart, count = rev ? h.newCount : h.oldCount;
      return { lines: lines, pattern: lines.filter(function (l) { return l.type !== '+'; }), prefix: prefix, suffix: suffix, first: count === 0 ? start + 1 : start };
    }
    function same(a, b) { return loose ? a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim() : a === b; }
    // Pattern line i (0-based) is compared with input line base + offset + i (1-based).
    function patchMatch(input, pattern, base, offset, prefixFuzz, suffixFuzz) {
      for (var i = prefixFuzz; i < pattern.length - suffixFuzz; i++) {
        var ln = base + offset + i;
        if (ln < 1 || ln > input.length || !same(input[ln - 1].text, pattern[i].text)) return false;
      }
      return true;
    }
    // GNU patch's locate_hunk: a hunk with less leading (trailing) context than
    // its other end is anchored to the start (end) of the file; fuzz lets that
    // many context lines be ignored. Returns a 1-based line, or 0.
    function locateHunk(input, side, fuzz, state) {
      var firstGuess = side.first + state.inOffset, patLines = side.pattern.length;
      var context = Math.max(side.prefix, side.suffix);
      var prefixFuzz = fuzz + side.prefix - context, suffixFuzz = fuzz + side.suffix - context;
      var maxWhere = input.length - (patLines - suffixFuzz) + 1, minWhere = state.lastFrozen + 1 - (side.prefix - prefixFuzz);
      var maxPos = maxWhere - firstGuess, maxNeg = firstGuess - minWhere, maxOffset = Math.max(maxPos, maxNeg);
      if (!patLines) return firstGuess;
      if (firstGuess <= maxNeg) maxNeg = firstGuess - 1;
      if (prefixFuzz < 0 && side.first <= 1) {
        if (suffixFuzz < 0 && (patLines !== input.length || side.prefix < state.lastFrozen)) return 0;
        var startOffset = 1 - firstGuess;
        if (state.lastFrozen <= side.prefix && startOffset <= maxPos && patchMatch(input, side.pattern, firstGuess, startOffset, 0, Math.max(0, suffixFuzz))) return firstGuess + startOffset;
        return 0;
      }
      if (prefixFuzz < 0) prefixFuzz = 0;
      if (suffixFuzz < 0) {
        var endOffset = firstGuess - (input.length - patLines + 1);
        if (endOffset <= maxNeg && patchMatch(input, side.pattern, firstGuess, -endOffset, prefixFuzz, 0)) return firstGuess - endOffset;
        return 0;
      }
      for (var offset = 0; offset <= maxOffset; offset++) {
        if (offset <= maxPos && patchMatch(input, side.pattern, firstGuess, offset, prefixFuzz, suffixFuzz)) return firstGuess + offset;
        if (offset > 0 && offset <= maxNeg && patchMatch(input, side.pattern, firstGuess, -offset, prefixFuzz, suffixFuzz)) return firstGuess - offset;
      }
      return 0;
    }
    function maxFuzzFor(side) { return Math.min(fuzzMax, Math.max(side.prefix, side.suffix)); }
    function rejectText(file, hunks) {
      // Reuse the patch's own header lines (with timestamps) when present.
      var oldHeader = file.header.filter(function (l) { return /^--- /.test(l); })[0];
      var newHeader = file.header.filter(function (l) { return /^\+\+\+ /.test(l); })[0];
      var text = file.format === 'unified' && oldHeader && newHeader
        ? oldHeader.replace(/\r?\n?$/, '\n') + newHeader.replace(/\r?\n?$/, '\n')
        : '--- ' + (file.oldName || file.target) + '\n+++ ' + (file.newName || file.target) + '\n';
      hunks.forEach(function (h) {
        var oc = h.oldCount, nc = h.newCount;
        text += '@@ -' + h.oldStart + (oc === 1 ? '' : ',' + oc) + ' +' + h.newStart + (nc === 1 ? '' : ',' + nc) + ' @@\n';
        h.lines.forEach(function (l) { text += l.type + l.text + '\n' + (l.eol ? '' : '\\ No newline at end of file\n'); });
      });
      return text;
    }
    for (var f = 0; f < files.length; f++) {
      var file = files[f], name = await chooseTarget(file);
      if (!name) {
        say("can't find file to patch at input line " + file.startLine + '\nPerhaps you should have used the -p or --strip option?\nThe text leading up to this was:\n--------------------------\n' + file.header.map(function (h) { return '|' + h.replace(/\n$/, '') + '\n'; }).join('') + '--------------------------\nNo file to patch.  Skipping patch.\n' + file.hunks.length + ' out of ' + file.hunks.length + ' hunk' + (file.hunks.length === 1 ? '' : 's') + ' ignored\n');
        status = Math.max(status, 1);
        continue;
      }
      file.target = name;
      var path = resolve(name), st = await ctx.vfs.stat(path), originalText = st && st.type === 'file' ? await ctx.vfs.readFile(path) : '';
      if (st && st.type === 'dir') { ctx.error('**** ' + name + ' is not a regular file -- can\'t patch'); status = 2; continue; }
      var deleting = (!reverse && (file.newName === '/dev/null' || file.git.deleted)) || (reverse && file.oldName === '/dev/null');
      say((dryRun ? 'checking file ' : 'patching file ') + (o.get('o') != null && !dryRun ? o.get('o') + ' (read from ' + name + ')' : name) + '\n');
      var input = records(originalText).map(function (r) { return { text: r.replace(/\n$/, ''), eol: /\n$/.test(r) }; });
      var output = [], state = { inOffset: 0, lastFrozen: 0 }, failed = [], ignored = false, mismatch = false;
      for (var h = 0; h < file.hunks.length; h++) {
        var hunk = file.hunks[h], side = hunkSides(hunk, false), where = 0, fuzz;
        for (fuzz = 0; fuzz <= maxFuzzFor(side); fuzz++) {
          where = locateHunk(input, side, fuzz, state);
          if (!where && fuzz === 0 && h === 0 && !o.has('f')) {
            // A patch that applies in reverse was probably applied already.
            var flipped = hunkSides(hunk, true);
            if (locateHunk(input, flipped, 0, state)) {
              if (o.has('t')) { say('Reversed (or previously applied) patch detected!  Assuming -R.\n'); reverse = !reverse; side = flipped; where = locateHunk(input, side, 0, state); }
              else {
                say(o.has('N') ? 'Reversed (or previously applied) patch detected!  Skipping patch.\n' : 'Reversed (or previously applied) patch detected!  Assume -R? [n] \nApply anyway? [n] \nSkipping patch.\n');
                ignored = true;
                break;
              }
            }
          }
          if (where) break;
        }
        if (ignored) break;
        if (!where) { failed.push(hunk); say('Hunk #' + (h + 1) + ' FAILED at ' + (side.first + state.inOffset) + '.\n'); continue; }
        state.inOffset = where - side.first;
        // Copy untouched input, then the hunk: context comes from the input
        // (it may differ under fuzz), additions from the patch.
        while (state.lastFrozen < where - 1) output.push(input[state.lastFrozen++]);
        var newLine = output.length + 1, iline = where;
        side.lines.forEach(function (l) {
          if (l.type === ' ') { var kept = input[iline - 1]; output.push({ text: kept ? kept.text : l.text, eol: l.eol }); iline++; }
          else if (l.type === '-') iline++;
          else output.push({ text: l.text, eol: l.eol });
        });
        state.lastFrozen = where - 1 + side.pattern.length;
        if (fuzz || state.inOffset) mismatch = true;
        if (fuzz || state.inOffset) say('Hunk #' + (h + 1) + ' succeeded at ' + newLine + (fuzz ? ' with fuzz ' + fuzz : '') + (state.inOffset ? ' (offset ' + state.inOffset + ' line' + (Math.abs(state.inOffset) === 1 ? '' : 's') + ')' : '') + '.\n');
      }
      while (state.lastFrozen < input.length) output.push(input[state.lastFrozen++]);
      if (ignored) {
        var total = file.hunks.length;
        say(total + ' out of ' + total + ' hunk' + (total === 1 ? '' : 's') + ' ignored' + (dryRun ? '' : ' -- saving rejects to file ' + name + '.rej') + '\n');
        if (!dryRun) await ctx.vfs.writeFile(resolve(name + '.rej'), rejectText(file, file.hunks));
        status = Math.max(status, 1);
        continue;
      }
      var result = output.map(function (l) { return l.text + (l.eol ? '\n' : ''); }).join('');
      if (failed.length) {
        var rejName = o.get('r') != null ? o.get('r') : name + '.rej';
        say(failed.length + ' out of ' + file.hunks.length + ' hunk' + (file.hunks.length === 1 ? '' : 's') + ' FAILED' + (dryRun ? '' : ' -- saving rejects to file ' + rejName) + '\n');
        if (!dryRun && rejName !== '-') await ctx.vfs.writeFile(resolve(rejName), rejectText(file, failed));
        status = Math.max(status, 1);
      }
      if (dryRun) continue;
      // GNU keeps a backup when any hunk needed fuzz or an offset, or failed.
      if ((o.has('b') || ((mismatch || failed.length) && !o.has('nobk') && !o.has('posix'))) && st) await ctx.vfs.writeFile(resolve(name + (o.get('z') || '.orig')), originalText);
      var outName = o.get('o');
      if (outName != null) {
        if (outName === '-') ctx.stdout.write(result);
        else await ctx.vfs.writeFile(ctx.resolve(outName), result);
        continue;
      }
      if ((deleting || o.has('E')) && result === '') { if (st) await ctx.vfs.remove(path, {}); continue; }
      if (!st) await ctx.vfs.mkdir(dirname(path), { parents: true });
      await ctx.vfs.writeFile(path, result);
    }
    ctx.stdout.write(out);
    return status;
  });

  function memfs(initialTree) {
    var nodes = new Map();
    nodes.set('/', { type: 'dir', entries: [] });
    function add(path, value) {
      path = normalizePath(path);
      if (path === '/') { nodes.set('/', normalizeNode(value) || { type: 'dir', entries: [] }); return; }
      var parent = dirname(path);
      if (!nodes.has(parent)) add(parent, { type: 'dir', entries: [] });
      var node = normalizeNode(value) || { type: 'file', content: '' };
      nodes.set(path, node);
      var dir = nodes.get(parent);
      if (dir && dir.type === 'dir') {
        var entry = dir.entries.find(function (e) { return (typeof e === 'string' ? e : e.name) === basename(path); });
        if (entry) {
          if (typeof entry === 'string') {
            var index = dir.entries.indexOf(entry);
            dir.entries[index] = { name: basename(path), type: node.type };
          } else entry.type = node.type;
        } else dir.entries.push({ name: basename(path), type: node.type });
      }
      if (node.type === 'dir') node.entries.slice().forEach(function (entry) {
        var name = typeof entry === 'string' ? entry : entry.name;
        var child = typeof entry === 'string' ? { type: 'file', content: '' } : entry.type === 'dir' ? { type: 'dir', entries: [] } : { type: 'file', content: '' };
        add(resolvePath(path, name), child);
      });
    }
    if (initialTree && typeof initialTree === 'object') {
      Object.keys(initialTree).forEach(function (path) { add(path, initialTree[path]); });
    }
    function ensureParents(path) {
      var p = dirname(path);
      if (!nodes.has(p)) throw new ShellError(p + ': No such file or directory', 'ENOENT');
      if (nodes.get(p).type !== 'dir') throw new ShellError(p + ': Not a directory', 'ENOTDIR');
    }
    return {
      read: function (path) {
        var node = nodes.get(normalizePath(path));
        if (!node) return null;
        return node.type === 'dir' ? { type: 'dir', entries: node.entries.slice() } : { type: 'file', content: node.content, size: byteLength(node.content), mtime: node.mtime, mode: node.mode };
      },
      write: function (path, content, opts) {
        path = normalizePath(path); opts = opts || {};
        if (opts.type === 'dir') {
          if (nodes.has(path)) throw new ShellError(path + ': File exists', 'EEXIST');
          ensureParents(path); add(path, { type: 'dir', entries: [] }); return;
        }
        ensureParents(path);
        var prior = nodes.get(path);
        if (prior && prior.type === 'dir') throw new ShellError(path + ': Is a directory', 'EISDIR');
        var value = String(content == null ? '' : content);
        if (opts.append && prior && prior.type === 'file') value = prior.content + value;
        add(path, { type: 'file', content: value });
      },
      delete: function (path, opts) {
        path = normalizePath(path); opts = opts || {};
        if (path === '/') throw new ShellError(path + ': Device or resource busy', 'EBUSY');
        var node = nodes.get(path);
        if (!node) throw new ShellError(path + ': No such file or directory', 'ENOENT');
        if (node.type === 'dir' && node.entries.length && !opts.recursive) throw new ShellError(path + ': Directory not empty', 'ENOTEMPTY');
        if (node.type === 'dir' && opts.recursive) {
          Array.from(nodes.keys()).forEach(function (key) { if (key === path || key.indexOf(path === '/' ? '/' : path + '/') === 0) nodes.delete(key); });
        } else nodes.delete(path);
        var parent = nodes.get(dirname(path));
        if (parent && parent.type === 'dir') parent.entries = parent.entries.filter(function (e) { return (typeof e === 'string' ? e : e.name) !== basename(path); });
      },
      move: function (src, dst) {
        src = normalizePath(src); dst = normalizePath(dst);
        var node = nodes.get(src);
        if (!node) throw new ShellError(src + ': No such file or directory', 'ENOENT');
        if (src === '/') throw new ShellError(src + ': Device or resource busy', 'EBUSY');
        if (dst === src) return;
        if (node.type === 'dir' && dst.indexOf(src === '/' ? '/' : src + '/') === 0) throw new ShellError(dst + ': Invalid argument', 'EINVAL');
        ensureParents(dst);
        var existing = nodes.get(dst);
        if (existing && existing.type === 'dir' && node.type !== 'dir') throw new ShellError(dst + ': Is a directory', 'EISDIR');
        if (existing && existing.type !== 'dir' && node.type === 'dir') throw new ShellError(dst + ': Not a directory', 'ENOTDIR');
        if (existing && existing.type === 'dir' && existing.entries.length) throw new ShellError(dst + ': Directory not empty', 'ENOTEMPTY');
        if (existing) {
          if (existing.type === 'dir') Array.from(nodes.keys()).forEach(function (key) {
            if (key === dst || key.indexOf(dst + '/') === 0) nodes.delete(key);
          });
          else nodes.delete(dst);
        }
        var moving = Array.from(nodes.entries()).filter(function (pair) { return pair[0] === src || pair[0].indexOf(src === '/' ? '/' : src + '/') === 0; });
        moving.forEach(function (pair) { nodes.delete(pair[0]); });
        var sourceParent = nodes.get(dirname(src));
        if (sourceParent && sourceParent.type === 'dir') sourceParent.entries = sourceParent.entries.filter(function (e) { return (typeof e === 'string' ? e : e.name) !== basename(src); });
        moving.forEach(function (pair) { add(dst + pair[0].slice(src.length), pair[1]); });
      },
      stat: function (path) {
        var n = nodes.get(normalizePath(path));
        return n ? { type: n.type, size: n.type === 'file' ? byteLength(n.content) : 0, mtime: n.mtime, mode: n.mode } : null;
      },
      exists: function (path) { return nodes.has(normalizePath(path)); },
      snapshot: function () {
        var result = {};
        nodes.forEach(function (n, path) { result[path] = n.type === 'dir' ? { type: 'dir', entries: n.entries.map(function (e) { return typeof e === 'string' ? e : Object.assign({}, e); }) } : n.content; });
        return result;
      }
    };
  }

  async function exec(command, cwd, callbacks, options) {
    var session = createSession(Object.assign({}, callbacks || {}, options || {}, { cwd: cwd || '/' }));
    return session.exec(command, options);
  }

  var commandsMap = new Map();
  return {
    version: VERSION,
    exec: exec,
    create: createSession,
    parse: parse,
    registerCommand: function (name, fn) {
      if (!/^[A-Za-z0-9_./-]+$/.test(String(name)) || typeof fn !== 'function') throw new TypeError('registerCommand(name, fn) requires a command name and function');
      commandsMap.set(basename(name), fn);
    },
    // Removes a registered command (bundled utilities and builtins remain).
    unregisterCommand: function (name) { return commandsMap.delete(basename(String(name))); },
    // Every command name the shell can run: builtins, bundled utilities and
    // user-registered commands.
    commands: function () {
      var names = new Set(Array.from(BUILTINS.keys()).concat(Array.from(COMMANDS.keys()), Array.from(commandsMap.keys())));
      return Array.from(names).sort();
    },
    memfs: memfs,
    _internals: {
      normalizePath: normalizePath,
      resolvePath: resolvePath,
      dirname: dirname,
      basename: basename,
      byteLength: byteLength,
      InputStream: InputStream,
      BufferSink: BufferSink,
      HostSink: HostSink,
      FdTable: FdTable,
      createVfs: createVfs,
      ShellError: ShellError
      ,lex: lex
    }
  };
}));
