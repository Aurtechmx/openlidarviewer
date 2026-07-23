/**
 * releasePackagingRepro.test.ts — the same commit packages to the same bytes.
 *
 * Without this, a reviewer who rebuilds the source archive gets a different
 * hash than the published one and has no way to tell whether that is a tooling
 * artefact or a substituted file. Wall-clock names and filesystem mtimes
 * guaranteed a mismatch, so the checksums could only ever prove "this file has
 * not changed since I downloaded it" — never "this is what that commit builds".
 *
 * Scope note: this covers the SOURCE archive, which comes from `git archive` and
 * is fully under our control. The deploy archive is not asserted to be
 * byte-reproducible — the obfuscator is free to vary — and claiming otherwise
 * would be exactly the kind of unverified assertion this suite exists to catch.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Cut a source-only package into a fresh directory; return its zip path. */
function cutSource(epoch: string): { dir: string; zip: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), 'olv-repro-'));
  execFileSync('bash', ['scripts/package.sh', dir, '--source-only'], {
    cwd: ROOT,
    env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const name = readdirSync(dir).find((n) => /-source-.*\.zip$/.test(n))!;
  return { dir, zip: join(dir, name), name };
}

describe('release packaging is reproducible', () => {
  it('produces a byte-identical source archive for the same commit', () => {
    const epoch = execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();

    const a = cutSource(epoch);
    const b = cutSource(epoch);
    try {
      // Same commit, same epoch, same toolchain -> same name and same bytes.
      expect(b.name).toBe(a.name);
      expect(sha(b.zip)).toBe(sha(a.zip));
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('names the archive from the commit timestamp, not the wall clock', () => {
    // A wall-clock name changes between two cuts of one commit, which is what
    // made "rebuild and compare" impossible in the first place.
    const fixed = '1700000000'; // 2023-11-14T22:13:20Z
    const a = cutSource(fixed);
    try {
      expect(a.name).toContain('20231114-2213');
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  }, 120_000);
});
