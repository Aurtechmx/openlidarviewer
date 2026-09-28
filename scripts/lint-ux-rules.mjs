#!/usr/bin/env node
/**
 * lint-ux-rules.mjs: the house rules in docs/ux/PRINCIPLES.md that source
 * text can decide.
 *
 * Checked:
 *   UX-D4 No nested accordions. A `<details>` built inside another
 *   `<details>`, written as nested `el('details', ...)` calls or as nested
 *   `<details>` tags in one markup string, fails. Scope: `src/`.
 *
 * Not checked here, and why:
 *   - A `<details>` appended into another one at run time, through a helper
 *     or a later `append()`, is invisible to a source scan. The accessibility
 *     audit (`tests/e2e/ceA11y.spec.ts`) counts `details details` in the live
 *     page on each surface it visits instead.
 *   - UX-D9 (validity never only in a tooltip) needs to know the visible text
 *     beside each tooltip, which depends on run-time state and CSS. A word
 *     list over tooltip strings flagged tooltips that repeat a visible caveat
 *     as often as ones that replace it, so it would fail on correct code. It
 *     stays a review checklist item until a run-time check can see both.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function tsFiles(dir = resolve(ROOT, 'src')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out.sort();
}

/** Source with comments blanked (same length, so offsets and lines hold). */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** Index of the paren closing the call whose `(` is at `open`. */
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Nested disclosures in one file: `{ line }` for each inner `<details>`. */
export function findNestedDetails(src) {
  const code = stripComments(src);
  const lineOf = (i) => code.slice(0, i).split('\n').length;
  const found = [];
  const call = /\bel\(\s*(['"`])details\1/g;
  const starts = [];
  for (let m; (m = call.exec(code));) starts.push(m.index);
  for (const s of starts) {
    const end = closeParen(code, code.indexOf('(', s));
    if (end < 0) continue;
    for (const inner of starts) if (inner > s && inner < end) found.push({ line: lineOf(inner) });
  }
  // Markup strings: a second <details> opened before the first closes.
  const tag = /<(\/?)details\b/gi;
  let depth = 0;
  for (let m; (m = tag.exec(code));) {
    if (m[1]) depth = Math.max(0, depth - 1);
    else { if (depth > 0) found.push({ line: lineOf(m.index) }); depth += 1; }
  }
  return found;
}

if (isCliEntry(import.meta.url)) {
  const failures = [];
  let scanned = 0;
  for (const f of tsFiles()) {
    scanned += 1;
    for (const n of findNestedDetails(readFileSync(resolve(ROOT, f), 'utf8'))) failures.push(`${f}:${n.line}`);
  }
  if (failures.length) {
    console.error('lint:ux-rules FAILED\n');
    for (const f of failures) console.error(`  • ${f}: a <details> inside another <details> (UX-D4, no nested accordions). Move the inner detail to a helper line, or to Help.`);
    process.exit(1);
  }
  console.log(`lint:ux-rules OK: UX-D4 holds in ${scanned} source files (no <details> written inside another).`);
}
