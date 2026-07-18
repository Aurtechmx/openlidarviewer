#!/usr/bin/env node
/**
 * test-file.mjs — run one or a few named test files, reliably, for fast iteration.
 *
 * The whole-suite `vitest run` and even a single ad-hoc `npx vitest <file>
 * --reporter=json` can, on some machines, print their summary and then fail to
 * terminate (a worker pool that doesn't drain at shutdown), or exhaust the heap
 * on a runaway test — leaving no trustworthy signal. The release buckets
 * (scripts/test-bucket.mjs) avoid that by pinning a small worker cap and the
 * default pool; they terminate cleanly. This runner applies the SAME policy to
 * an arbitrary file list so a developer can drive one test file red→green
 * without running a six-minute bucket, and adds a hard wall-clock watchdog so a
 * hung shutdown becomes a fast, explicit failure instead of a silent stall.
 *
 * Usage:
 *   node scripts/test-file.mjs tests/eptStreaming.test.ts [more.test.ts ...]
 *   node scripts/test-file.mjs tests/foo.test.ts --deadline=90   # seconds
 *   node scripts/test-file.mjs tests/foo.test.ts -t "name filter" # extra vitest args pass through
 *
 * The last line printed is always `TESTFILE EXIT: <code>` (0 = all passed),
 * so callers can grep the literal result rather than trust a summary line.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
// A generous default: a single file, even one that spins up the WASM decoder,
// finishes well inside this. The watchdog only fires on a genuine hang.
let deadlineSec = 120;
const passthrough = [];
const files = [];
for (const a of argv) {
  if (a.startsWith('--deadline=')) {
    const n = Number(a.slice('--deadline='.length));
    if (Number.isFinite(n) && n > 0) deadlineSec = n;
    continue;
  }
  // A bare token ending in .test.ts / .spec.ts (or containing a path sep) is a
  // file; everything else is a vitest passthrough flag (-t, --reporter, …).
  if (/\.(test|spec)\.ts$/.test(a) || a.includes('/')) files.push(a);
  else passthrough.push(a);
}

if (files.length === 0) {
  console.error('usage: test-file.mjs <file.test.ts ...> [--deadline=<sec>] [vitest args]');
  console.log('TESTFILE EXIT: 2');
  process.exit(2);
}

// Mirror the terminating policy the release buckets use: default pool, a small
// worker cap, the dot reporter, and a strict per-test timeout. No --reporter=json
// / --outputFile (the combination implicated in the non-terminating runs) and no
// single-fork override — the caller can still pass their own via passthrough.
const vitestArgs = [
  'vitest',
  'run',
  ...files,
  '--maxWorkers=2',
  '--reporter=dot',
  '--testTimeout=30000',
  ...passthrough,
];

const child = spawn('npx', vitestArgs, { cwd: ROOT, stdio: 'inherit' });

let watchdogTripped = false;
const watchdog = setTimeout(() => {
  watchdogTripped = true;
  console.error(
    `\nWATCHDOG: vitest did not exit within ${deadlineSec}s — killing. ` +
      `Treat as FAILURE (hang or non-terminating shutdown), not a pass.`,
  );
  child.kill('SIGKILL');
}, deadlineSec * 1000);

function finish(code) {
  clearTimeout(watchdog);
  const exit = watchdogTripped ? 1 : (code ?? 1);
  console.log(`TESTFILE EXIT: ${exit}`);
  process.exit(exit);
}

child.on('exit', (code, signal) => {
  if (watchdogTripped) return finish(1);
  if (signal) {
    console.error(`\nvitest terminated by signal ${signal}`);
    return finish(1);
  }
  finish(code);
});
child.on('error', (err) => {
  console.error(`\nfailed to spawn vitest: ${err.message}`);
  finish(1);
});
