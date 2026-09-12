/**
 * repoFiles.ts — the repository's file list, in a checkout OR in an extracted
 * source archive.
 *
 * Several tests assert things about the files this project distributes, and
 * reached for `git ls-files` to enumerate them. That throws in the published
 * source archive, which carries no `.git`, so a reviewer verifying the zip the
 * way REPRODUCIBILITY.md describes met a wall of failures that said nothing
 * about the product: 12 in the curated-locations licence check, one in the
 * tool-path check.
 *
 * The scripts under `scripts/` already solved this and state the reasoning —
 * `lint-no-host-paths.mjs`: "a check that cannot run must not report success —
 * but an archive's files ARE the shipped set, so the walk below scans exactly
 * what the archive ships and the verdict stays earned." Same rule here, written
 * once instead of a third and fourth time.
 *
 * This is deliberately NOT a git fixture. Initialising history inside a user's
 * extracted source just to turn a gate green would make the check pass by
 * changing the thing under test.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { binaryOnPath } from '../../scripts/lib/binaryOnPath.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Absolute path to git, or null where it is absent — an extracted archive on a
 * machine without it. Spawning by bare name lets whatever PATH holds decide
 * which program runs; scripts/lib/binaryOnPath.mjs states the reasoning and
 * every script here already goes through it.
 */
const GIT: string | null = binaryOnPath('git');

/** Directories a walk must not enter: never tracked, or generated. */
const WALK_SKIP = new Set([
  '.git', 'node_modules', 'dist', 'release', 'test-results',
  'coverage', 'playwright-report', '.claude', '.venv', '__pycache__',
]);

/** True when this process is inside a git work tree. */
export function hasGitRepo(): boolean {
  if (GIT === null) return false;
  try {
    execFileSync(GIT, ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function walkFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(resolve(ROOT, rel === '' ? '.' : rel), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || WALK_SKIP.has(entry.name)) continue;
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk('');
  return out;
}

/**
 * Every distributed file, as repo-root-relative POSIX paths.
 *
 * Prefers `git ls-files` in a checkout, because that is the authoritative set
 * and excludes untracked scratch. Falls back to a filesystem walk when git is
 * absent or fails, which is what an extracted archive gets — and there the walk
 * IS the shipped set, so the assertions stay meaningful rather than skipped.
 */
export function distributedFiles(): string[] {
  if (GIT === null) return walkFiles();
  try {
    return execFileSync(GIT, ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '');
  } catch {
    return walkFiles();
  }
}
