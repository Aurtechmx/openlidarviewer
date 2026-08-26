#!/usr/bin/env node
/**
 * collect-mutation-evidence.mjs — turn a Stryker run into a citable record.
 *
 * The mutation stage no longer runs inside the tag-time gate: it measured
 * three numeric modules and cost about two hours of every release. It runs on
 * a schedule instead, and the release record CITES its result rather than
 * reproducing it. That only works if the citation is checkable, so this writes
 * the score together with the commit it was measured at and the workflow run
 * that produced it. A score with no commit is a number, not evidence.
 *
 * The break threshold is read from stryker.conf.json rather than restated, so
 * the figure the record publishes and the figure the runner enforces cannot
 * drift. This exits non-zero when the score is under it — the schedule must
 * fail loudly on a real regression, not file a report about one.
 *
 *   node scripts/collect-mutation-evidence.mjs \
 *     --report reports/mutation/mutation.json \
 *     --output docs/validation/mutation-evidence.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const GIT = requireBinaryOnPath('git');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Mutants whose status counts toward the score's denominator, per Stryker's definition. */
const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

/**
 * Score a Stryker JSON report the way Stryker itself does: detected over
 * (detected + undetected), with ignored, compile-error and runtime-error
 * mutants excluded from both sides. Recomputing rather than reading the
 * reporter's own summary keeps this honest about which mutants it counted —
 * the counts ship next to the score so a reader can redo the division.
 */
export function scoreReport(report) {
  const tally = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0, errors: 0 };
  for (const file of Object.values(report?.files ?? {})) {
    for (const m of file.mutants ?? []) {
      if (m.status === 'Killed') tally.killed += 1;
      else if (m.status === 'Timeout') tally.timeout += 1;
      else if (m.status === 'Survived') tally.survived += 1;
      else if (m.status === 'NoCoverage') tally.noCoverage += 1;
      else if (m.status === 'Ignored') tally.ignored += 1;
      else tally.errors += 1;
    }
  }
  const detected = tally.killed + tally.timeout;
  const undetected = tally.survived + tally.noCoverage;
  const total = detected + undetected;
  return {
    score: total === 0 ? null : Number(((detected / total) * 100).toFixed(2)),
    mutants: { ...tally, detected, undetected, scored: total },
  };
}

function flagOf(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const reportPath = flagOf(argv, 'report') ?? 'reports/mutation/mutation.json';
  const outPath = flagOf(argv, 'output') ?? 'docs/validation/mutation-evidence.json';
  const ranInThisGate = argv.includes('--in-gate');

  let report;
  try {
    report = JSON.parse(readFileSync(resolve(ROOT, reportPath), 'utf8'));
  } catch (err) {
    console.error(`Cannot read the Stryker report at ${reportPath}: ${err.message}`);
    console.error('Run `npm run mutation` first; its json reporter writes that file.');
    process.exit(1);
  }

  const conf = JSON.parse(readFileSync(resolve(ROOT, 'stryker.conf.json'), 'utf8'));
  const breakAt = conf?.thresholds?.break ?? null;
  const { score, mutants } = scoreReport(report);

  if (score === null) {
    console.error('The report scored no mutants at all. Refusing to publish an empty measurement.');
    process.exit(1);
  }

  let commit = null;
  try {
    commit = execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch { /* handled below: a measurement with no commit is not citable */ }
  if (!commit) {
    console.error('Cannot resolve HEAD. A mutation figure with no commit cannot be cited.');
    process.exit(1);
  }

  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY ?? null;
  const runId = process.env.GITHUB_RUN_ID ?? null;

  const record = {
    schemaVersion: 1,
    project: 'openlidarviewer',
    score,
    break: breakAt,
    mutants,
    mutate: conf?.mutate ?? null,
    commit,
    measuredAt: new Date().toISOString(),
    ranInThisGate,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    workflowRunId: runId,
    workflowRunUrl: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
  };

  const out = resolve(ROOT, outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `mutation score ${score} (break ${breakAt}) — ` +
      `${mutants.detected} detected / ${mutants.scored} scored, ` +
      `${mutants.ignored} ignored, ${mutants.errors} errored`,
  );
  console.log(`written to ${outPath} at ${commit.slice(0, 12)}`);

  // Stryker already breaks on the threshold, so this is a second latch rather
  // than the only one. It exists because the schedule's whole job is to shout:
  // if the runner's own break check is ever loosened or its exit code swallowed
  // by a pipe, a regression must still fail here.
  if (breakAt !== null && score < breakAt) {
    console.error(`Mutation score ${score} is below the break threshold ${breakAt}.`);
    process.exit(1);
  }
}

if (isCliEntry(import.meta.url)) main();
