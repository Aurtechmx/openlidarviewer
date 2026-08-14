/**
 * validateTerrainNeedsInstall.test.ts
 *
 * A clean source archive has no node_modules. `validate:terrain` drives the
 * terrain-field harness through vitest, and it must NOT fetch vitest over the
 * network to do so — an unlocked, externally-obtained tool is exactly what a
 * reproducibility check must avoid. Instead it refuses with a `needs-install`
 * signal that the archive-portability verifier records as an uninstalled
 * dependency (not a failure, not a silent fetch).
 *
 * This runs the real script from a directory with no node_modules and asserts
 * the refusal, and pins that the verifier's needs-install classifier still
 * matches the message it emits.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'validate-terrain.mjs');

describe('validate:terrain refuses to run without the locked vitest', () => {
  it('exits needs-install (not a network fetch) when node_modules is absent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'olv-vt-'));
    try {
      const run = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8', timeout: 60_000 });
      const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      // Refused, not run: non-zero exit and the needs-install signal.
      expect(run.status).not.toBe(0);
      expect(out).toMatch(/needs-install: the locked vitest/);
      // It says how to fix it, and states it will not reach the network.
      expect(out).toMatch(/npm ci/);
      expect(out).toMatch(/will not fetch/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('the archive-portability verifier classifies that message as needs-install', () => {
    // The verifier keys on this substring to record the check as uninstalled
    // rather than failed; keep the two in lock-step.
    const verifier = readFileSync(resolve(__dirname, '..', 'scripts', 'verify-archive-portability.mjs'), 'utf8');
    expect(verifier).toContain('needs-install: the locked vitest');
  });
});
