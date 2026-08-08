#!/usr/bin/env node
/**
 * validate-terrain.mjs — `npm run validate:terrain`.
 *
 * One command that runs OLV's terrain outputs against the committed independent
 * references and prints a single PASS / REVIEW / FAIL verdict. It is an
 * ORCHESTRATOR: it computes no metric of its own. The legs live in the harness
 * test files (`tests/terrainFieldValidation.test.ts`, `terrainBoundary`,
 * `terrainMetrics`, `evidenceMonotonicity`), each `it` is one leg, and each
 * leg's numbers come from the real terrain core and the shared comparators. This
 * file runs those legs through vitest's JSON reporter, maps each to a
 * `LegResult`, and rolls them up by the SAME rule as
 * `src/validation/terrainReport.ts` (the source of truth): FAIL if any leg
 * failed, PASS only when every leg ran and passed, REVIEW otherwise (a skipped
 * leg means its reference/fixture was absent, so that check did not run and full
 * coverage cannot be claimed).
 *
 * Exit code: 0 on PASS or REVIEW, 1 on FAIL — so CI reds on a real disagreement
 * but not on a checkout that is simply missing an optional fixture.
 *
 * --json      print the report as JSON instead of text
 * --out PATH  also write the JSON report to PATH
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MARK = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' };

const HARNESS_FILES = [
  'tests/terrainFieldValidation.test.ts',
  'tests/marshIslandCheckpoints.test.ts',
  'tests/terrainBoundary.test.ts',
  'tests/terrainBoundaryReal.test.ts',
  'tests/terrainPipelineBenchmark.test.ts',
  'tests/terrainMetrics.test.ts',
  'tests/terrainPerturbation.test.ts',
  'tests/terrainVerticalNoise.test.ts',
  'tests/terrainXYJitter.test.ts',
  'tests/terrainClassDegradation.test.ts',
  'tests/slopeAspectSpotCheck.test.ts',
  'tests/contourSupportPreservation.test.ts',
  'tests/terrainStudyRerun.test.ts',
  'tests/terrainCompleteness.test.ts',
  'tests/evidenceMonotonicity.test.ts',
  'tests/coverageMonotonicityChain.test.ts',
  'tests/processPlanInvariants.test.ts',
  'tests/processPlanCounterfactualMatrix.test.ts',
  'tests/failClosedCounterfactuals.test.ts',
  'tests/evidenceReEval.test.ts',
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

// Run the harness. vitest's JSON reporter writes the machine result to a file;
// stdout still carries the legs' console.log metric lines, which we fold in as
// each leg's detail.
const jsonOut = resolve('release', 'terrain-validation.vitest.json');
const run = spawnSync(
  'npx',
  ['vitest', 'run', ...HARNESS_FILES, '--reporter=json', '--outputFile', jsonOut, '--reporter=dot'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

let vitest;
try {
  vitest = JSON.parse(readFileSync(jsonOut, 'utf8'));
} catch (err) {
  process.stderr.write(`validate:terrain — could not read vitest result: ${err.message}\n`);
  process.stderr.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  process.exit(2);
}

// Metric lines the legs logged, keyed loosely so we can attach them as detail.
const metricLines = (run.stdout ?? '')
  .split('\n')
  .filter((l) => l.includes('[terrain-field]') || l.includes('[terrain-boundary]') || l.includes('[terrain-boundary-real]') || l.includes('[terrain-pipeline]'))
  .map((l) => l.replace(/^.*\[(terrain-field|terrain-boundary-real|terrain-boundary|terrain-pipeline)\]\s*/, '').trim());

const legs = [];
for (const file of vitest.testResults ?? []) {
  for (const t of file.assertionResults ?? []) {
    const status = t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : 'skipped';
    const title = t.title ?? t.fullName ?? 'unnamed leg';
    const detail = pickMetric(title, metricLines);
    legs.push({ id: slug(t.fullName ?? title), title, status, detail });
  }
}

const report = buildReport(legs, new Date().toISOString());
// Completeness (quick-win 10): vitest reports skipped legs too, so every
// DECLARED leg is present. The universe is complete only when none were skipped
// — running every leg that ran is not the same as running every leg declared.
report.completeness = {
  expected: legs.length,
  executed: legs.filter((l) => l.status !== 'skipped').length,
  passed: report.summary.passed,
  failed: report.summary.failed,
  skipped: report.summary.skipped,
  validationUniverseComplete: report.summary.skipped === 0 && legs.length > 0,
};

if (outPath) writeFileSync(resolve(outPath), JSON.stringify(report, null, 2) + '\n');

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  process.stdout.write(renderReport(report) + '\n');
}

process.exit(report.verdict === 'FAIL' ? 1 : 0);

// ── helpers ────────────────────────────────────────────────────────────────

/** Roll up by the exact rule in src/validation/terrainReport.ts. */
function rollupVerdict(ls) {
  if (ls.some((l) => l.status === 'fail')) return 'FAIL';
  if (ls.length > 0 && ls.every((l) => l.status === 'pass')) return 'PASS';
  return 'REVIEW';
}

function buildReport(ls, generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    verdict: rollupVerdict(ls),
    legs: ls,
    summary: {
      total: ls.length,
      passed: ls.filter((l) => l.status === 'pass').length,
      failed: ls.filter((l) => l.status === 'fail').length,
      skipped: ls.filter((l) => l.status === 'skipped').length,
    },
  };
}

function renderReport(report) {
  const lines = [];
  lines.push('Terrain validation — OLV terrain outputs vs independent references');
  lines.push('='.repeat(66));
  for (const leg of report.legs) {
    const head = `  [${MARK[leg.status]}] ${leg.title}`;
    lines.push(leg.detail ? `${head}\n         ${leg.detail}` : head);
  }
  lines.push('-'.repeat(66));
  const s = report.summary;
  lines.push(`  ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped of ${s.total}`);
  if (report.completeness) {
    const c = report.completeness;
    lines.push(`  COMPLETENESS: ${c.executed}/${c.expected} declared legs executed — validationUniverseComplete: ${c.validationUniverseComplete}`);
  }
  lines.push(`  VERDICT: ${report.verdict}`);
  if (report.verdict === 'REVIEW' && s.skipped > 0) {
    lines.push(`  (REVIEW: ${s.skipped} leg(s) skipped — their reference or crop fixture was absent,`);
    lines.push('   so those checks did not run. Full coverage is required for PASS.)');
  }
  return lines.join('\n');
}

/**
 * Attach the metric line whose leading token set overlaps the leg title, and
 * CONSUME it — the legs log in file order, and two legs (the White Sands and
 * StREAM DTM checks) share the same `OLV vs scipy point-in-cell:` prefix, so
 * removing the matched line hands the second occurrence to the second leg
 * instead of repeating the first leg's numbers.
 */
function pickMetric(title, lines) {
  const t = title.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].split(':')[0].toLowerCase();
    if (key && (t.includes(key) || key.split(/\s+/).some((w) => w.length > 4 && t.includes(w)))) {
      return lines.splice(i, 1)[0];
    }
  }
  return undefined;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
