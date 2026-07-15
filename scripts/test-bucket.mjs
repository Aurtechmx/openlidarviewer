#!/usr/bin/env node
/**
 * test-bucket.mjs — run one named slice of the unit suite.
 *
 * The unit suite (tests/*.test.ts) grew large enough that a single `vitest run`
 * is slow and can time out on a busy machine. This splits it into four
 * coverage-complete buckets so CI can run them in parallel and a developer can
 * run just the relevant slice:
 *
 *   unit     — the core (io, model, convert, math, formatting, geometry, …)
 *   terrain  — the analysis pipeline (DTM, contours, accuracy, CRS, coverage)
 *   ui       — panels, toolbars, navigation, sheets, theming, overlays
 *   slow     — heavy decode / streaming / integration / torture / benchmark
 *
 * The classification lives here, once. `unit` is the catch-all: every file
 * that matches no other bucket lands in it, so the four buckets always union to
 * the whole suite — a newly added test can never silently fall out of CI. Run
 * `node scripts/test-bucket.mjs --verify` to assert that partition holds.
 *
 * Usage:
 *   node scripts/test-bucket.mjs <unit|terrain|ui|slow> [extra vitest args]
 *   node scripts/test-bucket.mjs --verify
 *
 * Playwright specs under tests/e2e/ are not touched here — they run via
 * `npm run test:e2e`.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = resolve(ROOT, 'tests');

// Heavy decode / large-data / integration — the genuinely slow files. LAS/LAZ
// and buffer/worker decode tests spin up a WASM decoder and are the ones that
// get starved (and time out) under the parallel `unit` bucket, so they belong
// here where the runner caps parallelism and raises the timeout.
const SLOW =
  /^(torture|benchmark|parse|loadLas|loadLaz|laszip)|integration|streaming|copc|ept|laz|octree|voxelDownsample|convertRoundTrip|convertBatch|moduleApi|preload|wasm|decode/i;
// The terrain-analysis pipeline.
const TERRAIN = /^(analyse|analysis|contour|cell|ground|dem|hillshade|slope|calibrat|confidence|coverage|crs|datum|evidence|interval|civilProfile|profile|surface|quality|terrain|raster|gpuDeriv|scatter|aspect|canopy|dsm|dtm|seam|provenance|metricVersion|score|assessment|readiness|whyNot|recommend)/i;
// The interface layer.
const UI = /(panel|mobile|dock|toolbar|nav|button|sheet|inspector|theme|onboarding|tour|command|chip|legend|banner|overlayUi|visualsStudio|measureIcons|measureController|measureRail|fullscreen|standardViews|cameraPresets|annotation|export(Panel|Layout|Ui)|classScope|classVisibility|classLegend|colorMode|colorChip|colorProvenance)/i;
// The export / report / measurement-document layer — carved out of the old
// `unit` catch-all so neither bucket grows large enough to stall a single
// Vitest process in CI. Checked AFTER UI, so an export *panel* stays in `ui`.
const EXPORT = /(^export|exporter|^measurement|^report|^verify|^audit|^stockpile|^sessionFindings|^kml|^gzip|^zip|^scanReport|^spaceReport|^floorPlanExport|^download)/i;

/** Bucket a single test-file basename. `unit` is the catch-all. */
function bucketOf(name) {
  if (SLOW.test(name)) return 'slow';
  if (TERRAIN.test(name)) return 'terrain';
  if (UI.test(name)) return 'ui';
  if (EXPORT.test(name)) return 'export';
  return 'unit';
}

const BUCKETS = ['unit', 'export', 'terrain', 'ui', 'slow'];

function allTestFiles() {
  return readdirSync(TESTS_DIR).filter((f) => /\.(test|spec)\.ts$/.test(f));
}

function filesFor(bucket) {
  return allTestFiles().filter((f) => bucketOf(f) === bucket);
}

const [, , arg, ...rest] = process.argv;

if (arg === '--verify') {
  const files = allTestFiles();
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const f of files) counts[bucketOf(f)]++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ok = total === files.length;
  for (const b of BUCKETS) console.log(`${b}: ${counts[b]}`);
  console.log(`total: ${total} / ${files.length} — partition ${ok ? 'OK' : 'BROKEN'}`);
  process.exit(ok ? 0 : 1);
}

if (!BUCKETS.includes(arg)) {
  console.error(`usage: test-bucket.mjs <${BUCKETS.join('|')}|--verify> [vitest args]`);
  process.exit(2);
}

const files = filesFor(arg).map((f) => `tests/${f}`);
if (files.length === 0) {
  console.error(`no test files matched bucket "${arg}"`);
  process.exit(1);
}

// Per-bucket runner policy (determinism over raw speed on CI):
//   slow    — WASM/LAZ decode + integration: cap to 2 workers so a decoder is
//             never starved, and give it a generous per-test timeout.
//   terrain — heavy DTM/surface builds that legitimately run ~10-14 s in
//             isolation: raise the timeout so parallel contention can't tip a
//             genuine 14 s test past the strict 15 s global limit.
// The fast buckets (unit/export/ui) keep the strict 15 s global timeout, so a
// real regression there still trips it. Every bucket pins a worker cap so a
// high-core machine can't over-subscribe the pool and hang at shutdown
// (EPIPE / "Worker exited unexpectedly") even when every assertion passes; 2
// also matches the ~2-core GitHub-hosted runners for reproducibility.
//
// --maxWorkers is a SINGLE-VALUE vitest option — passing it twice makes vitest
// reject the run ("Expected a single value … received [4, 2]") before a single
// test loads. So this script is the ONE source of the cap: if the caller already
// supplied --maxWorkers (a dev override), ours steps aside and theirs wins,
// never appended on top.
const callerSetsWorkers = rest.some((a) => a === '--maxWorkers' || a.startsWith('--maxWorkers='));
const WORKERS = callerSetsWorkers ? [] : ['--maxWorkers=2'];
const BUCKET_ARGS = {
  unit: [...WORKERS],
  export: [...WORKERS],
  ui: [...WORKERS],
  terrain: [...WORKERS, '--testTimeout=45000'],
  slow: [...WORKERS, '--testTimeout=60000'],
};
const bucketArgs = BUCKET_ARGS[arg] ?? [...WORKERS];

const result = spawnSync('npx', ['vitest', 'run', ...files, ...bucketArgs, ...rest], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
