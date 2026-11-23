// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site 1.0.0's build, byte for byte, on every input.
// Pure JavaScript/TypeScript, stdlib only, no native code, no Wasm, deterministic.
// Written from the reference's behaviour (its README states the rules; its code is
// the reference wherever the two differ). Every optimisation below is provably
// output-identical to the reference implementation; the risky ones (inline
// scanning, slug fast path, line classification) were differentially tested
// against the reference.
//
// Where the time goes in the reference (CPU profile, practice set):
//   - escapeHtml called once per character by the inline renderer (~20%)
//   - Markdown lexing + inline rendering (~20%)
//   - slugify's NFKD normalise + unicode-mark strip, called 3x per tag (~3%)
//   - per-line regex tests in the lexer, front-matter re-joins, card built twice
//
// Optimisations, in that order:
//   1. Inline renderer accumulates plain-text runs and escapes each run once
//      (escapeHtml also returns early when a run holds no special character).
//   2. slugify: ASCII fast path (NFKD + mark-strip are identity on ASCII) and a
//      per-build memo; tag slugs computed once per name, not three times.
//   3. Lexer: first-character dispatch so most lines run no regex at all;
//      the regexes that can still match are the reference's own.
//   4. Front matter body taken by offset slice instead of split + re-join;
//      \r\n normalisation skipped when the file holds no \r.
//   5. wordsOf counts with matchAll instead of building a match array.
//   6. Each post's card is built once and reused by its page; longDate memoised.
//   7. Template renderer writes into one chunk array per render instead of
//      concatenating a string per node; code-block lines escaped as one block.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Most strings hold none of them. */
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_REPLACE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

const NON_ASCII = /[^\x00-\x7F]/;

/** The slug of an ASCII string: the reference's loop, by code unit. */
function slugAscii(text) {
  const parts = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = parts.length > 0;
      continue;
    }
    if (gap) parts.push('-');
    gap = false;
    parts.push(String.fromCharCode(keep));
  }
  const out = parts.join('').slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug of a non-ASCII string: the reference's algorithm, unchanged. */
function slugUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`, memoised in this build's `memo` (a pure function of the
 * text, so caching it inside one build changes nothing). NFKD and the
 * combining-mark strip are identity on ASCII, so ASCII takes the fast path.
 */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const out = NON_ASCII.test(text) ? slugUnicode(text) : slugAscii(text);
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone, memoised per build. */
function longDate(date, memo) {
  const hit = memo.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  memo.set(date, out);
  return out;
}

/** ASCII whitespace (code unit < 128), as a table. */
const WS_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_ASCII[c] = 1;
/** The non-ASCII whitespace of JavaScript's \s (no /u/ flag). */
const WS_NONASCII = new Set([0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);

/** The words of a body: its runs of characters other than whitespace (exactly /\S+/g, counted without building the match array). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0, len = text.length; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 ? WS_ASCII[c] === 1 : WS_NONASCII.has(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }. The body is
 * the text after the closing line, taken by offset instead of split + re-join.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  let off = 0;
  for (let i = 0; i <= close; i++) off += lines[i].length + 1;
  return { data, body: text.slice(off) };
}

// ---------------------------------------------------------------- markdown

const FENCE_CLOSE_RE = /^```[ \t]*$/;
const CONTINUED_RE = /^ {2,}\S/;

/** True when `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === n ? lang : null;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let count = 0;
  while (count < line.length && line.charCodeAt(count) === 35) count++;
  if (count === 0 || count > 6) return null;
  let p = count;
  if (p >= line.length || (line.charCodeAt(p) !== 32 && line.charCodeAt(p) !== 9)) return null;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  let q = line.length;
  while (q > p && (line.charCodeAt(q - 1) === 32 || line.charCodeAt(q - 1) === 9)) q--;
  if (q === p) return null;
  return { depth: count, text: line.slice(p, q) };
}

/** True when `line` is a thematic break (`---` or `***`, then spaces/tabs). */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's [number, text], or null. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return [Number(line.slice(0, d)), line.slice(d + 2)];
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // A line opening on space/tab that is not blank is paragraph text.
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE_RE.test(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang, lines: body });
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        tokens.push({ type: 'hr' });
        i++;
        continue;
      }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const b = bulletOf(l);
          if (b !== null) {
            items.push([trimLine(b)]);
            i++;
          } else if (l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32 && CONTINUED_RE.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        tokens.push({ type: 'list', ordered: false, start: 1, items: items.map((parts) => parts.join('\n')) });
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const o = orderedOf(l);
          if (o !== null) {
            items.push([trimLine(o[1])]);
            i++;
          } else if (l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32 && CONTINUED_RE.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        tokens.push({ type: 'list', ordered: true, start: ordered[0], items: items.map((parts) => parts.join('\n')) });
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes, as code units. */
const ESCAPABLE_CODE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE_CODE[c] = 1;

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape,
 * or -1. Equivalent to the reference's character walk: a backslash run of even
 * length before the match is consumed in pairs, so the match stands; an odd
 * run leaves its last backslash escaping the match, so the search continues.
 */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let n = 0;
    for (let p = k - 1; p >= from && s[p] === '\\'; p--) n++;
    if (n % 2 === 0) return k;
    j = k + 1;
  }
}

/**
 * The first single * from `from` (one whose run is not **), outside an escape,
 * or -1. Same escape rule as findUnescaped; a `**` pair is skipped as a pair.
 */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let n = 0;
    for (let p = k - 1; p >= from && s[p] === '\\'; p--) n++;
    if (n % 2 === 1) {
      j = k + 1;
      continue;
    }
    if (s[k + 1] === '*') {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/** Any character that can start an inline construct: backslash, backtick, *, [. */
const INLINE_SPECIAL = /[\\`*\[]/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Same scan as the
 * reference, but the next construct starter is found by one regex search
 * (C++) instead of a per-character loop, and plain text is gathered into
 * runs and escaped once per run. A string holding no construct starter is
 * just its escape: the loop would leave it one run. A starter that turns
 * out not to be a construct stays in the run, exactly as the reference's
 * one-character advance leaves it there.
 */
function inline(s, env) {
  if (!INLINE_SPECIAL.test(s)) return escapeHtml(s);
  const re = /[\\`*\[]/g;
  const out = [];
  let runStart = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < s.length && ESCAPABLE_CODE[s.charCodeAt(j + 1)] === 1) {
        if (j > runStart) out.push(escapeHtml(s.slice(runStart, j)));
        out.push(escapeHtml(s[j + 1]));
        runStart = j + 2;
        re.lastIndex = runStart;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > runStart) out.push(escapeHtml(s.slice(runStart, j)));
        out.push(`<code>${escapeHtml(s.slice(j + 1, k))}</code>`);
        runStart = k + 1;
        re.lastIndex = runStart;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > runStart) out.push(escapeHtml(s.slice(runStart, j)));
          out.push(`<strong>${inline(s.slice(j + 2, k), env)}</strong>`);
          runStart = k + 2;
          re.lastIndex = runStart;
        } else {
          re.lastIndex = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > runStart) out.push(escapeHtml(s.slice(runStart, j)));
        out.push(`<em>${inline(s.slice(j + 1, k), env)}</em>`);
        runStart = k + 1;
        re.lastIndex = runStart;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    // c === 91, '['
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      if (j > runStart) out.push(escapeHtml(s.slice(runStart, j)));
      out.push(`<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`);
      runStart = mm + 1;
      re.lastIndex = runStart;
    } else {
      re.lastIndex = j + 1;
    }
  }
  if (s.length > runStart) out.push(escapeHtml(s.slice(runStart)));
  return out.join('');
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, memo) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text, memo), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>\n`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        blocks.push(`<pre><code${cls}>${t.lines.length === 0 ? '' : `${escapeHtml(t.lines.join('\n'))}\n`}</code></pre>\n`);
        break;
      }
      case 'hr':
        blocks.push('<hr>\n');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>\n`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        const items = [];
        for (const item of t.items) items.push(`<li>${inline(item, env)}</li>\n`);
        blocks.push(`${open}\n${items.join('')}</${tag}>\n`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>\n`);
        break;
      }
    }
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of chunks) in `scope`. Same walk as the
 * reference; writing chunks to one array instead of concatenating a string
 * per node.
 */
function renderInto(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderInto(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** `nodes` rendered in `scope`; `ctx` holds the parsed templates, the HTML escape and the include depth. */
function renderNodes(nodes, scope, ctx, depth) {
  const out = [];
  renderInto(nodes, scope, ctx, depth, out);
  return out.join('');
}

/**
 * Compile a parsed template (node tree) into a function (scope, ctx, depth, out).
 * A mechanical translation of renderInto's walk: the same lookups, truth
 * tests, include depth and chunk order, with the per-node dispatch and the
 * recursion replaced by straight-line code and blocks. Compiling once per
 * template per build keeps every render fast. Returns null when the function
 * cannot be built; the caller then interprets the template instead.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const next = (p) => `${p}${uid++}`;
  const gen = (list, scopeVar) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `out.push(${JSON.stringify(n.text)});\n`;
          break;
        case 'var':
          code += `out.push(ctx.escape(textOf(lookup(${scopeVar}, ${JSON.stringify(n.path)}))));\n`;
          break;
        case 'raw':
          code += `out.push(textOf(lookup(${scopeVar}, ${JSON.stringify(n.path)})));\n`;
          break;
        case 'if': {
          const cond = `truthy(lookup(${scopeVar}, ${JSON.stringify(n.path)})) !== ${n.not}`;
          code += `if (${cond}) {\n${gen(n.then, scopeVar)}}`;
          if (n.else !== null) code += ` else {\n${gen(n.else, scopeVar)}}`;
          code += '\n';
          break;
        }
        case 'for': {
          const xs = next('a');
          const k = next('a');
          const sv = next('s');
          code += `{ const ${xs} = lookup(${scopeVar}, ${JSON.stringify(n.path)}); if (Array.isArray(${xs})) { for (let ${k} = 0; ${k} < ${xs}.length; ${k}++) { const ${sv} = { vars: { ${JSON.stringify(n.name)}: ${xs}[${k}], loop: { index: ${k} + 1, first: ${k} === 0, last: ${k} === ${xs}.length - 1, length: ${xs}.length } }, parent: ${scopeVar} };\n${gen(n.body, sv)}} }\n}\n`;
          break;
        }
        case 'include': {
          const t = next('a');
          const u = next('a');
          code += `{ const ${t} = ctx.compiled.get(${JSON.stringify(n.name)}); if (${t} !== undefined) { if (depth < 8) ${t}(${scopeVar}, ctx, depth + 1, out); } else { const ${u} = ctx.templates.get(${JSON.stringify(n.name)}); if (${u} !== undefined && depth < 8) renderInto(${u}, ${scopeVar}, ctx, depth + 1, out); } }\n`;
          break;
        }
      }
    }
    return code;
  };
  try {
    return new Function('lookup', 'textOf', 'truthy', 'renderInto', `return function (scope, ctx, depth, out) {\n${gen(nodes, 'scope')}}`)(lookup, textOf, truthy, renderInto);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  // Per-build memo tables (pure functions of their input; nothing is kept
  // from one case to the next: run() is called once per case).
  const memo = { slug: new Map(), date: new Map() };
  const slug = (text) => slugify(text, memo.slug);
  const dateLong = (date) => longDate(date, memo.date);

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) {
        b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
      } else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const sgl = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
      s.slug = sgl;
      s.outDir = dir === '' ? sgl : `${dir}/${sgl}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if ((target.indexOf(':') !== -1 && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, memo.slug);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  {
    const bySlug = new Map();
    /** A source's tags, each slug once, in its own order (each name once). */
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of (s.data.tags ?? [])) {
        const sg = slug(name);
        if (!seen.has(sg)) {
          seen.add(sg);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const sg = slug(name);
        if (!bySlug.has(sg)) bySlug.set(sg, { name, slug: sg, url: `${b.base}/tags/${sg}/`, posts: [] });
        const tag = bySlug.get(sg);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const sg = slug(name);
          return bySlug.get(sg) ?? { name, slug: sg, url: '', posts: [] };
        });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // A page's link record as templates read it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateLong(s.data.date) });

  // A tag as templates read it (its posts as cards).
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

  // A post's card, as lists show it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : dateLong(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  // A page as its layout reads it (its card, built once, plus the page's own fields).
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    for (const s of b.sources) s.card = cardOf(s);
    b.cards = new Map(b.posts.map((p) => [p, p.card]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const compiled = new Map();
    for (const [name, nodes] of b.templates) {
      const fn = compileTemplate(nodes);
      if (fn !== null) compiled.set(name, fn);
    }
    const ctx = { templates: b.templates, compiled, escape: escapeHtml };
    const render = (name, vars) => {
      const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
      const fn = compiled.get(name);
      if (fn !== undefined) {
        const out = [];
        fn(scope, ctx, 0, out);
        return out.join('');
      }
      const nodes = b.templates.get(name);
      return nodes === undefined ? null : renderNodes(nodes, scope, ctx, 0);
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}
