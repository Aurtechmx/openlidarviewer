#!/usr/bin/env node
/**
 * lint-tooltip-length.mjs: tooltips stay short (160 characters).
 *
 * A tooltip is nonessential clarification (PRINCIPLES.md, surface roles): the
 * user must be able to succeed without reading it. A tooltip that runs past a
 * couple of lines is carrying content that belongs in a label, a helper line
 * or Help, and a hover bubble that long is hard to read before it moves.
 *
 * What counts as a tooltip, in `src/**\/*.ts`:
 *   - the `title` or `tip` property of an `el(tag, { ... })` call,
 *   - `setAttribute('title', ...)` and `.title = ...`.
 * Only literal text is measured: a run of string literals joined by `+`, with
 * any `${...}` in a template left out. A tooltip built from a variable is not
 * measured here.
 *
 * Shrink-only per file: the tooltips already over the limit are banked in
 * `docs/validation/tooltip-length-baseline.json`, a file may only lose them,
 * and a file with none banked may add none. `--update` banks a drop and
 * refuses a raise.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/tooltip-length-baseline.json');
export const LIMIT = 160;

function tsFiles(dir = resolve(ROOT, 'src')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out.sort();
}

/** Index just past the string literal that opens at `i`, or -1. */
function skipString(src, i) {
  const q = src[i];
  if (q !== '\'' && q !== '"' && q !== '`') return -1;
  let j = i + 1;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (q === '`' && c === '$' && src[j + 1] === '{') { depth += 1; j += 2; continue; }
    if (q === '`' && depth > 0 && c === '}') { depth -= 1; j += 1; continue; }
    if (depth === 0 && c === q) return j + 1;
    j += 1;
  }
  return -1;
}

/** The literal text of a string token, with template substitutions removed. */
function literalText(token) {
  const body = token.slice(1, -1);
  const text = token[0] === '`' ? body.replace(/\$\{[\s\S]*?\}/g, '') : body;
  return text.replace(/\\(.)/g, '$1');
}

/**
 * The literal text of a `+`-joined run of string literals starting at `i`
 * (after whitespace), or null when the value is not literal text.
 */
export function readLiteralRun(src, i) {
  let j = i;
  let text = '';
  let any = false;
  for (;;) {
    while (/\s/.test(src[j] ?? '')) j += 1;
    const end = skipString(src, j);
    if (end < 0) return any ? text : null;
    text += literalText(src.slice(j, end));
    any = true;
    j = end;
    let k = j;
    while (/\s/.test(src[k] ?? '')) k += 1;
    if (src[k] !== '+') return text;
    j = k + 1;
  }
}

/** Index of the brace that closes the one opening at `i`, skipping strings and comments. */
function matchBrace(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) return -1; continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; if (j <= 0) return -1; continue; }
    const s = skipString(src, j);
    if (s > 0) { j = s - 1; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

/** Every measurable tooltip in one source file: `{ line, length, text }`. */
export function findTooltips(src) {
  const found = [];
  const add = (at, text) => {
    if (text === null) return;
    found.push({ line: src.slice(0, at).split('\n').length, length: text.length, text });
  };
  // `el('tag', { ... })`: the props object's own title / tip keys.
  const call = /\bel\(\s*(['"`])[\w-]+\1\s*,\s*\{/g;
  for (let m; (m = call.exec(src));) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const props = src.slice(open, close);
    // Keys at the object's own depth only.
    let depth = 0;
    for (let j = 0; j < props.length; j++) {
      if (props[j] === '/' && props[j + 1] === '/') { j = props.indexOf('\n', j); if (j < 0) break; continue; }
      if (props[j] === '/' && props[j + 1] === '*') { j = props.indexOf('*/', j) + 1; if (j <= 0) break; continue; }
      const s = skipString(props, j);
      if (s > 0) { j = s - 1; continue; }
      const c = props[j];
      if (c === '{' || c === '[' || c === '(') depth += 1;
      else if (c === '}' || c === ']' || c === ')') depth -= 1;
      else if (depth === 1) {
        const key = /^(title|tip)\s*:/.exec(props.slice(j));
        if (key && /[\s,{]/.test(props[j - 1] ?? '')) add(open + j, readLiteralRun(props, j + key[0].length));
      }
    }
  }
  const attr = /setAttribute\(\s*['"]title['"]\s*,/g;
  for (let m; (m = attr.exec(src));) add(m.index, readLiteralRun(src, m.index + m[0].length));
  const assign = /\.title\s*=(?!=)/g;
  for (let m; (m = assign.exec(src));) add(m.index, readLiteralRun(src, m.index + m[0].length));
  return found;
}

/** Tooltips over the limit, per file. */
export function measure() {
  const files = {};
  for (const f of tsFiles()) {
    const over = findTooltips(readFileSync(resolve(ROOT, f), 'utf8')).filter((t) => t.length > LIMIT);
    if (over.length) files[f] = over;
  }
  return files;
}

if (isCliEntry(import.meta.url)) {
  const current = measure();
  const counts = Object.fromEntries(Object.entries(current).map(([f, list]) => [f, list.length]));
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const update = process.argv.includes('--update');
  if (baseline === null && !update) {
    console.error(`lint:tooltip-length FAILED\n\n  ${relative(ROOT, BASELINE)} is missing. Restore it from git.`);
    process.exit(1);
  }
  const grown = baseline
    ? Object.entries(counts).filter(([f, n]) => n > (baseline.files?.[f] ?? 0))
    : [];
  const report = () => {
    for (const [f] of grown) {
      for (const t of current[f]) console.error(`  • ${f}:${t.line}: ${t.length} characters (limit ${LIMIT}). Shorten it, or move the detail to a helper line or Help.`);
    }
  };
  if (update) {
    if (grown.length) {
      console.error('lint:tooltip-length --update REFUSED\n');
      report();
      process.exit(1);
    }
    const total = Object.values(counts).reduce((a, n) => a + n, 0);
    writeFileSync(BASELINE, `${JSON.stringify({
      $comment: `Shrink-only. Tooltips longer than ${LIMIT} characters, per source file; see scripts/lint-tooltip-length.mjs. Bank a drop with \`node scripts/lint-tooltip-length.mjs --update\`.`,
      limit: LIMIT,
      total,
      files: counts,
    }, null, 2)}\n`);
    console.log(`tooltip-length baseline written: ${total} tooltips over ${LIMIT} characters.`);
    process.exit(0);
  }
  if (grown.length) {
    console.error('lint:tooltip-length FAILED\n');
    report();
    process.exit(1);
  }
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  const drop = baseline.total - total;
  console.log(`lint:tooltip-length OK: ${total} tooltips over ${LIMIT} characters, none new`
    + (drop > 0 ? ` (${drop} fewer than banked; run --update to bank it)` : '') + '.');
}
