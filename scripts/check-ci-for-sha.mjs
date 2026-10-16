#!/usr/bin/env node
/**
 * check-ci-for-sha.mjs
 *
 * The release gate runs the deterministic Chromium project only. Firefox,
 * WebKit, Windows and the other blocking legs run in the CI workflow, whose
 * `ci-green` job is the single required check. A release is ready only when
 * that CI workflow passed for the exact commit being released, so this script
 * asks the GitHub API for the push-event CI runs at that commit (the branch
 * push and the tag push; pull-request and manually dispatched runs are not
 * counted) and decides:
 *
 *   ready    a completed CI run at the SHA whose `ci-green` job and every job
 *            `ci-green` needs concluded `success`
 *   pending  a CI run at the SHA has not completed yet (polled until a bound)
 *   failed   every completed CI run at the SHA has a required job that is
 *            missing, cancelled, skipped or failed
 *   missing  no CI run exists at the SHA
 *
 * Only `ready` exits 0. The required job set is read from the checked-out
 * `.github/workflows/ci.yml` (the `needs` of `ci-green`), so it cannot drift
 * from the workflow it describes. API calls go through `gh api`, which reads
 * GH_TOKEN from the environment.
 *
 * Usage:
 *   node scripts/check-ci-for-sha.mjs --repo OWNER/NAME --sha <40-hex>
 *     [--workflow ci.yml] [--timeout-minutes 120] [--interval-seconds 60]
 *     [--missing-grace-minutes 15]
 *
 * A missing run is polled for the grace period only (the tag push starts CI
 * and the release workflow together, so CI may not be listed yet); a pending
 * run is polled until the timeout. Either one still unresolved then fails.
 * A failed `gh api` call inside the loop is retried after a short wait, up to
 * MAX_API_ATTEMPTS consecutive failures, so one transient network or
 * rate-limit error does not decide the release.
 *
 * The decision logic is pure (parseCiJobs, requiredJobNames, evaluateCiRuns,
 * runsQuery) and the polling loop (pollCi) takes its API call, clock and sleep
 * as arguments, so tests/checkCiForSha.test.ts covers both without the network.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';

const AGGREGATE_JOB = 'ci-green';

/** Consecutive failed API calls the polling loop tolerates before it gives up. */
export const MAX_API_ATTEMPTS = 3;

/** Wait before retrying a failed API call, in milliseconds. */
export const API_RETRY_DELAY_MS = 10_000;

/**
 * Read the top-level jobs of a workflow file: id, optional display `name`, and
 * `needs` as a list. A line-based reader, enough for this repository's
 * two-space-indented workflows; it is not a general YAML parser.
 * @param {string} yml
 * @returns {Map<string, { name: string | null, needs: string[] }>}
 */
export function parseCiJobs(yml) {
  const jobs = new Map();
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return jobs;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs map
    const job = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (job) {
      current = { name: null, needs: [] };
      jobs.set(job[1], current);
      continue;
    }
    if (!current) continue;
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (name) current.name = name[1].replace(/^(['"])(.*)\1$/, '$2');
    const needs = /^ {4}needs:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (needs) {
      const v = needs[1];
      current.needs = (v.startsWith('[') ? v.slice(1, -1).split(',') : [v])
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return jobs;
}

/**
 * The display names of the jobs a ready CI run must have passed: the
 * aggregate job and every job it needs. A job without a `name` is shown under
 * its id; a matrix leg is shown as "<name> (<matrix values>)".
 * @param {Map<string, { name: string | null, needs: string[] }>} jobs
 * @returns {string[]}
 */
export function requiredJobNames(jobs) {
  const agg = jobs.get(AGGREGATE_JOB);
  if (!agg) throw new Error(`ci.yml has no "${AGGREGATE_JOB}" job`);
  if (agg.needs.length === 0) throw new Error(`"${AGGREGATE_JOB}" in ci.yml needs no jobs`);
  return [AGGREGATE_JOB, ...agg.needs].map((id) => {
    const j = jobs.get(id);
    if (!j) throw new Error(`"${AGGREGATE_JOB}" needs "${id}", which ci.yml does not define`);
    return j.name ?? id;
  });
}

/** Does an API job name belong to the required display name (matrix legs included)? */
function jobMatches(apiName, displayName) {
  return apiName === displayName || apiName.startsWith(`${displayName} (`);
}

/**
 * Decide readiness from the CI runs at one SHA.
 * @param {{ id: number, status: string, conclusion: string | null, html_url?: string }[]} runs
 * @param {Map<number, { name: string, status: string, conclusion: string | null }[]>} jobsByRun
 * @param {string[]} required display names from requiredJobNames
 * @returns {{ state: 'ready' | 'pending' | 'failed' | 'missing', detail: string }}
 */
export function evaluateCiRuns(runs, jobsByRun, required) {
  if (runs.length === 0) return { state: 'missing', detail: 'no CI run exists for this commit' };
  const problems = [];
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    const jobs = jobsByRun.get(run.id) ?? [];
    const bad = [];
    for (const want of required) {
      const legs = jobs.filter((j) => jobMatches(j.name, want));
      if (legs.length === 0) bad.push(`${want}: missing`);
      for (const leg of legs) {
        if (leg.conclusion !== 'success') bad.push(`${leg.name}: ${leg.conclusion ?? leg.status}`);
      }
    }
    if (bad.length === 0) return { state: 'ready', detail: `CI run ${run.id} passed every required job` };
    problems.push(`CI run ${run.id} (${run.conclusion ?? run.status}): ${bad.join(', ')}`);
  }
  if (runs.some((r) => r.status !== 'completed')) {
    return { state: 'pending', detail: `CI is still running for this commit${problems.length ? `; ${problems.join('; ')}` : ''}` };
  }
  return { state: 'failed', detail: problems.join('; ') };
}

function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

function ghApi(path) {
  const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * The API path listing a workflow's push-event runs at one commit. Only push
 * runs count: a pull-request run at the same head SHA tested a merge with the
 * base branch, not this commit, and a manual dispatch may run a different
 * workflow file than the one at the commit.
 * @param {string} repo
 * @param {string} workflow
 * @param {string} sha
 */
export function runsQuery(repo, workflow, sha) {
  return `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=100`;
}

function fetchState(repo, workflow, sha, required) {
  const runs = ghApi(runsQuery(repo, workflow, sha)).workflow_runs ?? [];
  const jobsByRun = new Map();
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    jobsByRun.set(run.id, ghApi(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs ?? []);
  }
  return evaluateCiRuns(runs, jobsByRun, required);
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repo = arg(argv, '--repo', process.env.GITHUB_REPOSITORY);
  const sha = arg(argv, '--sha', process.env.GITHUB_SHA);
  const workflow = arg(argv, '--workflow', 'ci.yml');
  const timeoutMs = Number(arg(argv, '--timeout-minutes', '120')) * 60_000;
  const intervalMs = Number(arg(argv, '--interval-seconds', '60')) * 1000;
  const missingGraceMs = Number(arg(argv, '--missing-grace-minutes', '15')) * 60_000;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo OWNER/NAME is required');
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha must be a full 40-character commit SHA');

  const required = requiredJobNames(parseCiJobs(readFileSync(resolve(root, '.github/workflows', workflow), 'utf8')));
  console.log(`Required CI jobs at ${sha}: ${required.join(', ')}`);

  return pollCi({
    sha,
    timeoutMs,
    intervalMs,
    missingGraceMs,
    fetchState: () => fetchState(repo, workflow, sha, required),
  });
}

/**
 * Poll the CI state until it is ready, failed, or out of time, and return the
 * exit code (0 only for ready). A throwing `fetchState` (a failed `gh api`
 * call) is retried after `retryDelayMs`; after `maxAttempts` consecutive
 * failures the last error is reported and the result is 1.
 * @param {{
 *   sha: string,
 *   timeoutMs: number,
 *   intervalMs: number,
 *   missingGraceMs: number,
 *   fetchState: () => { state: string, detail: string } | Promise<{ state: string, detail: string }>,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} opts
 * @returns {Promise<number>}
 */
export async function pollCi(opts) {
  const {
    sha, timeoutMs, intervalMs, missingGraceMs, fetchState: fetch,
    maxAttempts = MAX_API_ATTEMPTS,
    retryDelayMs = API_RETRY_DELAY_MS,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = (line) => console.log(line),
    error = (line) => console.error(line),
  } = opts;
  const started = now();
  const deadline = started + timeoutMs;
  let failures = 0;
  for (;;) {
    let result;
    try {
      result = await fetch();
      failures = 0;
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (failures >= maxAttempts) {
        error(`::error::GitHub API call failed ${failures} times in a row for ${sha}: ${message}`);
        return 1;
      }
      log(`${new Date(now()).toISOString()} API call failed (attempt ${failures} of ${maxAttempts}), retrying: ${message}`);
      await sleep(retryDelayMs);
      continue;
    }
    const { state, detail } = result;
    log(`${new Date(now()).toISOString()} ${state}: ${detail}`);
    if (state === 'ready') return 0;
    if (state === 'failed') {
      error(`::error::CI did not pass for ${sha}: ${detail}`);
      return 1;
    }
    if (state === 'missing' && now() - started >= missingGraceMs) {
      error(`::error::no CI run exists for ${sha} after ${missingGraceMs / 60_000} min`);
      return 1;
    }
    if (now() + intervalMs > deadline) {
      error(`::error::CI for ${sha} is ${state} after waiting ${timeoutMs / 60_000} min: ${detail}`);
      return 1;
    }
    await sleep(intervalMs);
  }
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
