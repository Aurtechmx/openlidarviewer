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
 * reproduction this release asks reviewers to perform — and it is why this
 * test may not need a repository itself. An earlier version built its fixture
 * with `git archive HEAD`, which fails inside the very archive it covers.
 *
 * So the fixture is synthetic and the exclusions are READ OUT OF `package.sh`:
 * the patterns under test are the shipped ones, and re-unanchoring any of them
 * fails here.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `--exclude` patterns from the rsync fallback in `scripts/package.sh`,
 * parsed from the script itself so this test cannot drift from what ships.
 */
function fallbackExcludes(): string[] {
  const sh = readFileSync(join(ROOT, 'scripts/package.sh'), 'utf8');
  const start = sh.indexOf('rsync -a');
  expect(start, 'no rsync fallback found in scripts/package.sh').toBeGreaterThan(-1);
  const block = sh.slice(start, sh.indexOf('"$TMP/source/$SRC_PREFIX/"', start));
  const out = [...block.matchAll(/--exclude\s+'?([^'\s\\]+)'?/g)].map((m) => m[1]);
  expect(out.length, 'the fallback exclusion list parsed empty').toBeGreaterThan(5);
  return out;
}

/** A tree with a file at each path, directories created as needed. */
function tree(paths: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'olv-nogit-'));
  for (const rel of paths) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), `${rel}\n`);
  }
  return dir;
}

/** Files that live under a directory named `release` and MUST be archived. */
const KEEP = [
  'docs/release/RELEASE_ASSETS.md',
  'docs/release/ERRATUM_v0.6.2.md',
  'validation/snapshot/evidence/archive-portability/release/archive-portability.json',
  'validation/snapshot/evidence/build-identity/release/package-build-metadata-v0.6.2.json',
  'validation/snapshot/evidence/limitations/docs/release/ERRATUM_v0.6.2.md.txt',
];

/** Generated output the exclusions exist to drop. */
const DROP = [
  'release/openlidarviewer-generated.zip',
  'coverage/index.html',
  'test-results/trace.zip',
  'docs-site/.vitepress/dist/index.html',
];

describe('the no-git packaging fallback', () => {
  it('keeps tracked release documentation and drops the generated output', () => {
    const src = tree([...KEEP, ...DROP, 'package.json']);
    const dest = mkdtempSync(join(tmpdir(), 'olv-nogit-out-'));
    try {
      execFileSync('rsync', ['-a', ...fallbackExcludes().flatMap((e) => ['--exclude', e]), './', `${dest}/`], {
        cwd: src,
      });
      for (const f of KEEP) {
        expect(existsSync(join(dest, f)), `${f} was dropped by the rsync exclusions`).toBe(true);
      }
      for (const f of DROP) {
        expect(existsSync(join(dest, f)), `${f} reached the archive`).toBe(false);
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
