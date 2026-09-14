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
 *
 * WATCH LIST. Shrinking two files does not help if the code lands in a third:
 * `main.ts` can fall while `AnalysePanel.ts` rises and the ratchet still
 * reports OK. The modules below are the next tier by size, monitored rather
 * than ratcheted — each may move within a slack band, and only material growth
 * fails. A watched module is not promised to shrink; it is promised not to
 * become the next monolith unnoticed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/monolith-size-baseline.json');

const FILES = ['src/main.ts', 'src/render/Viewer.ts'];
const GOAL = { 'src/main.ts': 2500, 'src/render/Viewer.ts': 2000 };

/** The next tier by size: monitored for material growth, free to move below it. */
const WATCH = [
  'src/ui/AnalysePanel.ts',
  'src/ui/Inspector.ts',
  'src/render/measure/MeasureController.ts',
  'src/ui/MeasurePanel.ts',
  'src/render/measure/profilePdf.ts',
  'src/render/streaming/StreamingScheduler.ts',
  'src/terrain/contour/analyseContours.ts',
];

/**
 * Slack a watched module may grow within: 5% of its banked size, at least 40
 * lines. Wide enough that ordinary work inside a module never trips it, narrow
 * enough that accretion does — a 3,500-line panel gets ~175 lines, not another
 * thousand.
 */
export function watchAllowance(banked) {
  return banked + Math.max(40, Math.round(banked * 0.05));
}

/** Watched modules that grew past their slack band. */
export function collectWatchDrift(current, baseline) {
  const drifted = [];
  for (const [file, lines] of Object.entries(current)) {
    const banked = baseline?.watch?.[file]?.lines;
    if (banked === undefined) continue;
    const ceiling = watchAllowance(banked);
    if (lines > ceiling) drifted.push({ file, current: lines, banked, ceiling });
  }
  return drifted;
}

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
  // A watched module that is not in the tree is simply not measured: the two
  // ratcheted files are the guard's subject, and a partial checkout (or a
  // fixture tree holding only those two) must not fail on the monitoring half.
  const watched = {};
  for (const f of WATCH) {
    try {
      watched[f] = countLines(f);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

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
  const drifted = collectWatchDrift(watched, baseline);

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
    // The watch list is a band, not a ratchet, so --update re-banks it in
    // either direction: it records where a module sits, and the band around
    // that is what the guard enforces.
    const watch = {};
    for (const f of WATCH) watch[f] = { lines: watched[f] };
    writeFileSync(BASELINE, `${JSON.stringify({ files, watch }, null, 2)}\n`);
    console.log(
      `monolith-size baseline written — ${FILES.map((f) => `${f} ${current[f]}`).join(', ')}.`,
    );
    process.exit(0);
  }

  if (grown.length > 0 || drifted.length > 0) {
    console.error('lint:monolith-size FAILED\n');
    for (const g of grown) console.error(`  • ${describeGrowth(g)}`);
    for (const d of drifted) {
      console.error(
        `  • ${d.file}: ${d.current} lines, banked at ${d.banked} with a band to ${d.ceiling}. `
        + 'A watched module grew past its slack — extract the new responsibility, or bank the '
        + 'move deliberately if this module is genuinely where it belongs.',
      );
    }
    console.error('\nIf a decomposition step legitimately lowered a count, run '
      + '"node scripts/lint-monolith-size.mjs --update" to bank it.');
    process.exit(1);
  }

  const shrunk = FILES.reduce((a, f) => a + (baseline.files[f].lines - current[f]), 0);
  const watchedCount = Object.keys(baseline.watch ?? {}).length;
  console.log(
    `lint:monolith-size OK — ${FILES.map((f) => `${f.split('/').pop()} ${current[f]}`).join(', ')}`
    + (shrunk > 0 ? ` (${shrunk} fewer than baseline; run --update to bank it)` : '')
    + `; ${watchedCount} watched module(s) inside their band.`,
  );
}
