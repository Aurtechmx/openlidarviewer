#!/usr/bin/env node
/**
 * lint-disposal-registry.mjs
 *
 * docs/disposal-contracts.md names every resource the app owns, who owns it,
 * how long it lives and what disposes it. That document is the registry: this
 * reads it rather than keeping a second copy, so there is no parallel truth to
 * drift.
 *
 * What it refuses:
 *   - a row with no owner, which is the case the registry exists to prevent;
 *   - a row with no disposal trigger, which is the same defect stated later;
 *   - a placeholder standing in for either ("TBD", "?", "none", "unknown");
 *   - a table that has stopped parsing, so the guard cannot pass vacuously.
 *
 * It deliberately does not police the lifetime wording. The document describes
 * lifetimes in prose tied to the owner ("Per Viewer instance", "Per streaming
 * scan"), and rewriting those into a fixed vocabulary would be churn, not a
 * correctness gain.
 *
 * Exit 0 = clean; exit 1 = a row that names no owner for something the app
 * allocates.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/disposal-contracts.md';

const PLACEHOLDER = /^(tbd|todo|\?+|none|n\/a|unknown|-{1,2})$/i;
/** A registry with no rows would pass every check below without reading one. */
const MIN_ROWS = 10;

const text = readFileSync(resolve(ROOT, DOC), 'utf8');
const lines = text.split('\n');

const rows = [];
let section = '(top)';
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const heading = /^#{2,4}\s+(.*)$/.exec(line);
  if (heading) section = heading[1].trim();
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length < 4) continue;
  // Skip the header row and its separator.
  if (/^resource$/i.test(cells[0])) continue;
  if (cells.every((c) => /^-{2,}$/.test(c))) continue;
  rows.push({ line: i + 1, section, resource: cells[0], owner: cells[1], lifetime: cells[2], trigger: cells[3] });
}

const problems = [];
if (rows.length < MIN_ROWS) {
  problems.push(
    `${DOC}: parsed ${rows.length} resource row(s), fewer than the ${MIN_ROWS} this registry is known to carry. The tables have moved or stopped parsing, so the owner check would pass without reading them.`,
  );
}

const empty = (v) => v.length === 0 || PLACEHOLDER.test(v);
for (const r of rows) {
  if (empty(r.resource)) {
    problems.push(`${DOC}:${r.line}: a row in "${r.section}" names no resource.`);
    continue;
  }
  if (empty(r.owner)) {
    problems.push(`${DOC}:${r.line}: "${r.resource}" is documented with no owner. Name the module or object that allocates it.`);
  }
  if (empty(r.trigger)) {
    problems.push(`${DOC}:${r.line}: "${r.resource}" is documented with no disposal trigger. Name what releases it, or say explicitly that it lives until the page does.`);
  }
  if (empty(r.lifetime)) {
    problems.push(`${DOC}:${r.line}: "${r.resource}" is documented with no lifetime.`);
  }
}

if (problems.length > 0) {
  console.error('\nlint:disposal-registry FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

const sections = new Set(rows.map((r) => r.section));
console.log(
  `lint:disposal-registry OK — ${rows.length} resources across ${sections.size} table(s) in ${DOC}, every one naming an owner, a lifetime and a disposal trigger.`,
);
