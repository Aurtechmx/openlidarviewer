/**
 * git searches the working directory and then every parent. A source archive
 * extracted below an unrelated checkout took that checkout's commit as its own
 * build identity, and history checks read the parent's files. The helper sets
 * GIT_CEILING_DIRECTORIES so git sees only the project's own repository.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error — plain .mjs module, no types
import { confineGitToProject, gitCeilingFor } from '../scripts/lib/confineGit.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'olv-confine-git-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ident = ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false'];
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function repo(dir: string, withCommit: boolean): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  if (withCommit) {
    // The content names the directory, so two repositories never share a commit hash.
    writeFileSync(join(dir, 'a.txt'), dir);
    git(dir, ['add', 'a.txt']);
    git(dir, [...ident, 'commit', '-qm', `commit in ${dir}`]);
  }
  return dir;
}
/** HEAD as git reports it from `root` with the ceiling applied, or 'unknown'. */
function headUnder(root: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: '' };
  confineGitToProject(root, env);
  try {
    return git(root, ['rev-parse', 'HEAD'], env);
  } catch {
    return 'unknown';
  }
}

describe('confineGitToProject', () => {
  it('sets the ceiling to the real path of the directory above the root, keeping existing ones', () => {
    const root = join(base, 'ceiling', 'project');
    mkdirSync(root, { recursive: true });
    const env: NodeJS.ProcessEnv = { GIT_CEILING_DIRECTORIES: '/elsewhere' };
    expect(confineGitToProject(root, env)).toBe(dirname(root));
    expect(env.GIT_CEILING_DIRECTORIES?.split(/[:;]/)).toEqual([dirname(root), '/elsewhere']);
    confineGitToProject(root, env);
    expect(env.GIT_CEILING_DIRECTORIES?.split(/[:;]/)).toEqual([dirname(root), '/elsewhere']);
    expect(gitCeilingFor(root)).toBe(dirname(root));
  });

  it('a plain extraction has no commit', () => {
    const root = join(base, 'plain', 'project');
    mkdirSync(root, { recursive: true });
    expect(headUnder(root)).toBe('unknown');
  });

  it('an extraction inside an unrelated repository with commits does not take its commit', () => {
    const parent = repo(join(base, 'committed-parent'), true);
    const root = join(parent, 'ex', 'project');
    mkdirSync(root, { recursive: true });
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(git(parent, ['rev-parse', 'HEAD'])); // the defect, unconfined
    expect(headUnder(root)).toBe('unknown');
  });

  it('an extraction inside an empty unrelated repository has no commit either', () => {
    const parent = repo(join(base, 'empty-parent'), false);
    const root = join(parent, 'project');
    mkdirSync(root, { recursive: true });
    expect(headUnder(root)).toBe('unknown');
  });

  it('a real checkout, even inside another repository, reports its own commit', () => {
    const outer = repo(join(base, 'outer'), true);
    const root = repo(join(outer, 'project'), true);
    expect(headUnder(root)).toBe(git(root, ['rev-parse', 'HEAD']));
    expect(headUnder(root)).not.toBe(git(outer, ['rev-parse', 'HEAD']));
  });

  it('a worktree, whose .git is a file, reports its own commit', () => {
    const main = repo(join(base, 'main-repo'), true);
    const wt = join(base, 'worktrees', 'project');
    git(main, ['worktree', 'add', '-q', '--detach', wt]);
    expect(headUnder(wt)).toBe(git(main, ['rev-parse', 'HEAD']));
  });
});

describe('every script that runs git confines it first', () => {
  const root = join(dirname(new URL(import.meta.url).pathname), '..');
  const RUNS_GIT = /execFileSync\((GIT|'git'|gitPath)|spawnSync\((GIT|'git')|execSync\(['`"]git /;
  const scripts = execFileSync('git', ['ls-files', 'scripts/*.mjs', 'vite.config.ts'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('scripts/lib/'));

  it.each(scripts.filter((f) => f === 'vite.config.ts' || RUNS_GIT.test(readFileSync(join(root, f), 'utf8'))))('%s', (f) => {
    const text = readFileSync(join(root, f), 'utf8');
    const firstImport = /^import .*$/m.exec(text)?.[0];
    expect(firstImport).toMatch(/^import '\.\/(scripts\/)?lib\/confineGit\.mjs';$/);
  });
});
