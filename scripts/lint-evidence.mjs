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
 * So this compares every published figure against `release/test-evidence.json`,
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

const EVIDENCE = 'release/test-evidence.json';
if (!existsSync(resolve(ROOT, EVIDENCE))) {
  console.log(
    `lint:evidence SKIPPED — no ${EVIDENCE}. Run "npm run evidence" to derive it from a passing gate.`,
  );
  process.exit(0);
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

/**
 * Documents that quote the figures, and the bucket each label refers to.
 *
 * The pattern is deliberately narrow — "unit 2,927", "export 598" — so it
 * matches published claims and not incidental prose. A document that mentions
 * no figure at all is fine; one that mentions a WRONG figure is not.
 */
const DOCS = [
  'REPRODUCIBILITY_v0.6.0-alpha.2.md',
  'VALIDATION_REPORT_v0.6.0-alpha.2.md',
  'READINESS_REPORT_v0.6.0-alpha.2.md',
  'KNOWN_LIMITATIONS_v0.6.0-alpha.2.md',
];

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

  // The overall total, however it is phrased — but only where the sentence is
  // about the unit-test gate. The e2e suite reports its own "161 passed / 4
  // skipped" and a per-bucket line can use the same phrasing; flagging those
  // as a wrong gate total would be a false alarm, and a linter that cries
  // wolf gets switched off, which is how the original defect survives.
  for (const line of text.split('\n')) {
    if (/e2e|playwright|deterministic|gpu|fixture-skipped/i.test(line)) continue;
    if (Object.keys(evidence.buckets).some((b) => new RegExp(`\\b${b}\\b`, 'i').test(line))) continue;
    for (const m of line.matchAll(/(\d{1,3}(?:,\d{3})*)\s+passed\s*\/\s*(\d+)\s+skipped/g)) {
      const passed = parseCount(m[1]);
      const skipped = parseCount(m[2]);
      if (passed !== evidence.total.passed || skipped !== evidence.total.skipped) {
        problems.push(
          `${doc}: "${m[0]}" — the gate ran ${n(evidence.total.passed)} passed / ${evidence.total.skipped} skipped.`,
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
