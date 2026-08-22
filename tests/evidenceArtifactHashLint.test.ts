/**
 * evidenceArtifactHashLint.test.ts — lint:evidence binds the record to the
 * artefacts on disk.
 *
 * docs/validation/test-evidence.json records `packageLockSha256` and
 * `sbom.sha256`, and the release manifest copies both. Nothing compared them
 * against the files, so a record naming a different dependency tree than the
 * repository ships passed the lint. These tests drive the comparison over
 * constructed records and stub file bytes, and one case asserts the real
 * script prints the artefact line so the check cannot come unwired.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs helper, no types
import { collectArtifactHashProblems } from '../scripts/lib/evidenceArtifactHashes.mjs';
// @ts-expect-error — plain .mjs helper, no types
import { commitDriftNote, resolveHeadCommit } from '../scripts/lib/evidenceCommitNote.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const LOCK_BODY = '{"name":"fixture","lockfileVersion":3}\n';
const SBOM_BODY = '{"bomFormat":"CycloneDX","components":[]}\n';
const LOCK_SHA = sha256(LOCK_BODY);
const SBOM_SHA = sha256(SBOM_BODY);

type Result = { problems: string[]; notes: string[]; checked: string[] };

/** A schemaVersion 3 record carrying both artefact digests. */
const recordWith = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 3,
  packageLockSha256: LOCK_SHA,
  sbom: { sha256: SBOM_SHA },
  ...over,
});

/** Stub disk: only the files named here exist. */
const diskOf =
  (files: Record<string, string>) =>
  (p: string): Buffer | null =>
    Object.hasOwn(files, p) ? Buffer.from(files[p]!) : null;

const BOTH_ON_DISK = {
  'package-lock.json': LOCK_BODY,
  'sbom.json': SBOM_BODY,
};

const run = (evidence: unknown, files: Record<string, string>): Result =>
  collectArtifactHashProblems({ evidence, readBytes: diskOf(files) }) as Result;

describe('lint:evidence artefact digests', () => {
  it('passes when both recorded digests match the files', () => {
    const r = run(recordWith(), BOTH_ON_DISK);
    expect(r.problems).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.checked).toHaveLength(2);
  });

  it('fails a packageLockSha256 that disagrees with the lockfile, naming both digests', () => {
    const stale = 'a'.repeat(64);
    const r = run(recordWith({ packageLockSha256: stale }), BOTH_ON_DISK);
    expect(r.problems).toHaveLength(1);
    // The field, the recorded digest and the real one all have to be readable
    // in the message, or a stale record cannot be diagnosed from a CI log.
    expect(r.problems[0]).toContain('packageLockSha256');
    expect(r.problems[0]).toContain(stale);
    expect(r.problems[0]).toContain(LOCK_SHA);
    expect(r.problems[0]).toContain('package-lock.json');
  });

  it('fails an sbom.sha256 that disagrees with sbom.json', () => {
    const stale = 'b'.repeat(64);
    const r = run(recordWith({ sbom: { sha256: stale } }), BOTH_ON_DISK);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('sbom.sha256');
    expect(r.problems[0]).toContain(stale);
    expect(r.problems[0]).toContain(SBOM_SHA);
  });

  it('reports both artefacts when both disagree', () => {
    const r = run(
      recordWith({ packageLockSha256: 'c'.repeat(64), sbom: { sha256: 'd'.repeat(64) } }),
      BOTH_ON_DISK,
    );
    expect(r.problems).toHaveLength(2);
    expect(r.checked).toEqual([]);
  });

  it('fails a recorded digest whose file is absent from the tree', () => {
    const r = run(recordWith(), { 'sbom.json': SBOM_BODY });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('package-lock.json');
    expect(r.problems[0]).toContain('not present');
  });

  it('fails a record that omits the field while the file exists', () => {
    // The fail-open shape: an absent hash agreeing with everything. The
    // message carries the schema version so a stale record is diagnosable,
    // but absence never passes.
    const r = run(recordWith({ schemaVersion: 2, packageLockSha256: undefined }), BOTH_ON_DISK);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('packageLockSha256');
    expect(r.problems[0]).toContain('2');
    expect(r.notes).toEqual([]);
  });

  it('fails a null field the same way as a missing one', () => {
    const r = run(recordWith({ sbom: null }), BOTH_ON_DISK);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('sbom.sha256');
  });

  it('reports not-applicable, without a problem, when neither record nor file has it', () => {
    const r = run(recordWith({ sbom: null }), { 'package-lock.json': LOCK_BODY });
    expect(r.problems).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain('sbom.sha256');
    expect(r.checked).toEqual(['packageLockSha256 = ' + LOCK_SHA]);
  });

  it('fails a value that is not a sha256 digest', () => {
    const r = run(recordWith({ packageLockSha256: 'b68402f7' }), BOTH_ON_DISK);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('not a sha256 digest');
  });

  it('binds the committed record to the committed artefacts', () => {
    // No digest is written down here. Regenerating package-lock.json or
    // sbom.json without re-running "npm run evidence" fails this, which is the
    // condition the lint exists to report.
    const evidence = JSON.parse(readFileSync(resolve(ROOT, 'docs/validation/test-evidence.json'), 'utf8'));
    const readBytes = (p: string): Buffer | null =>
      existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p)) : null;
    const r = collectArtifactHashProblems({ evidence, readBytes }) as Result;
    expect(
      r.problems,
      'the tracked evidence record no longer matches the artefacts on disk; re-run "npm run evidence"',
    ).toEqual([]);
  });

  it('is wired into scripts/lint-evidence.mjs', () => {
    // Without this the comparison can be correct and never run.
    const proc = spawnSync('node', ['scripts/lint-evidence.mjs'], { cwd: ROOT, encoding: 'utf8' });
    const out = proc.stdout + proc.stderr;
    expect(out).toMatch(/packageLockSha256/);
    expect(out).toMatch(/sbom\.sha256/);
  });
});

describe('lint:evidence commit drift note', () => {
  const HEAD_A = '1'.repeat(40);
  const HEAD_B = '2'.repeat(40);
  const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    commit: HEAD_A,
    releaseChannel: 'development',
    releaseAuthoritative: false,
    ...over,
  });
  const note = (evidence: unknown, head: string | null): string =>
    commitDriftNote({ evidence, head }) as string;

  it('states the match positively when the record describes this checkout', () => {
    const n = note(record(), HEAD_A);
    expect(n).toContain('equals HEAD');
    expect(n).toContain('describes this checkout');
    expect(n).toContain('releaseChannel development');
    expect(n).toContain('releaseAuthoritative false');
  });

  it('prints both shas when the record describes another commit', () => {
    const n = note(record(), HEAD_B);
    expect(n).toContain(HEAD_A);
    expect(n).toContain(HEAD_B);
    expect(n).toContain('differs from HEAD');
    expect(n).toContain('releaseChannel development');
    expect(n).toContain('releaseAuthoritative false');
  });

  it('carries the channel and authoritative flag for a release record', () => {
    const n = note(record({ releaseChannel: 'release', releaseAuthoritative: true }), HEAD_B);
    expect(n).toContain('releaseChannel release');
    expect(n).toContain('releaseAuthoritative true');
  });

  it('says the drift was not checked when HEAD is unresolvable', () => {
    const n = note(record(), null);
    expect(n).toContain('HEAD could not be resolved');
    expect(n).toContain('not checked');
    expect(n).toContain('releaseChannel development');
  });

  it('handles a record with no usable commit', () => {
    const n = note(record({ commit: null }), HEAD_A);
    expect(n).toContain('not a full sha');
    expect(n).toContain('not checked');
  });

  it('resolves HEAD to null with no git binary', () => {
    // The extracted source archive is verified outside any repository.
    expect(resolveHeadCommit({ gitPath: null, cwd: ROOT })).toBeNull();
  });

  it('resolves HEAD to null when rev-parse fails outside a repository', () => {
    const throwing = () => {
      throw new Error('fatal: not a git repository');
    };
    expect(resolveHeadCommit({ gitPath: '/usr/bin/git', cwd: ROOT, run: throwing })).toBeNull();
  });

  it('resolves HEAD to null when rev-parse returns nothing usable', () => {
    expect(resolveHeadCommit({ gitPath: '/usr/bin/git', cwd: ROOT, run: () => '' })).toBeNull();
    expect(resolveHeadCommit({ gitPath: '/usr/bin/git', cwd: ROOT, run: () => 'HEAD' })).toBeNull();
  });

  it('resolves HEAD to null through the real spawn path when git is not there', () => {
    // No injected stub: this exercises the actual execFileSync and its catch,
    // which is what runs in a tree the archive verifier extracted.
    expect(resolveHeadCommit({ gitPath: '/nonexistent/git', cwd: ROOT })).toBeNull();
  });

  it('returns the sha rev-parse prints', () => {
    expect(resolveHeadCommit({ gitPath: '/usr/bin/git', cwd: ROOT, run: () => `${HEAD_A}\n` })).toBe(HEAD_A);
  });

  it('never changes the exit code of a passing lint', () => {
    // The note prints on a green run; the run stays green.
    const proc = spawnSync('node', ['scripts/lint-evidence.mjs'], { cwd: ROOT, encoding: 'utf8' });
    expect(proc.stdout).toMatch(/lint:evidence note — evidence commit /);
    expect(proc.stdout).toMatch(/releaseChannel .+, releaseAuthoritative /);
    expect(proc.status).toBe(0);
  });
});
