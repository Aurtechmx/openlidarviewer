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
 * step legitimately lowers a count, run with --update to bank it. --update
 * banks a drop and REFUSES a raise, and refuses the whole write when one file
 * dropped and another rose, so a raise is only ever a hand edit to the baseline
 * file — visible in the diff, and never a side effect of the command an
 * operator was told to run after a decomposition step.
 *
 * A directional ceiling stays in the baseline as `goal`, recorded for context
 * only — this guard never enforces it. Reaching it is the architecture map's
 * job to judge, not a line counter's.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/monolith-size-baseline.json');

const FILES = ['src/main.ts', 'src/render/Viewer.ts'];
const GOAL = { 'src/main.ts': 2500, 'src/render/Viewer.ts': 2000 };

const countLines = (rel) => readFileSync(resolve(ROOT, rel), 'utf8').split('\n').length;

/**
 * Files in `current` that sit above the count banked for them in `baseline`.
 *
 * The single source of truth for "this grew", used by BOTH the check and the
 * --update path. A pass returns []; each entry is `{ file, current, allowed }`.
 * A null baseline (first run) has nothing to enforce, and a file the baseline
 * does not record is not governed by it.
 */
export function collectGrowth(current, baseline) {
  const grown = [];
  if (!baseline) return grown;
  for (const [file, lines] of Object.entries(current)) {
    const allowed = baseline.files?.[file]?.lines;
    if (allowed === undefined) continue;
    if (lines > allowed) grown.push({ file, current: lines, allowed });
  }
  return grown;
}

const describeGrowth = (g) =>
  `${g.file}: ${g.current} lines, baseline ${g.allowed}. The monoliths may shrink, never grow — `
  + 'extract a cluster or move new code into its own module rather than adding here.';

if (isCliEntry(import.meta.url)) {
  const current = {};
  for (const f of FILES) current[f] = countLines(f);

  // Read once and let a missing file be the absence, rather than asking whether
  // it exists and then reading it: between the two the file can appear or go,
  // and the second step then acts on an answer the first no longer supports.
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const grown = collectGrowth(current, baseline);

  if (baseline === null && !process.argv.includes('--update')) {
    // A missing baseline used to be written silently at the CURRENT counts and
    // the run exited 0: delete the file, grow the monolith, and the shrink-only
    // ratchet banked the growth on the very run meant to catch it.
    console.error(`lint:monolith-size FAILED\n\n  ${BASELINE} is missing. It is a hand-edited record; restore it from git, or run --update deliberately.`);
    process.exit(1);
  }
  if (process.argv.includes('--update') || baseline === null) {
    // Refuse before writing. --update is the command the failure message tells
    // an operator to run, so banking a raise here would let the guard undo
    // itself on the very path taken to satisfy it.
    if (grown.length > 0) {
      console.error('lint:monolith-size --update REFUSED\n');
      for (const g of grown) console.error(`  • ${describeGrowth(g)}`);
      console.error(
        '\n--update banks a drop, never a raise, and refuses the whole write when any file '
        + `grew. If the growth is deliberate, edit ${'docs/validation/monolith-size-baseline.json'} `
        + 'by hand so the new number is reviewed in the diff.',
      );
      process.exit(1);
    }
    const files = {};
    for (const f of FILES) files[f] = { lines: current[f], goal: GOAL[f] };
    writeFileSync(BASELINE, `${JSON.stringify({ files }, null, 2)}\n`);
    console.log(
      `monolith-size baseline written — ${FILES.map((f) => `${f} ${current[f]}`).join(', ')}.`,
    );
    process.exit(0);
  }

  if (grown.length > 0) {
    console.error('lint:monolith-size FAILED\n');
    for (const g of grown) console.error(`  • ${describeGrowth(g)}`);
    console.error('\nIf a decomposition step legitimately lowered a count, run '
      + '"node scripts/lint-monolith-size.mjs --update" to bank it.');
    process.exit(1);
  }

  const shrunk = FILES.reduce((a, f) => a + (baseline.files[f].lines - current[f]), 0);
  console.log(
    `lint:monolith-size OK — ${FILES.map((f) => `${f.split('/').pop()} ${current[f]}`).join(', ')}`
    + (shrunk > 0 ? ` (${shrunk} fewer than baseline; run --update to bank it).` : '.'),
  );
}
