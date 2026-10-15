/**
 * checkCiForSha.test.ts — the release is ready only when CI passed at the tag.
 *
 * The release gate runs Chromium only; the CI workflow's `ci-green` job covers
 * Firefox, WebKit, Windows and the rest. These tests pin the decision the
 * release workflow's `ci-at-tag` job makes from the GitHub API, and that
 * `release-ready` depends on that job.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCiJobs, requiredJobNames, evaluateCiRuns } from '../scripts/check-ci-for-sha.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ciYml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const required = requiredJobNames(parseCiJobs(ciYml));

type Job = { name: string; status: string; conclusion: string | null };
const done = (id: number, conclusion = 'success') => ({ id, status: 'completed', conclusion });
const pass = (names: string[]): Job[] => names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

describe('required job set comes from ci.yml', () => {
  it('is ci-green plus every job ci-green needs, by display name', () => {
    const jobs = parseCiJobs(ciYml);
    expect(required[0]).toBe('ci-green');
    expect(required).toHaveLength(1 + (jobs.get('ci-green')?.needs.length ?? 0));
    for (const id of ['verify', 'e2e-firefox', 'e2e-webkit', 'windows']) expect(required).toContain(id);
    expect(required).toContain('npm audit (runtime deps)');
  });

  it('refuses a workflow without the aggregate job', () => {
    expect(() => requiredJobNames(parseCiJobs('jobs:\n  verify:\n    runs-on: x\n'))).toThrow(/ci-green/);
  });
});

describe('evaluateCiRuns', () => {
  it('missing: no CI run at the commit', () => {
    expect(evaluateCiRuns([], new Map(), required).state).toBe('missing');
  });

  it('ready: every required job succeeded, matrix legs included', () => {
    const jobs = pass(required.filter((n) => n !== 'test')).concat(pass(['test (unit, 1, 2)', 'test (terrain)']));
    expect(evaluateCiRuns([done(1)], new Map([[1, jobs]]), required).state).toBe('ready');
  });

  it('pending: a run is still in progress', () => {
    const r = evaluateCiRuns([{ id: 1, status: 'in_progress', conclusion: null }], new Map(), required);
    expect(r.state).toBe('pending');
  });

  it('failed: ci-green failed', () => {
    const jobs = pass(required).map((j) => (j.name === 'ci-green' ? { ...j, conclusion: 'failure' } : j));
    const r = evaluateCiRuns([done(1, 'failure')], new Map([[1, jobs]]), required);
    expect(r.state).toBe('failed');
    expect(r.detail).toMatch(/ci-green: failure/);
  });

  it('failed: a cancelled run is not ready', () => {
    const jobs = pass(required).map((j) => (j.name === 'e2e-webkit' ? { ...j, conclusion: 'cancelled' } : j));
    expect(evaluateCiRuns([done(1, 'cancelled')], new Map([[1, jobs]]), required).state).toBe('failed');
  });

  it('failed: one matrix leg failing fails the job', () => {
    const jobs = pass(required.filter((n) => n !== 'test')).concat(pass(['test (a)']), [
      { name: 'test (b)', status: 'completed', conclusion: 'failure' },
    ]);
    expect(evaluateCiRuns([done(1)], new Map([[1, jobs]]), required).state).toBe('failed');
  });

  it('failed: a required job absent from the run', () => {
    const jobs = pass(required.filter((n) => n !== 'windows'));
    const r = evaluateCiRuns([done(1)], new Map([[1, jobs]]), required);
    expect(r.state).toBe('failed');
    expect(r.detail).toMatch(/windows: missing/);
  });

  it('ready when any completed run at the commit passed (branch and tag runs)', () => {
    const bad = pass(required).map((j) => (j.name === 'ci-green' ? { ...j, conclusion: 'failure' } : j));
    const r = evaluateCiRuns([done(1, 'failure'), done(2)], new Map([[1, bad], [2, pass(required)]]), required);
    expect(r.state).toBe('ready');
  });
});

describe('release workflow wiring', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const jobs = parseCiJobs(yml);

  it('release-ready needs the CI-at-tag check', () => {
    expect(jobs.get('release-ready')?.needs).toContain('ci-at-tag');
    expect(jobs.get('publish')?.needs).toEqual(['release-ready']);
  });

  it('the CI-at-tag job checks the exact commit with read-only API access', () => {
    const block = yml.slice(yml.indexOf('\n  ci-at-tag:'), yml.indexOf('\n  release-ready:'));
    expect(block).toMatch(/actions: read/);
    expect(block).toMatch(/checks: read/);
    expect(block).not.toMatch(/: write/);
    expect(block).toMatch(/node scripts\/check-ci-for-sha\.mjs/);
    expect(block).toMatch(/--sha "\$\{\{ github\.sha \}\}"|--sha "\$SHA"/);
  });
});
