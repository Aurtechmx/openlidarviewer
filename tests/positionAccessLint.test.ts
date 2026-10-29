/**
 * positionAccessLint.test.ts: scripts/lint-position-access.mjs only writes its
 * baseline and frames files when asked to with --update. A missing file fails
 * the lint instead of being regenerated silently.
 *
 * Every case points --baseline and --frames at copies in a temporary folder;
 * the committed files are only read.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/position-access-baseline.json');
const FRAMES = resolve(ROOT, 'docs/validation/position-frames.json');

const runLint = (baseline: string, frames: string, ...extra: string[]) =>
  spawnSync('node', ['scripts/lint-position-access.mjs', ...extra, '--baseline', baseline, '--frames', frames], {
    cwd: ROOT,
    encoding: 'utf8',
  });

function inTempDir(body: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'olv-position-access-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('lint:position-access', () => {
  it('passes on copies of the committed baseline and frames', () => {
    inTempDir((dir) => {
      const b = join(dir, 'baseline.json');
      const f = join(dir, 'frames.json');
      copyFileSync(BASELINE, b);
      copyFileSync(FRAMES, f);
      const r = runLint(b, f);
      expect(r.stdout + r.stderr).toContain('lint:position-access OK');
      expect(r.status).toBe(0);
      expect(readFileSync(b, 'utf8')).toBe(readFileSync(BASELINE, 'utf8'));
      expect(readFileSync(f, 'utf8')).toBe(readFileSync(FRAMES, 'utf8'));
    });
  });

  it('fails without writing anything when the baseline is missing', () => {
    inTempDir((dir) => {
      const b = join(dir, 'baseline.json');
      const f = join(dir, 'frames.json');
      copyFileSync(FRAMES, f);
      const r = runLint(b, f);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('missing');
      expect(r.stderr).toContain('--update');
      expect(existsSync(b)).toBe(false);
      expect(readFileSync(f, 'utf8')).toBe(readFileSync(FRAMES, 'utf8'));
    });
  });

  it('fails without writing anything when the frames file is missing', () => {
    inTempDir((dir) => {
      const b = join(dir, 'baseline.json');
      const f = join(dir, 'frames.json');
      copyFileSync(BASELINE, b);
      const r = runLint(b, f);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('missing');
      expect(existsSync(f)).toBe(false);
      expect(readFileSync(b, 'utf8')).toBe(readFileSync(BASELINE, 'utf8'));
    });
  });

  it('writes both files with --update', () => {
    inTempDir((dir) => {
      const b = join(dir, 'baseline.json');
      const f = join(dir, 'frames.json');
      const r = runLint(b, f, '--update');
      expect(r.status).toBe(0);
      expect(existsSync(b)).toBe(true);
      expect(existsSync(f)).toBe(true);
      expect(JSON.parse(readFileSync(b, 'utf8')).total).toBeLessThanOrEqual(JSON.parse(readFileSync(BASELINE, 'utf8')).total);
      expect(JSON.parse(readFileSync(f, 'utf8')).entries.length).toBeGreaterThan(0);
    });
  });

  it('rejects --baseline with no file', () => {
    const r = spawnSync('node', ['scripts/lint-position-access.mjs', '--baseline'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
