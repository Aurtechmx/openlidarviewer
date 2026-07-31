#!/usr/bin/env node
/**
 * lint-upload-queue-seam.mjs — the seam the upload queue plugs into must stay.
 *
 * Named for what it proves. It was lint:upload-queue-wired, and "wired" reads as
 * "the queue runs", which it does not: the Viewer constructs no queue and the
 * option is off. This asserts the call site still exists, so that wiring it later
 * is a decision rather than an archaeology exercise.
 *
 * `GpuUploadQueue` and `pipelineLimits` were written, tested, and then left
 * unconnected: a v0.6.3 audit of the shipped v0.6.2 source found no live
 * runtime import at all. The work was done and bought nothing, and nothing in
 * the repository noticed for a release.
 *
 * A test cannot catch that. The queue's own suite passes whether or not
 * anything uses it, which is precisely how it stayed dormant. This checks the
 * one thing the tests cannot: that the scheduler still reaches for it.
 *
 * Deliberately structural rather than behavioural. It asserts the seam exists,
 * not that the queue is enabled by default — the option is off until browser
 * evidence supports turning it on, and this gate must not be read as saying
 * otherwise.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each: a file that must reference a symbol, and why it matters. */
const REQUIRED = [
  {
    file: 'src/render/streaming/StreamingScheduler.ts',
    symbol: 'GpuUploadQueue',
    why: 'the scheduler must be able to route commits through the queue',
  },
  {
    file: 'src/render/streaming/StreamingScheduler.ts',
    symbol: 'decodedChunkBytes',
    why: 'the byte budget needs an exact per-chunk size, not a per-point guess',
  },
  {
    file: 'src/render/streaming/StreamingNode.ts',
    symbol: "'decoded'",
    why: 'decoded-but-not-drawn must stay distinct from resident',
  },
];

const problems = [];
for (const { file, symbol, why } of REQUIRED) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, file), 'utf8');
  } catch {
    problems.push(`${file} is missing — ${why}.`);
    continue;
  }
  if (!text.includes(symbol)) {
    problems.push(`${file} no longer references ${symbol} — ${why}.`);
  }
}

if (problems.length > 0) {
  console.error('lint:upload-queue-seam FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nThe queue was dormant for a whole release once. Re-wire it, or');
  console.error('remove it and say so, rather than leaving tested code nothing calls.');
  process.exit(1);
}

console.log(
  `lint:upload-queue-seam OK — ${REQUIRED.length} seam(s) present. The seam exists; nothing here says the queue runs.`,
);
