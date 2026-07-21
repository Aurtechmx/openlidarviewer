#!/usr/bin/env node
/**
 * collect-evidence.mjs — derive the release's test counts from a gate run.
 *
 * Every published figure in the evidence documents used to be typed in by
 * hand after reading a log. That produced a release whose unit count, export
 * count and terrain count were all wrong while its total happened to be
 * right, because the total came from a script and the components came from a
 * person. An external reviewer caught it by adding them up; nothing in the
 * repository could, because `lint:release-sync` only checks that the
 * documents agree with EACH OTHER — three documents copying one wrong number
 * agree perfectly.
 *
 * So the counts are read out of the gate's own output here, once, into a file
 * the documents are then checked against. The total is computed, never
 * quoted. Usage:
 *
 *   npm run evidence
 *
 * which runs the gate, captures its EXIT CODE, and collects only on zero.
 * The exit code is passed in rather than sniffed from the log: the gate emits
 * no success banner, so grepping for one would be a check that always passes
 * — a guard that cannot fail is worse than none, because it reads like
 * protection. Writes `docs/validation/test-evidence.json`.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which bucket a shard banner names.
 *
 * The gate prints `──── unit shard 2/3 ────` before each sub-shard and the
 * npm lifecycle line `> openlidarviewer@x.y.z test:export` before each
 * bucket. Either is enough to attribute the `Tests N passed` line that
 * follows; both are matched so a change to one does not silently drop counts
 * into the wrong bucket.
 */
const BUCKETS = ['unit', 'export', 'terrain', 'ui', 'slow'];

export function parseGateLog(text) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, { passed: 0, skipped: 0, runs: 0 }]));
  let current = null;
  for (const line of text.split('\n')) {
    const shard = /────\s*(\w+)\s+shard\s+\d+\/\d+\s*────/.exec(line);
    if (shard && BUCKETS.includes(shard[1])) current = shard[1];
    const script = /^>\s*\S+\s+test:(\w+)$/.exec(line.trim());
    if (script && BUCKETS.includes(script[1])) current = script[1];
    const tally = /^\s*Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/.exec(line);
    if (tally && current) {
      buckets[current].passed += Number(tally[1]);
      buckets[current].skipped += Number(tally[2] ?? 0);
      buckets[current].runs += 1;
    }
  }
  return buckets;
}

function main() {
  const logPath = process.argv[2];
  const gateExit = process.argv[3];
  if (!logPath || gateExit === undefined) {
    console.error('usage: node scripts/collect-evidence.mjs <gate-log> <gate-exit-code>');
    process.exit(2);
  }
  if (gateExit !== '0') {
    // Publishing figures from a run that did not finish green would be the
    // same failure in a new costume.
    console.error(`Gate exited ${gateExit}. Evidence is only collected from a run that passed.`);
    process.exit(1);
  }
  const text = readFileSync(logPath, 'utf8');
  const buckets = parseGateLog(text);
  const empty = BUCKETS.filter((b) => buckets[b].runs === 0);
  if (empty.length > 0) {
    console.error(`No test tally found for: ${empty.join(', ')}. Was this a complete gate run?`);
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
  let commit = null;
  try {
    commit = execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch { /* building without git is legitimate */ }

  // The bundle figure is the same class of hand-typed number as the test
  // counts — three documents quoted 699 KiB while the build produced 715.
  // Read it from the budget report the gate already prints.
  const bundle = /^\s*[⚠✓]\s+\S*\s*index\s+(\d+)\s*KiB\s*\/\s*(\d+)\s*KiB/m.exec(text);
  const liveEntryKiB = bundle ? Number(bundle[1]) : null;
  const ceilingKiB = bundle ? Number(bundle[2]) : null;

  const totalPassed = BUCKETS.reduce((n, b) => n + buckets[b].passed, 0);
  const totalSkipped = BUCKETS.reduce((n, b) => n + buckets[b].skipped, 0);

  // Preserve the log this was derived from, and hash it. Naming a path under
  // /tmp told a reader where the numbers came from and gave them no way to
  // check: the file was not in the package. A recomputable artefact beats a
  // citation of one that no longer exists.
  mkdirSync(resolve(ROOT, 'release'), { recursive: true });
  const keptLog = resolve(ROOT, 'release/gate.log');
  // Scrub absolute paths before keeping it. This log is a release artefact —
  // it may be attached to a published release — and a build log reproduces
  // whatever the machine's directory layout happens to be. The counts, the
  // shard banners and the exit lines are what a reviewer needs; the operator's
  // home directory is not.
  const scrubbed = readFileSync(logPath, 'utf8')
    .split(ROOT).join('.')
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '~');
  writeFileSync(keptLog, scrubbed);
  const gateLogSha256 = createHash('sha256').update(readFileSync(keptLog)).digest('hex');
  writeFileSync(`${keptLog}.sha256`, `${gateLogSha256}  gate.log\n`);

  const evidence = {
    version,
    commit,
    gateExit: 0,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    // Kept beside the package as release/gate.log, with this hash, so the
    // figures can be recomputed rather than trusted.
    gateLog: 'release/gate.log',
    gateLogSha256,
    buckets,
    total: { passed: totalPassed, skipped: totalSkipped },
    bundle: { liveEntryKiB, ceilingKiB },
  };

  mkdirSync(resolve(ROOT, 'docs/validation'), { recursive: true });
  const out = resolve(ROOT, 'docs/validation/test-evidence.json');
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`test-evidence.json written: ${BUCKETS.map((b) => `${b} ${buckets[b].passed}`).join(' · ')}`);
  console.log(`total ${totalPassed} passed / ${totalSkipped} skipped`);
  console.log(`live entry ${liveEntryKiB ?? '?'} KiB / ${ceilingKiB ?? '?'} KiB`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
