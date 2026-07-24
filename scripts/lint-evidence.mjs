#!/usr/bin/env node
/**
 * lint-evidence.mjs — the published test figures must match the run.
 *
 * `lint:release-sync` checks that the evidence documents agree with each
 * other, which three documents copying one wrong number do perfectly. A
 * release shipped with its unit, export and terrain counts all wrong and its
 * total right — the total came from a script, the components were typed in —
 * and no check in the repository could see it. A reviewer added them up.
 *
 * So this compares every published figure against `docs/validation/test-evidence.json`,
 * which is machine-derived from a passing gate run, and separately checks that
 * the components add up to the stated total. Either could be wrong on its own;
 * both wrong in the same direction is the case that got through last time.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const problems = [];

const EVIDENCE = 'docs/validation/test-evidence.json';
if (!existsSync(resolve(ROOT, EVIDENCE))) {
  // A FAILURE, not a skip. The first version wrote this file into the
  // gitignored release/ directory, so it never reached the source archive and
  // the check silently passed on every fresh clone — a guard that cannot fail,
  // which is the exact shape this whole mechanism exists to prevent. The file
  // is tracked now; its absence means someone removed it.
  console.error(
    `lint:evidence FAILED — ${EVIDENCE} is missing. It is tracked in the repository; `
    + 'restore it, or run "npm run evidence" against a passing gate to regenerate it.',
  );
  process.exit(1);
}

const evidence = JSON.parse(read(EVIDENCE));
const version = JSON.parse(read('package.json')).version;
const n = (v) => v.toLocaleString('en-US');

if (evidence.version !== version) {
  problems.push(
    `${EVIDENCE} records v${evidence.version}, but package.json is v${version} — the figures describe a different release. Re-run "npm run evidence".`,
  );
}

// The arithmetic, checked independently of the documents. This is the exact
// failure that shipped: components that did not sum to the published total.
const summed = Object.values(evidence.buckets).reduce((a, b) => a + b.passed, 0);
if (summed !== evidence.total.passed) {
  problems.push(
    `${EVIDENCE} is internally inconsistent: buckets sum to ${summed} but total says ${evidence.total.passed}.`,
  );
}
// Skipped counts were never checked, only passed ones — the same arithmetic
// left unguarded on the other column.
const summedSkipped = Object.values(evidence.buckets).reduce((a, b) => a + b.skipped, 0);
if (summedSkipped !== evidence.total.skipped) {
  problems.push(
    `${EVIDENCE}: skipped counts sum to ${summedSkipped} but total says ${evidence.total.skipped}.`,
  );
}
// A bucket that never ran contributes zero and looks like a pass — and a
// bucket that ran FEWER shards than it should silently under-reports, which
// `runs > 0` alone would not catch. The sharding is declared in package.json
// (`--shards=N`), so the expected count is derivable rather than a magic
// number that could drift away from the runner.
const EXPECTED_RUNS = (() => {
  const scripts = JSON.parse(read('package.json')).scripts ?? {};
  const out = {};
  for (const name of Object.keys(evidence.buckets)) {
    const cmd = scripts[`test:${name}`] ?? '';
    const m = /--shards=(\d+)/.exec(cmd);
    out[name] = m ? Number(m[1]) : 1;
  }
  return out;
})();
for (const [name, b] of Object.entries(evidence.buckets)) {
  if (!(b.passed > 0)) problems.push(`${EVIDENCE}: bucket "${name}" passed ${b.passed} tests.`);
  const want = EXPECTED_RUNS[name];
  if (b.runs !== want) {
    problems.push(
      `${EVIDENCE}: bucket "${name}" recorded ${b.runs} run(s); package.json declares ${want}. `
      + 'A dropped shard under-reports without failing anything.',
    );
  }
}
if (evidence.gateExit !== 0) {
  problems.push(`${EVIDENCE} records gateExit ${evidence.gateExit}; figures may only come from a passing run.`);
}
for (const k of ['liveEntryKiB', 'ceilingKiB']) {
  const v = evidence.bundle?.[k];
  if (!Number.isFinite(v) || v <= 0) problems.push(`${EVIDENCE}: bundle.${k} is ${v}, expected a positive number.`);
}

/**
 * Documents that quote the figures, and the bucket each label refers to.
 *
 * The pattern is deliberately narrow — "unit 2,927", "export 598" — so it
 * matches published claims and not incidental prose. A document that mentions
 * no figure at all is fine; one that mentions a WRONG figure is not.
 */
// Version-DERIVED, never hardcoded: the four truth documents are renamed
// at each release (…_v0.6.0-alpha.3 → …_v0.6.0), and a hardcoded list silently
// went stale at the stable promotion — the lint then skipped every renamed
// file (existsSync → continue) and passed while checking nothing. Reading the
// version from package.json ties the list to what actually ships, and the
// zero-documents guard below turns a vacuous pass into a failure.
const VERSION = JSON.parse(read('package.json')).version;
const DOCS = [
  `REPRODUCIBILITY_v${VERSION}.md`,
  `VALIDATION_REPORT_v${VERSION}.md`,
  `READINESS_REPORT_v${VERSION}.md`,
  `KNOWN_LIMITATIONS_v${VERSION}.md`,
  `RELEASE_NOTES_v${VERSION}.md`,
  'ARTIFACT_EVALUATION.md',
];
if (DOCS.every((d) => !existsSync(resolve(ROOT, d)))) {
  problems.push(
    `no release evidence documents exist for v${VERSION} — the figure guard would pass vacuously. Expected at least one of: ${DOCS.join(', ')}.`,
  );
}

const parseCount = (s) => Number(s.replace(/,/g, ''));

for (const doc of DOCS) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  const text = read(doc);

  for (const [bucket, counts] of Object.entries(evidence.buckets)) {
    // "Unit 2,927" / "unit 2,927 passed" / "· export 598 ·"
    const re = new RegExp(`\\b${bucket}\\s+(\\d{1,3}(?:,\\d{3})*|\\d+)\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      const claimed = parseCount(m[1]);
      if (claimed !== counts.passed) {
        problems.push(
          `${doc}: "${m[0]}" — the ${bucket} bucket ran ${n(counts.passed)} passed. Figures come from ${EVIDENCE}; do not type them in.`,
        );
      }
    }
  }

  // Every "N passed / M skipped", classified by what precedes it.
  //
  // The e2e suite prints its own "161 passed / 4 skipped" and is skipped by
  // context. A per-bucket figure — "unit 3,017 passed / 16 skipped" — is
  // validated against THAT bucket; anything else is the gate total. An earlier
  // version skipped any line that merely CONTAINED a bucket name, which let a
  // stale total ride along on the same line as the (correct) per-bucket counts
  // — "unit 3,017 (16 skipped) · … — 5,703 passed / 34 skipped" passed while
  // the total was wrong. Classifying each match by its preceding token catches
  // both a wrong total and a wrong per-bucket figure, without crying wolf.
  const bucketNames = Object.keys(evidence.buckets);
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/(\d{1,3}(?:,\d{3})*)\s+passed\s*\/\s*(\d+)\s+skipped/g)) {
      const passed = parseCount(m[1]);
      const skipped = parseCount(m[2]);
      // Classify by the ~28 chars before the number, not by the whole line — a
      // gate total and the e2e figure can share one line, and skipping the line
      // for e2e context used to hide the total that rode along with it.
      const before = line.slice(Math.max(0, m.index - 28), m.index);
      // The e2e suite has its own passed/skipped and is not the gate total.
      if (/e2e|playwright|deterministic|gpu/i.test(before)) continue;
      const bucket = bucketNames.find((b) => new RegExp(`\\b${b}\\b[^\\w]*$`, 'i').test(before));
      const expected = bucket
        ? { passed: evidence.buckets[bucket].passed, skipped: evidence.buckets[bucket].skipped, label: bucket }
        : { passed: evidence.total.passed, skipped: evidence.total.skipped, label: 'gate total' };
      if (passed !== expected.passed || skipped !== expected.skipped) {
        problems.push(
          `${doc}: "${m[0]}" — the ${expected.label} ran ${n(expected.passed)} passed / ${expected.skipped} skipped.`,
        );
      }
    }
  }
}

// The live entry size, wherever a document states one. Three documents said
// 699 KiB for a build that produced 715 — the same defect as the test counts,
// in a different figure, found by the same reviewer.
if (evidence.bundle?.liveEntryKiB) {
  const actual = evidence.bundle.liveEntryKiB;
  for (const doc of DOCS) {
    if (!existsSync(resolve(ROOT, doc))) continue;
    for (const line of read(doc).split('\n')) {
      // Historical notes about a PREVIOUS release legitimately quote its size.
      if (/alpha\.1|grew from|cutting the live entry|from 792/i.test(line)) continue;
      for (const m of line.matchAll(/(\d{3,4})\s*KiB/g)) {
        const v = Number(m[1]);
        // Only judge numbers claiming to BE the live entry, not the ceiling,
        // the warning line, or another chunk's budget.
        if (!/live entry/i.test(line)) continue;
        if (v !== actual && v !== evidence.bundle.ceilingKiB && v !== 680) {
          problems.push(
            `${doc}: "${m[0]}" — the live build produced ${actual} KiB. Figures come from ${EVIDENCE}.`,
          );
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('lint:evidence FAILED\n');
  console.error('Published test figures disagree with the recorded gate run:');
  for (const p of problems) console.error(`  • ${p}`);
  console.error(`\nRe-run "npm run evidence" after a passing gate, then correct the documents from ${EVIDENCE}.`);
  process.exit(1);
}

console.log(
  `lint:evidence OK — documents match ${EVIDENCE} (${n(evidence.total.passed)} passed / ${evidence.total.skipped} skipped at ${evidence.commit?.slice(0, 7) ?? 'unknown commit'}).`,
);
