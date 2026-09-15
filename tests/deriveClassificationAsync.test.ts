/**
 * deriveClassificationAsync.test.ts
 *
 * Covers the worker-or-fallback bridge (the worker round-trip itself can't run
 * in the sandbox): worker success path, abort-before-compute, the main-thread
 * fallback on worker failure, the compute-path instrumentation, and the
 * measured ceiling above which the fallback is refused instead of freezing the
 * main thread.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  deriveClassificationAsync,
  getLastClassifyComputePath,
  setDeriveClassificationClientFactory,
  MAX_FALLBACK_POINTS,
} from '../src/render/class/deriveClassificationAsync';
import { deriveClassification } from '../src/render/class/deriveClassification';
import { SyncFallbackRefusedError } from '../src/workers/syncFallbackRefusedError';
import type { DeriveClassificationClientLike } from '../src/render/class/deriveClassificationWorkerClient';

/**
 * Counts entries into the REAL classifier, so a refusal can be proven to have
 * classified nothing rather than merely to have thrown. The mock delegates to
 * the original implementation, so every other test runs the real classifier.
 */
const classifyCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/render/class/deriveClassification', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/render/class/deriveClassification')>();
  return {
    ...actual,
    deriveClassification: (...args: Parameters<typeof actual.deriveClassification>) => {
      classifyCalls.n++;
      return actual.deriveClassification(...args);
    },
  };
});

function smallScene(): { positions: Float32Array; n: number } {
  const pts: number[] = [];
  for (let x = 0; x <= 20; x++) for (let y = 0; y <= 20; y++) pts.push(x, y, 0);
  return { positions: new Float32Array(pts), n: pts.length / 3 };
}

beforeEach(() => setDeriveClassificationClientFactory(null));

describe('deriveClassificationAsync', () => {
  // The failing-client fixtures make the bridge announce the worker failure
  // on console.warn before falling back — expected behaviour (none of these
  // tests assert on the console). Silence it so a green run stays clean.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('uses the worker client when it succeeds and records the path', async () => {
    const { positions, n } = smallScene();
    const client: DeriveClassificationClientLike = {
      classify: (p, count, options) => Promise.resolve(deriveClassification(p, count, options)),
    };
    const res = await deriveClassificationAsync(positions, n, { cellSizeM: 1 }, undefined, client);
    expect(res.derived).toBe(true);
    expect(res.codes).toHaveLength(n);
    expect(getLastClassifyComputePath()).toBe('worker');
  });

  it('forwards progress phases from the main-thread fallback', async () => {
    const { positions, n } = smallScene();
    const phases: string[] = [];
    const failing: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('worker unavailable')),
    };
    await deriveClassificationAsync(
      positions, n, { cellSizeM: 1 }, undefined, failing, (p) => phases.push(p),
    );
    // The fallback runs the real pipeline, so the four phases fire.
    expect(phases).toContain('Building ground surface');
    expect(phases).toContain('Classifying');
  });

  it('falls back to the main thread when the worker fails, and warns', async () => {
    const { positions, n } = smallScene();
    const failing: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('worker construction failed')),
    };
    const res = await deriveClassificationAsync(positions, n, { cellSizeM: 1 }, undefined, failing);
    expect(res.codes).toHaveLength(n);
    expect(getLastClassifyComputePath()).toBe('fallback');
  });

  it('rejects an already-aborted signal without computing', async () => {
    const { positions, n } = smallScene();
    const ctrl = new AbortController();
    ctrl.abort();
    let called = false;
    const client: DeriveClassificationClientLike = {
      classify: () => { called = true; return Promise.reject(new Error('should not run')); },
    };
    await expect(
      deriveClassificationAsync(positions, n, {}, ctrl.signal, client),
    ).rejects.toThrow(/abort/i);
    expect(called).toBe(false);
  });

  it('propagates an abort from the client rather than falling back', async () => {
    const { positions, n } = smallScene();
    const client: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('Classification aborted')),
    };
    await expect(
      deriveClassificationAsync(positions, n, {}, undefined, client),
    ).rejects.toThrow(/abort/i);
  });

  it('a cloud inside the measured ceiling still falls back and returns a result', async () => {
    const { positions, n } = smallScene();
    const before = classifyCalls.n;
    const failing: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('worker failed')),
    };
    const res = await deriveClassificationAsync(
      positions, n, { cellSizeM: 1 }, undefined, failing, undefined, { enforceLimits: true },
    );
    expect(n).toBeLessThanOrEqual(MAX_FALLBACK_POINTS);
    expect(res.codes).toHaveLength(n);
    expect(getLastClassifyComputePath()).toBe('fallback');
    expect(classifyCalls.n).toBeGreaterThan(before);
  });

  it('refuses a REAL over-limit cloud without entering the classifier', async () => {
    // A real buffer, really over the ceiling, with no lie about `n`.
    const n = MAX_FALLBACK_POINTS + 1_000;
    const positions = new Float32Array(n * 3);
    const before = classifyCalls.n;
    const failing: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('worker failed')),
    };
    const err = await deriveClassificationAsync(
      positions, n, {}, undefined, failing, undefined, { enforceLimits: true },
    ).then(
      () => {
        throw new Error('resolved: the oversize fallback guard did not fire');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SyncFallbackRefusedError);
    const refusal = err as SyncFallbackRefusedError;
    expect(refusal.stage).toBe('classify');
    expect(refusal.points).toBe(n);
    expect(refusal.limit).toBe(MAX_FALLBACK_POINTS);
    expect(refusal.name).not.toBe('AbortError');
    expect(refusal.userMessage).toContain('No classification was changed');
    // Nothing was classified.
    expect(classifyCalls.n).toBe(before);
  });

  it('the ceiling follows the environment: no Worker global, no refusal', async () => {
    // Node has no `Worker`, so there is no page to freeze and the bridge
    // computes. A tiny cloud with an over-limit `n` keeps the compute cheap
    // while still crossing the bound the guard reads.
    const { positions } = smallScene();
    const n = MAX_FALLBACK_POINTS + 1;
    const failing: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('worker failed')),
    };
    const res = await deriveClassificationAsync(positions, n, { cellSizeM: 1 }, undefined, failing);
    expect(res.derived).toBe(true);
    vi.stubGlobal('Worker', class {});
    try {
      await expect(
        deriveClassificationAsync(positions, n, { cellSizeM: 1 }, undefined, failing),
      ).rejects.toBeInstanceOf(SyncFallbackRefusedError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
