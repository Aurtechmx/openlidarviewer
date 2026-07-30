/**
 * The freeze auditor reads git history, so its unit is a repository, not a
 * function. These build throwaway repositories and assert the two outcomes it
 * exists to separate: a gate committed before the result, and a gate committed
 * with it.
 *
 * Written after two records in one day claimed a tolerance was frozen before
 * the run that produced the result it judged. Both claims were about when a
 * decision was made, not about a number, and nothing checked them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/verify-freeze-claims.mjs');
const HELPER = resolve(__dirname, '../scripts/lib/binaryOnPath.mjs');

function git(cwd: string, ...argv: string[]): void {
  execFileSync('git', argv, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function study(status: string, digest: string) {
  return JSON.stringify({ studyId: 'S1', status, protocolDigest: digest }, null, 2);
}

/** A repository with the script, a studies directory, and git configured. */
function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olv-freeze-'));
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
  mkdirSync(join(dir, 'validation/cross-implementation/studies'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'scripts/verify-freeze-claims.mjs'));
  // The verifier resolves git through the shared helper so it reads PATH with
  // the platform's separator rather than assuming ':'. The throwaway repo needs
  // that sibling too, or the import fails before any assertion runs.
  copyFileSync(HELPER, join(dir, 'scripts/lib/binaryOnPath.mjs'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'scaffold');
  return dir;
}

function run(dir: string): number {
  try {
    execFileSync('node', ['scripts/verify-freeze-claims.mjs'], { cwd: dir, encoding: 'utf8' });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

const PATH = 'validation/cross-implementation/studies/S1.study.json';
const DIGEST = 'sha256:aaaa';

describe('verify-freeze-claims', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it('accepts a gate committed before the result', () => {
    const dir = newRepo();
    dirs.push(dir);
    writeFileSync(join(dir, PATH), study('pending', DIGEST));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'preregister');
    writeFileSync(join(dir, PATH), study('agree', DIGEST));
    git(dir, 'commit', '-aqm', 'result');
    expect(run(dir)).toBe(0);
  });

  it('refuses a gate that arrives with its own result', () => {
    const dir = newRepo();
    dirs.push(dir);
    writeFileSync(join(dir, PATH), study('agree', DIGEST));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'gate and result together');
    expect(run(dir)).toBe(1);
  });

  it('refuses a tolerance that moved between preregistration and result', () => {
    const dir = newRepo();
    dirs.push(dir);
    writeFileSync(join(dir, PATH), study('pending', DIGEST));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'preregister');
    writeFileSync(join(dir, PATH), study('agree', 'sha256:bbbb'));
    git(dir, 'commit', '-aqm', 'result under a different gate');
    expect(run(dir)).toBe(1);
  });

  it('refuses a measured record carrying no digest at all', () => {
    const dir = newRepo();
    dirs.push(dir);
    writeFileSync(
      join(dir, PATH),
      JSON.stringify({ studyId: 'S1', status: 'agree' }, null, 2),
    );
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'no gate');
    expect(run(dir)).toBe(1);
  });

  it('leaves an unmeasured record alone', () => {
    const dir = newRepo();
    dirs.push(dir);
    writeFileSync(join(dir, PATH), study('pending', DIGEST));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'preregister only');
    expect(run(dir)).toBe(0);
  });
});
