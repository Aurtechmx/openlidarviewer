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

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = resolve(ROOT, 'tests');

// Heavy decode / large-data / integration — the genuinely slow files. LAS/LAZ
// and buffer/worker decode tests spin up a WASM decoder and are the ones that
// get starved (and time out) under the parallel `unit` bucket, so they belong
// here where the runner caps parallelism and raises the timeout.
// Two rules, not one pattern. The first list matches a file name's opening
// word, the second matches anywhere in it. Written as a single regex the `^`
// bound to the first alternative only, which reads as a mistake whether or not
// it is one, and both scanners flag it as one.
const SLOW_PREFIX = /^(?:torture|benchmark|parse|loadLas|loadLaz|laszip)/i;
const SLOW_ANYWHERE =
  /integration|streaming|copc|ept|laz|octree|voxelDownsample|convertRoundTrip|convertBatch|moduleApi|preload|wasm|decode|packaging/i;
const isSlow = (name) => SLOW_PREFIX.test(name) || SLOW_ANYWHERE.test(name);
// The terrain-analysis pipeline.
const TERRAIN = /^(analyse|analysis|contour|cell|ground|dem|hillshade|slope|calibrat|confidence|coverage|crs|datum|evidence|interval|civilProfile|profile|surface|quality|terrain|raster|gpuDeriv|scatter|aspect|canopy|dsm|dtm|seam|provenance|metricVersion|score|assessment|readiness|whyNot|recommend)/i;
// The interface layer.
const UI = /(panel|mobile|dock|toolbar|nav|button|sheet|inspector|theme|onboarding|tour|command|chip|legend|banner|overlayUi|visualsStudio|measureIcons|measureController|measureRail|fullscreen|standardViews|cameraPresets|annotation|export(Panel|Layout|Ui)|classScope|classVisibility|classLegend|colorMode|colorChip|colorProvenance)/i;
// The export / report / measurement-document layer — carved out of the old
// `unit` catch-all so neither bucket grows large enough to stall a single
// Vitest process in CI. Checked AFTER UI, so an export *panel* stays in `ui`.
const EXPORT = /(^export|exporter|^measurement|^report|^verify|^audit|^stockpile|^sessionFindings|^kml|^gzip|^zip|^scanReport|^spaceReport|^floorPlanExport|^download)/i;

/** Bucket a single test-file name. `unit` is the catch-all. */
function bucketOf(name) {
  // A nested directory routes explicitly, before any regex gets a look in.
  const slash = name.indexOf('/');
  if (slash > 0) {
    const routed = NESTED_TEST_DIRS[name.slice(0, slash)];
    if (routed) return routed;
  }
  if (isSlow(name)) return 'slow';
  if (TERRAIN.test(name)) return 'terrain';
  if (UI.test(name)) return 'ui';
  if (EXPORT.test(name)) return 'export';
  return 'unit';
}

const BUCKETS = ['unit', 'export', 'terrain', 'ui', 'slow'];

// Test subdirectories that hold UNIT tests, and the bucket each one routes to.
// tests/e2e/ is deliberately absent — those are Playwright specs. Two reasons
// this map exists rather than letting the regexes above classify a nested path:
//   - without the enumeration, a file added under tests/benchmark/ would belong
//     to no bucket at all, so the release gate would run every bucket green
//     while never executing it;
//   - without the explicit bucket, `tests/benchmark/*` matched `slow` only
//     because SLOW_PREFIX starts with `benchmark` (written for the old
//     top-level benchmark.test.ts). Those files run in ~50 ms and belong in
//     `unit`; routing them by accident would also change silently the next time
//     a bucket regex is edited.
const NESTED_TEST_DIRS = { benchmark: 'unit' };

function allTestFiles() {
  const top = readdirSync(TESTS_DIR).filter((f) => /\.(test|spec)\.ts$/.test(f));
  const nested = Object.keys(NESTED_TEST_DIRS).flatMap((dir) => {
    let entries;
    try {
      entries = readdirSync(join(TESTS_DIR, dir));
    } catch {
      return []; // the directory may legitimately not exist yet
    }
    return entries.filter((f) => /\.(test|spec)\.ts$/.test(f)).map((f) => `${dir}/${f}`);
  });
  return [...top, ...nested];
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
  // Print the nested routing so the gate log shows WHERE those files ran, not
  // just that the partition adds up.
  for (const [dir, bucket] of Object.entries(NESTED_TEST_DIRS)) {
    console.log(`tests/${dir}/ → ${bucket} (explicit)`);
  }
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

// A shard that has not finished in this long is wedged, not slow: the whole
// unit bucket runs in seconds and the slowest (streaming) in a couple of
// minutes. Killing it with a message beats inheriting a hang that the release
// gate reports as a nondescript failure ten minutes later.
const SHARD_TIMEOUT_MS = Number(process.env.OLV_SHARD_TIMEOUT_MS ?? 8 * 60 * 1000);
// How long `close` gets to arrive after the group is killed before the wait is
// abandoned. Short: by this point the shard is already over its budget, and a
// gate that hangs is worse than one that reports a kill it could not confirm.
const TIMEOUT_GRACE_MS = 2000;

// Run the LOCAL vitest binary, never `npx vitest`: npx interposes an extra
// process, so a kill lands on the wrapper while the real vitest and its whole
// worker pool survive, holding the inherited stdio pipe open forever. That is
// the shape of the release-gate hang where every shard printed "N passed" and
// the run still never returned.
const VITEST_BIN = resolve(ROOT, 'node_modules/.bin/vitest');

/**
 * Run one vitest invocation over this bucket's files.
 *
 * Async `spawn` + `detached` makes each shard its own PROCESS GROUP LEADER, so
 * a timeout can kill the group (-pid) and reclaim the orphaned workers.
 * `spawnSync`'s own `timeout` only ever signalled the direct child, which is
 * why wedged workers kept the pipe open and the parent waited forever.
 * Resolves the same {status, signal, error} shape `resolveExit` expects.
 */
let tallySeq = 0;

/**
 * Emit a machine-readable tally the release evidence collector can trust.
 *
 * The human `Tests N passed` line is printed by vitest through the shard's
 * INHERITED stdio. That reaches the terminal, but on a GitHub runner it can
 * race the gate's `tee` pipe and never land in `release/gate.log` — so the
 * collector, reading the log, saw zero tallies and failed a green run. The
 * fix does not depend on that stream at all: vitest also writes a JSON
 * summary to a file, and THIS parent process reads the file after the shard
 * exits and prints one `GATE TALLY` line to its own stdout — synchronously,
 * before the shard result is returned, so it is always inside the pipe.
 */
function readTally(file, bucket) {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    const passed = Number(r.numPassedTests ?? 0);
    const skipped = Number(r.numPendingTests ?? 0) + Number(r.numTodoTests ?? 0);
    console.log(`GATE TALLY bucket=${bucket} passed=${passed} skipped=${skipped}`);
  } catch {
    // No file (a start failure, or a vitest that never wrote one): stay silent
    // and let the collector fall back to the human summary. A wrong number is
    // worse than an absent one, so never guess here.
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

function runVitest(extra, label) {
  return new Promise((res) => {
    const started = Date.now();
    const tallyFile = join(tmpdir(), `olv-tally-${arg}-${process.pid}-${tallySeq++}.json`);
    const child = spawn(
      VITEST_BIN,
      [
        'run', ...files, ...bucketArgs, ...extra, ...passthrough,
        // default keeps the human console output; json feeds the file the
        // parent reads for the GATE TALLY line.
        '--reporter=default', '--reporter=json', `--outputFile.json=${tallyFile}`,
      ],
      { cwd: ROOT, stdio: 'inherit', detached: true },
    );

    let timedOut = false;
    let settled = false;
    /**
     * The timeout must END THE WAIT, not merely ask the child to stop.
     *
     * The first version killed the group and then resolved only from
     * `child.on('close')`. `close` fires when every inherited stdio stream has
     * been released — so anything that survived the kill and still held the
     * pipe (a grandchild that escaped the group, a handle the signal did not
     * reach) meant `close` never fired, `finish` was never called, and the
     * promise hung forever: an eight-minute timeout that did not recover a
     * shard inside twelve minutes, because the timer had fired and had no way
     * to say so.
     *
     * So: kill the group, then give `close` a brief grace period to arrive
     * naturally, and settle regardless when it does not.
     */
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Negative pid = the whole group. The group may already be gone (the
        // race between the timer firing and a normal exit), hence the guard.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group already reaped */
      }
      setTimeout(() => {
        finish({
          error: Object.assign(new Error('shard timed out'), { code: 'ETIMEDOUT' }),
          status: null,
          signal: null,
        });
      }, TIMEOUT_GRACE_MS).unref();
    }, SHARD_TIMEOUT_MS);

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // On a clean pass, publish the tally the collector reads. Only on success:
      // a failed or killed shard reddens the gate before evidence is collected,
      // and its partial JSON would misreport the run.
      if (!r.error && !r.signal && r.status === 0) readTally(tallyFile, arg);
      else { try { rmSync(tallyFile, { force: true }); } catch { /* best effort */ } }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[${label}] pid=${child.pid} elapsed=${secs}s code=${r.status ?? '-'} signal=${r.signal ?? '-'}`,
      );
      res(r);
    };

    child.on('error', (error) => finish({ error, status: null, signal: null }));
    // `close` (not `exit`) so inherited stdio is fully drained before we move on.
    child.on('close', (status, signal) => {
      if (timedOut) {
        finish({ error: Object.assign(new Error('shard timed out'), { code: 'ETIMEDOUT' }), status: null, signal: null });
        return;
      }
      finish({ status, signal, error: undefined });
    });
  });
}

/**
 * Turn a spawn result into an exit code, SAYING what happened.
 *
 * `spawnSync` reports a signal death as `status: null`, and collapsing that
 * with `?? 1` produced a bad failure mode: an exit 1 with no output and no
 * reason, indistinguishable from a test failure. A
 * release gate has to either succeed or state why it did not.
 */
function resolveExit(r, label) {
  if (r.error) {
    const timedOut = r.error.code === 'ETIMEDOUT';
    console.error(
      timedOut
        ? `\n✗ ${label} exceeded ${Math.round(SHARD_TIMEOUT_MS / 1000)}s and was killed. `
          + 'The assertions may all pass; this is the runner failing to terminate. '
          + 'Re-run that bucket alone to confirm, and raise OLV_SHARD_TIMEOUT_MS if the machine is slow.'
        : `\n✗ ${label} could not be started: ${r.error.message}`,
    );
    return timedOut ? 124 : 2;
  }
  if (r.signal) {
    console.error(
      `\n✗ ${label} was killed by ${r.signal} — no test failure was reported. `
      + 'This is a runner/environment fault, not a red suite.',
    );
    return 137;
  }
  if (r.status === null || r.status === undefined) {
    console.error(`\n✗ ${label} exited without a status code.`);
    return 1;
  }
  return r.status;
}

// `--shards=N` (plural) runs the bucket as N SEQUENTIAL sub-shards, each a fresh
// vitest process over a deterministic 1/N slice of the files (vitest --shard).
// This is the canonical reliable runner used by `test:release`: no single
// process holds hundreds of files, which is the shape that fails to terminate
// ("Worker exited unexpectedly") at shutdown on a constrained machine. CI runs
// the SAME script with `--shard=i/N` (singular) to run those slices in parallel;
// a singular `--shard` always wins and our custom `--shards` is stripped before
// vitest sees it, so `npm run test:unit -- --shard=1/3` does the right thing too.
const singleShard = rest.some((a) => a === '--shard' || a.startsWith('--shard='));
const multiShard = rest.find((a) => a === '--shards' || a.startsWith('--shards='));
/**
 * Extra arguments reach vitest untouched, so they are checked before they do.
 *
 * `spawn` is called without a shell, so nothing here can be a shell injection.
 * What it can be is a path: this script is run by agents and CI as well as by
 * hand, and an argument naming a file outside the repository would have vitest
 * read or write somewhere nobody intended. A flag or a test-name pattern is
 * left alone; anything shaped like a path has to resolve inside the tree.
 */
function checkedPassthrough(args) {
  for (const a of args) {
    if (a.includes('\0')) {
      console.error('test-bucket: an argument contains a null byte.');
      process.exit(2);
    }
    if (!a.startsWith('-') && /[/\\]/.test(a)) {
      const target = resolve(ROOT, a);
      if (target !== ROOT && !target.startsWith(ROOT + sep)) {
        console.error(`test-bucket: "${a}" points outside the repository.`);
        process.exit(2);
      }
    }
  }
  return args;
}

const passthrough = checkedPassthrough(rest.filter((a) => a !== multiShard));

if (multiShard && !singleShard) {
  const n = Number(multiShard.includes('=') ? multiShard.split('=')[1] : NaN);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--shards expects a positive integer, got "${multiShard}"`);
    process.exit(2);
  }
  let worst = 0;
  for (let i = 1; i <= n; i++) {
    console.log(`\n──── ${arg} shard ${i}/${n} ────`);
    const r = await runVitest([`--shard=${i}/${n}`], `${arg} shard ${i}/${n}`);
    const code = resolveExit(r, `${arg} shard ${i}/${n}`);
    if (code !== 0) worst = code;
  }
  process.exit(worst);
}

const result = await runVitest([], `${arg} bucket`);
process.exit(resolveExit(result, `${arg} bucket`));
