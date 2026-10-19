#!/usr/bin/env node
/**
 * lint-unsafe-html.mjs
 *
 * Defence-in-depth guard for the places the app turns a string into markup:
 *
 *   - the `unsafeHtml` prop on `el()` (which assigns `node.innerHTML`) and any
 *     direct `.innerHTML =` assignment,
 *   - `.outerHTML =`, `.insertAdjacentHTML(...)`, `.createContextualFragment(...)`,
 *     `new DOMParser()` / `.parseFromString(...)`, and `document.write(...)`.
 *
 * Two rules, both over the whole expression flowing into the sink (a template
 * literal or concatenation may span lines):
 *
 *   1. No known user-data identifier (a filename, CRS WKT, annotation text, a
 *      remote URL) may appear in it.
 *   2. The sinks other than `unsafeHtml` and `.innerHTML =` must be on
 *      ALLOWED_SINKS below, each with the reason its value is static. A new one
 *      fails until someone reviews it and adds an entry. (`unsafeHtml` and
 *      `.innerHTML =` call sites are held to a one-to-one allow-list by
 *      tests/unsafeHtmlGuard.test.ts.)
 *
 * Comments are masked before scanning, so a sink mentioned in a comment is not
 * a sink and a `//` inside a string does not hide the rest of the line.
 *
 * It is a heuristic backstop (a denylist of this app's user-data sources), not
 * a proof — code review remains the primary control. But it converts the most
 * likely accidental regression into a hard CI failure.
 *
 * Usage: `node scripts/lint-unsafe-html.mjs`  (also `npm run lint:unsafe-html`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

// Identifiers that denote user- or file-derived strings in this codebase. If
// any appears in a value flowing into a sink, that's a potential injection of
// attacker-controlled content and is rejected.
const USER_DATA = [
  /\bwkt\b/i,
  /\bfile_?name\b/i,
  /lastCloudName/i,
  /\bcloudName\b/i,
  /cloud\.name\b/,
  /\bannotation/i,
  /userText/i,
  /userInput/i,
  /\.caption\b/i,
  /\.crs\b/,
  /metadata\.crs/i,
];

/**
 * The sink shapes. `name` is the sink kind; `re` finds the sink token and its
 * match end is where the value expression starts; `value` says how far the
 * expression runs: `'property'` to the end of the property or statement,
 * `'args'` to the call's closing parenthesis.
 */
const SINKS = [
  { name: 'unsafeHtml', re: /\bunsafeHtml\s*:/g, value: 'property', listed: false },
  { name: 'innerHTML', re: /\.innerHTML\s*\+?=(?!=)/g, value: 'property', listed: false },
  { name: 'outerHTML', re: /\.outerHTML\s*\+?=(?!=)/g, value: 'property', listed: true },
  { name: 'insertAdjacentHTML', re: /\.insertAdjacentHTML\s*\(/g, value: 'args', listed: true },
  { name: 'createContextualFragment', re: /\.createContextualFragment\s*\(/g, value: 'args', listed: true },
  { name: 'DOMParser', re: /\bnew\s+DOMParser\s*\(/g, value: 'args', listed: true },
  { name: 'parseFromString', re: /\.parseFromString\s*\(/g, value: 'args', listed: true },
  { name: 'document.write', re: /\bdocument\s*\.\s*write(?:ln)?\s*\(/g, value: 'args', listed: true },
];

/**
 * The reviewed call sites of the sinks that need an entry. `match` is tested
 * against the sink's source text so an entry follows its code when lines move;
 * `where` gives the place and `why` the reason the value is static.
 */
export const ALLOWED_SINKS = [
  {
    file: 'src/ui/MeasurePanel.ts',
    sink: 'insertAdjacentHTML',
    match: /^\.insertAdjacentHTML\('beforeend', html\b/,
    where: 'src/ui/MeasurePanel.ts:~2413, the profile chart x-axis refit (`_olvRefitXLabels`)',
    why: '`html` is the result of profileXLabelSpansHtml on the line above it: fixed span templates, a numeric percentage, a CSS anchor keyword and chainage labels formatted from numbers; no file, scan or user string reaches it.',
  },
];

// The single sanctioned chokepoint: the `el()` helper definition itself, which
// is exactly `node.innerHTML = props.unsafeHtml` — the value is the typed prop,
// already guarded by every call site this linter checks.
const CHOKEPOINT = /^\s*props\.unsafeHtml\s*$/;

/**
 * `text` with every comment replaced by spaces (newlines kept, so offsets and
 * line numbers are unchanged). Strings, template literals (with nested
 * `${...}`) and regular-expression literals are read as units, so a `//` or a
 * quote inside one is not mistaken for a comment or a string boundary.
 */
export function maskComments(text) {
  const out = text.split('');
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Stack of what we are inside: 'code' at the bottom, 'tpl' for a template literal, 'sub' for a ${ } hole.
  const stack = ['code'];
  let i = 0;
  let prevSignificant = '';
  while (i < n) {
    const mode = stack[stack.length - 1];
    const c = text[i];
    if (mode === 'tpl') {
      if (c === '\\') i += 2;
      else if (c === '`') { stack.pop(); prevSignificant = '`'; i++; }
      else if (c === '$' && text[i + 1] === '{') { stack.push('sub'); i += 2; prevSignificant = '{'; }
      else i++;
      continue;
    }
    // code or sub
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
      prevSignificant = c;
    } else if (c === '`') {
      stack.push('tpl');
      i++;
    } else if (c === '/' && /^[(,=:[!&|?{};+\-*%<>~^]?$/.test(prevSignificant)) {
      // A regular-expression literal: read to the closing slash, skipping classes and escapes.
      i++;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '[') { inClass = true; i++; }
        else if (text[i] === ']') { inClass = false; i++; }
        else if (text[i] === '/' && !inClass) break;
        else i++;
      }
      i++;
      prevSignificant = '/';
    } else if (mode === 'sub' && c === '}') {
      stack.pop();
      i++;
    } else {
      if (!/\s/.test(c)) prevSignificant = c;
      i++;
    }
  }
  return out.join('');
}

/** The index just past the expression that starts at `from` in masked source. */
function expressionEnd(masked, from, kind) {
  const OPEN = '([{';
  const CLOSE = ')]}';
  let depth = 0;
  let i = from;
  const n = masked.length;
  while (i < n && i - from < 4000) {
    const c = masked[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < n && masked[i] !== c && masked[i] !== '\n') i += masked[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '`') {
      i = templateEnd(masked, i + 1);
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ';' || (kind === 'property' && c === ','))) return i;
    i++;
  }
  return Math.min(i, n);
}

/** The index just past a template literal whose body starts at `from`. */
function templateEnd(masked, from) {
  let i = from;
  const n = masked.length;
  while (i < n) {
    const c = masked[i];
    if (c === '\\') i += 2;
    else if (c === '`') return i + 1;
    else if (c === '$' && masked[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (masked[i] === '`') i = templateEnd(masked, i + 1);
        else {
          if (masked[i] === '{') depth++;
          else if (masked[i] === '}') depth--;
          i++;
        }
      }
    } else i++;
  }
  return n;
}

/** Offsets of each line start, for turning an index into a line number. */
function lineOf(text, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/**
 * Find offending sink usages in one file's source. Pure — exported for tests.
 * Each offender is `{ file, line, text, token }`: a user-data identifier in the
 * value (`token` is the pattern), or a sink with no ALLOWED_SINKS entry
 * (`token` is `unlisted <sink>`).
 */
export function scanSource(text, file = '<source>', allowed = ALLOWED_SINKS) {
  const offenders = [];
  const masked = maskComments(text);
  for (const sink of SINKS) {
    sink.re.lastIndex = 0;
    for (const m of masked.matchAll(sink.re)) {
      const start = m.index + m[0].length;
      const end = expressionEnd(masked, start, sink.value);
      const value = masked.slice(start, end);
      if (CHOKEPOINT.test(value)) continue;
      const snippet = text.slice(m.index, end).replace(/\s+/g, ' ').trim();
      const line = lineOf(text, m.index);
      const hit = USER_DATA.find((re) => re.test(value));
      if (hit) {
        offenders.push({ file, line, text: snippet, token: hit.source });
        continue;
      }
      if (sink.listed && !allowed.some((a) => a.file === file && a.sink === sink.name && a.match.test(snippet))) {
        offenders.push({ file, line, text: snippet, token: `unlisted ${sink.name}` });
      }
    }
  }
  return offenders.sort((a, b) => a.line - b.line);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// CLI entry — only when run directly, not when imported by the test.
if (isCliEntry(import.meta.url)) {
  const offenders = [];
  for (const file of walk(SRC)) {
    offenders.push(...scanSource(readFileSync(file, 'utf8'), relative(resolve(HERE, '..'), file).split(sep).join('/')));
  }
  if (offenders.length === 0) {
    console.log('lint:unsafe-html OK — no user-derived string reaches a markup sink, and every other sink is on the reviewed list');
    process.exit(0);
  }
  console.error('lint:unsafe-html FAILED');
  console.error('');
  console.error('A string-to-markup sink received a user/file-derived identifier, or is not on');
  console.error('ALLOWED_SINKS in scripts/lint-unsafe-html.mjs. Markup is executed, so an');
  console.error('attacker-controlled string (a crafted filename, CRS WKT, or annotation)');
  console.error('becomes an XSS vector. Render it as text instead — `el(tag, { text })`');
  console.error('sets textContent, which is safe. A sink whose value is genuinely static');
  console.error('belongs on ALLOWED_SINKS with the reason, after review.');
  console.error('');
  console.error('Offenders:');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line} (matched /${o.token}/): ${o.text}`);
  }
  console.error('');
  process.exit(1);
}
