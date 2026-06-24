#!/usr/bin/env node
/**
 * lint-unsafe-html.mjs
 *
 * Defence-in-depth guard for the one HTML-injection sink in the app: the
 * `unsafeHtml` prop on `el()` (which assigns `node.innerHTML`) and any direct
 * `.innerHTML =` assignment. Today every such sink is fed a STATIC icon/SVG
 * constant — no user-derived string (filename, CRS WKT, annotation text, a
 * remote URL) reaches it, so there is no XSS path. This linter keeps it that
 * way: it fails the build if a known user-data identifier appears in the value
 * passed to one of those sinks, so a future contributor can't quietly wire a
 * filename or WKT string into innerHTML.
 *
 * It is a heuristic backstop (a denylist of this app's user-data sources), not
 * a proof — code review remains the primary control. But it converts the most
 * likely accidental regression into a hard CI failure.
 *
 * Usage: `node scripts/lint-unsafe-html.mjs`  (also `npm run lint:unsafe-html`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

// Identifiers that denote user- or file-derived strings in this codebase. If
// any appears in a value flowing into `unsafeHtml`/`innerHTML`, that's a
// potential injection of attacker-controlled content and is rejected.
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

// The sink patterns. Group 1 is the value expression (rest of the line).
const SINKS = [
  /\bunsafeHtml\s*:\s*(.+)$/, // el({ unsafeHtml: <value> })
  /\.innerHTML\s*=\s*(.+)$/, // node.innerHTML = <value>
];

// The single sanctioned chokepoint: the `el()` helper definition itself, which
// is exactly `node.innerHTML = props.unsafeHtml` — the value is the typed prop,
// already guarded by every call site this linter checks.
const CHOKEPOINT = /node\.innerHTML\s*=\s*props\.unsafeHtml/;

/** Find offending sink usages in one file's source. Pure — exported for tests. */
export function scanSource(text, file = '<source>') {
  const offenders = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (CHOKEPOINT.test(raw)) continue;
    // Strip a trailing line comment so a comment mentioning `wkt` etc. near a
    // sink doesn't cause a false positive.
    const code = raw.replace(/\/\/.*$/, '');
    for (const sink of SINKS) {
      const m = sink.exec(code);
      if (!m) continue;
      const value = m[1];
      const hit = USER_DATA.find((re) => re.test(value));
      if (hit) offenders.push({ file, line: i + 1, text: trimmed, token: hit.source });
    }
  }
  return offenders;
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
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const offenders = [];
  for (const file of walk(SRC)) {
    offenders.push(...scanSource(readFileSync(file, 'utf8'), relative(resolve(HERE, '..'), file)));
  }
  if (offenders.length === 0) {
    console.log('lint:unsafe-html OK — no user-derived string reaches unsafeHtml/innerHTML');
    process.exit(0);
  }
  console.error('lint:unsafe-html FAILED');
  console.error('');
  console.error('A user/file-derived identifier was found flowing into an innerHTML sink.');
  console.error('innerHTML executes markup, so an attacker-controlled string (a crafted');
  console.error('filename, CRS WKT, or annotation) becomes an XSS vector. Render it as');
  console.error('text instead — `el(tag, { text })` sets textContent, which is safe.');
  console.error('');
  console.error('Offenders:');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line} (matched /${o.token}/): ${o.text}`);
  }
  console.error('');
  process.exit(1);
}
