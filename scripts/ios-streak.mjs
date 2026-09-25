#!/usr/bin/env node
/**
 * ios-streak.mjs: classify recent runs of the iOS simulator workflow and print
 * the streak toward the 20 consecutive passes L13 requires before the leg can
 * block. Classification uses scripts/ios-infra-signatures.json only.
 *
 *   node scripts/ios-streak.mjs [--limit N] [--json]
 *
 * `--limit` is the evaluated window (default 30 completed runs). The 20%
 * INFRASTRUCTURE guard is computed over that window. Runs whose "Set up job"
 * log names a non-Intel (arm64) image are listed as EXCLUDED and do not
 * count: the leg is pinned to macos-26-intel (ledger L13).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRun, compileSignatures, stepLog, runnerImage, exclusionReason, computeStreak, REQUIRED_STREAK } from './lib/iosRunClassifier.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW = 'ios-simulator.yml';

export function loadSignatureList() {
  return JSON.parse(readFileSync(join(HERE, 'ios-infra-signatures.json'), 'utf8'));
}

/** Default gh runner. Returns stdout; throws on a non-zero exit. */
export function ghExec(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Default job-metadata source: the runner image from the job's "Set up job" log. */
export function ghJobMeta(gh) {
  return ({ jobId }) => {
    if (jobId == null) return { image: null };
    try {
      const log = gh(['run', 'view', '--job', String(jobId), '--log']);
      // gh sometimes labels every line of an older job "UNKNOWN STEP"; the
      // set-up header is still the first thing in the log.
      return { image: runnerImage(stepLog(log, 'Set up job')) ?? runnerImage(log.split('\n').slice(0, 40).join('\n')) };
    } catch {
      return { image: null };
    }
  };
}

/**
 * Classify the most recent completed runs, oldest first.
 * @param {{gh?: (args: string[]) => string, jobMeta?: Function, limit?: number, list?: object}} opts
 */
export function evaluate({ gh = ghExec, jobMeta = ghJobMeta(gh), limit = 30, list = loadSignatureList() } = {}) {
  const signatures = compileSignatures(list);
  const runs = JSON.parse(gh([
    'run', 'list', '--workflow', WORKFLOW, '--limit', String(limit * 2),
    '--json', 'databaseId,status,conclusion,createdAt,headBranch',
  ]))
    .filter((r) => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped')
    .slice(0, limit)
    .reverse();

  const classified = runs.map((r) => {
    const view = JSON.parse(gh(['run', 'view', String(r.databaseId), '--json', 'jobs,conclusion']));
    const job = (view.jobs ?? [])[0] ?? { steps: [], conclusion: view.conclusion };
    const base = { id: r.databaseId, createdAt: r.createdAt, branch: r.headBranch };
    const excluded = exclusionReason(jobMeta({ id: r.databaseId, jobId: job.databaseId ?? null }).image);
    if (excluded) return { ...base, verdict: 'EXCLUDED', signature: null, reason: excluded };
    const steps = (job.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion }));
    const failed = r.conclusion !== 'success';
    let logText = '';
    if (failed) {
      try { logText = gh(['run', 'view', String(r.databaseId), '--log-failed']); } catch { logText = ''; }
    }
    const firstFailed = steps.find((s) => s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped');
    if (firstFailed && logText) logText = stepLog(logText, firstFailed.name);
    const c = classifyRun(
      { steps, firstAssertionStep: list.firstAssertionStep, logText, conclusion: job.conclusion ?? r.conclusion },
      signatures,
    );
    return { ...base, ...c };
  });
  return { runs: classified, ...computeStreak(classified) };
}

export function format(result) {
  const lines = result.runs.map((r) =>
    `${r.id}  ${r.createdAt}  ${r.verdict.padEnd(14)}  ${r.reason}`);
  const status = result.unreliable ? 'UNRELIABLE'
    : result.eligibleToBlock ? 'ELIGIBLE TO BLOCK' : 'ADVISORY';
  lines.push('');
  lines.push(`streak ${result.streak}/${REQUIRED_STREAK}  attempts ${result.attempts}  infrastructure ${result.infraCount}` +
    (result.infraRuns.length ? ` (${result.infraRuns.join(', ')})` : '') +
    `  excluded ${result.excludedRuns.length}`);
  lines.push(`leg: ${status}`);
  return lines.join('\n');
}

if (isCliEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--limit');
  const limit = at >= 0 ? Number(argv[at + 1]) : 30;
  if (!Number.isInteger(limit) || limit < 1) { console.error('--limit must be a positive integer'); process.exit(2); }
  const result = evaluate({ limit });
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : format(result));
}
