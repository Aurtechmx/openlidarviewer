/**
 * releasePackagingModes.test.ts — the staging copy ends at exactly 0755 / 0644.
 *
 * The archives are what a host serves, so their modes decide whether a deploy
 * works: a directory the server cannot traverse returns 403 for everything
 * inside it. `package.sh` normalises a COPY of the tree before zipping, and it
 * used to do that with numeric `chmod 755` / `chmod 644`, which sets the
 * permission bits and leaves the setuid, setgid and sticky bits as they were.
 * A directory that inherited setgid (2755 is the common case, and it is what a
 * shared build directory hands down) carried that bit into the archive.
 *
 * The normaliser is READ OUT OF `package.sh` and run against a fixture that
 * starts with those bits set, so the function under test is the shipped one.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The shipped `normalise_modes` definition, lifted from the script verbatim. */
function shippedNormaliser(): string {
  const sh = readFileSync(join(ROOT, 'scripts/package.sh'), 'utf8');
  const fn = /normalise_modes\(\)\s*\{[\s\S]*?\n\}/.exec(sh);
  expect(fn, 'package.sh defines normalise_modes').not.toBeNull();
  return fn![0];
}

/** Permission bits, special bits included, as a four-digit octal string. */
const mode = (p: string): string => (statSync(p).mode & 0o7777).toString(8).padStart(4, '0');

describe('package.sh mode normalisation', () => {
  it('clears special bits and lands on 0755 / 0644', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-modes-'));
    try {
      const nested = join(dir, 'assets', 'deep');
      mkdirSync(nested, { recursive: true });
      const file = join(dir, 'assets', 'app.js');
      const script = join(nested, 'tool.sh');
      writeFileSync(file, 'x');
      writeFileSync(script, 'x');
      // What the numeric form left behind: setgid on a directory, setuid and
      // the executable bit on a file, and a file group/other cannot read.
      chmodSync(join(dir, 'assets'), 0o2755);
      chmodSync(nested, 0o2700);
      chmodSync(file, 0o600);
      chmodSync(script, 0o4755);

      execFileSync('bash', ['-c', `${shippedNormaliser()}\nnormalise_modes "${dir}"`]);

      expect(mode(dir)).toBe('0755');
      expect(mode(join(dir, 'assets'))).toBe('0755');
      expect(mode(nested)).toBe('0755');
      expect(mode(file)).toBe('0644');
      expect(mode(script)).toBe('0644');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
