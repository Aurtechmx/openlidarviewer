/**
 * releasePackagingNoGit.test.ts — the rsync fallback ships the tracked
 * `release/` documents.
 *
 * When the source tree has no `.git`, `package.sh` enumerates with rsync
 * instead of `git archive`. Its exclusion list is what keeps generated output
 * (the root `release/` zips, coverage, Playwright traces) out of the archive,
 * and `--exclude 'release'` is unanchored: rsync matches that against every
 * path segment, so `docs/release/` and the three `validation/snapshot/evidence/
 * .../release/` records were dropped too. Five tracked files, among them the
 * archive-portability and build-identity snapshot evidence — the material the
 * project's reproducibility claims rest on.
 *
 * The repository's own archives are cut with git present, so no published zip
 * lost them. The fallback is the path someone else takes: re-packaging an
 * extracted source archive, which has no history. That is exactly the
 * reproduction this release asks reviewers to perform.
 *
 * The sibling reproducibility test skips without a repository, so nothing
 * covered this. Here the missing repository is the point: the fixture removes
 * `.git` deliberately.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tracked files that live under a directory named `release`. */
const TRACKED_UNDER_RELEASE = [
  'docs/release/RELEASE_ASSETS.md',
  'docs/release/ERRATUM_v0.6.2.md',
  'validation/snapshot/evidence/archive-portability/release/archive-portability.json',
  'validation/snapshot/evidence/build-identity/release/package-build-metadata-v0.6.2.json',
  'validation/snapshot/evidence/limitations/docs/release/ERRATUM_v0.6.2.md.txt',
];

/**
 * Extract `git archive` of HEAD — the very tree a reviewer downloads — into a
 * workspace with no `.git`, add the generated root `release/` the exclusion
 * exists to drop, then cut a source-only package from it.
 */
function cutWithoutGit(): { work: string; entries: string[] } {
  const work = mkdtempSync(join(tmpdir(), 'olv-nogit-'));
  const tree = join(work, 'tree');
  execFileSync('bash', [
    '-c',
    'mkdir -p "$2" && git -C "$1" archive --format=tar HEAD | tar -x -C "$2" && ' +
      // The script under test is the working tree's, not the one HEAD happens
      // to carry — otherwise a fix to package.sh could not turn this green
      // until after it was committed.
      'cp "$1/scripts/package.sh" "$2/scripts/package.sh" && ' +
      'mkdir -p "$2/release" && echo generated > "$2/release/openlidarviewer-generated.zip"',
    '_', ROOT, tree,
  ], { maxBuffer: 64 * 1024 * 1024 });
  const out = join(work, 'out');
  execFileSync('bash', [join(tree, 'scripts/package.sh'), out, '--source-only'], {
    cwd: tree,
    env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const zip = readdirSync(out).find((n) => /-source-.*\.zip$/.test(n))!;
  const entries = execFileSync('unzip', ['-Z1', join(out, zip)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^openlidarviewer-v[^/]+\//, ''));
  return { work, entries };
}

describe('the no-git packaging fallback', () => {
  it('keeps tracked release documentation and drops only the generated root release/', () => {
    const { work, entries } = cutWithoutGit();
    try {
      for (const f of TRACKED_UNDER_RELEASE) {
        expect(entries, `${f} was dropped by the rsync exclusion`).toContain(f);
      }
      expect(entries.some((e) => e.startsWith('release/'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 300_000);
});
