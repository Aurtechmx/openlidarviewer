#!/usr/bin/env node
/**
 * lint-monolith-size.mjs — a shrink-only ratchet on the two large files.
 *
 * `main.ts` and `Viewer.ts` are the application's two monoliths. The stated
 * target used to be a raw line count (< 2,500 and < 2,000), but a hard line
 * target rewards the wrong move: you can hit it by relocating view-bound glue
 * into a "host" module that just re-exposes the whole class, which lowers the
 * number without decoupling anything or gaining a single test. The
 * architecture map now sets the real exit condition — every cluster with a
 * genuine boundary AND a Node-test payoff is extracted, and the remainder is
 * enumerated as irreducibly view-bound.
 *
 * This guard backs the honest half of that: the files may SHRINK, never grow.
 * It stops the monoliths quietly re-accreting the code a decomposition step
 * just removed, without forcing vanity extraction to chase a number. When a
 * step legitimately lowers a count, run with --update to bank it; there is no
 * flag to raise a baseline, so growth is always a deliberate, hand-edited act.
 *
 * A directional ceiling stays in the baseline as `goal`, recorded for context
 * only — this guard never enforces it. Reaching it is the architecture map's
 * job to judge, not a line counter's.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/monolith-size-baseline.json');

const FILES = ['src/main.ts', 'src/render/Viewer.ts'];
const GOAL = { 'src/main.ts': 2500, 'src/render/Viewer.ts': 2000 };

const countLines = (rel) => readFileSync(resolve(ROOT, rel), 'utf8').split('\n').length;

const current = {};
for (const f of FILES) current[f] = countLines(f);

if (process.argv.includes('--update') || !existsSync(BASELINE)) {
  const files = {};
  for (const f of FILES) files[f] = { lines: current[f], goal: GOAL[f] };
  writeFileSync(BASELINE, `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(
    `monolith-size baseline written — ${FILES.map((f) => `${f} ${current[f]}`).join(', ')}.`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];
for (const f of FILES) {
  const allowed = baseline.files[f]?.lines;
  if (allowed === undefined) continue;
  if (current[f] > allowed) {
    problems.push(
      `${f}: ${current[f]} lines, baseline ${allowed}. The monoliths may shrink, never grow — `
      + 'extract a cluster or move new code into its own module rather than adding here.',
    );
  }
}

if (problems.length > 0) {
  console.error('lint:monolith-size FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nIf a decomposition step legitimately lowered a count, run '
    + '"node scripts/lint-monolith-size.mjs --update" to bank it.');
  process.exit(1);
}

const shrunk = FILES.reduce((a, f) => a + (baseline.files[f].lines - current[f]), 0);
console.log(
  `lint:monolith-size OK — ${FILES.map((f) => `${f.split('/').pop()} ${current[f]}`).join(', ')}`
  + (shrunk > 0 ? ` (${shrunk} fewer than baseline; run --update to bank it).` : '.'),
);
