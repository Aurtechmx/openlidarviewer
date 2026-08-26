/**
 * cliEntryDetection.test.ts
 *
 * The scripts under scripts/ decide whether to run their CLI body by comparing
 * process.argv[1] against import.meta.url. Those two are not built the same
 * way: the ESM loader has already resolved symlinks by the time it fills in
 * import.meta.url, while argv[1] is the path the caller typed. A comparison
 * that does not resolve both sides is false whenever the invoking path crosses
 * a symlink, and the script then exits 0 having done nothing — a pass that
 * looks identical to a real one.
 *
 * So this spawns a representative gate through a symlinked checkout path and
 * asserts it still reports. Without the guard in scripts/lib/isCliEntry.mjs the
 * stdout assertion fails while the exit code stays 0, which is the whole point.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '../scripts/lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A symlink pointing at the repository root, or null when the platform refuses
 * to make one. Unprivileged Windows cannot create symlinks, and that is a fact
 * about the runner rather than a defect in the guard, so the spawn case is
 * skipped there instead of failing.
 */
function linkedRoot(): { link: string; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'olv-cli-entry-'));
  const link = join(dir, 'checkout');
  try {
    symlinkSync(ROOT, link, 'dir');
    return { link, dir };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

describe('CLI entry detection', () => {
  it('runs a gate invoked through a symlinked checkout path', () => {
    const linked = linkedRoot();
    if (linked === null) return;
    try {
      const script = join(linked.link, 'scripts', 'lint-unsafe-html.mjs');
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('lint:unsafe-html OK');
    } finally {
      rmSync(linked.dir, { recursive: true, force: true });
    }
  });

  it('matches a module reached through a symlink', () => {
    const linked = linkedRoot();
    if (linked === null) return;
    try {
      const viaLink = join(linked.link, 'scripts', 'lint-unsafe-html.mjs');
      const real = join(ROOT, 'scripts', 'lint-unsafe-html.mjs');
      expect(isCliEntry(new URL(`file://${real}`).href, viaLink)).toBe(true);
    } finally {
      rmSync(linked.dir, { recursive: true, force: true });
    }
  });

  it('does not match a different script', () => {
    const self = new URL(`file://${join(ROOT, 'scripts', 'lint-unsafe-html.mjs')}`).href;
    expect(isCliEntry(self, join(ROOT, 'scripts', 'lint-docs-site.mjs'))).toBe(false);
  });

  it('is false when Node was given no script, and does not throw on a missing one', () => {
    const self = new URL(`file://${join(ROOT, 'scripts', 'lint-unsafe-html.mjs')}`).href;
    expect(isCliEntry(self, undefined)).toBe(false);
    expect(isCliEntry(self, join(ROOT, 'scripts', 'does-not-exist.mjs'))).toBe(false);
  });
});
