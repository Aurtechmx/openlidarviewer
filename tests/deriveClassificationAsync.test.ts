/**
 * deriveClassificationAsync.test.ts
 *
 * Covers the worker-or-fallback bridge (the worker round-trip itself can't run
 * in the sandbox): worker success path, abort-before-compute, the main-thread
 * fallback on worker failure, and the compute-path instrumentation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveClassificationAsync,
  getLastClassifyComputePath,
  setDeriveClassificationClientFactory,
  MAX_FALLBACK_POINTS,
} from '../src/render/class/deriveClassificationAsync';
import { deriveClassification } from '../src/render/class/deriveClassification';
import type { DeriveClassificationClientLike } from '../src/render/class/deriveClassificationWorkerClient';

function smallScene(): { positions: Float32Array; n: number } {
  const pts: number[] = [];
  for (let x = 0; x <= 20; x++) for (let y = 0; y <= 20; y++) pts.push(x, y, 0);
  return { positions: new Float32Array(pts), n: pts.length / 3 };
}

beforeEach(() => setDeriveClassificationClientFactory(null));

describe('deriveClassificationAsync', () => {
  it('uses the worker client when it succeeds and records the path', async () => {
    const { positions, n } = smallScene();
    const client: DeriveClassificationClientLike = {
      classify: (p, count, options) => Promise.resolve(deriveClassification(p, count, options)),
    };
    const res = await deriveClassificationAsync(positions, n, { cellSizeM: 1 }, undefined, client);
    expect(res.derived).toBe(true);
    expect(res.codes.length).toBe(n);
    expect(getLastClassifyComputePath()).toBe('worker');
  });

  it('falls back to the main thread when the worker fails, and warns', async () => {
    const { positions, n } = smallScene();
    const failing: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('worker construction failed')),
    };
    const res = await deriveClassificationAsync(positions, n, { cellSizeM: 1 }, undefined, failing);
    expect(res.codes.length).toBe(n);
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

  it('refuses the fallback above the safety ceiling', async () => {
    const n = MAX_FALLBACK_POINTS + 1;
    // A tiny real buffer is fine; the guard trips on n before any compute.
    const positions = new Float32Array(9);
    const failing: DeriveClassificationClientLike = {
      classify: () => Promise.reject(new Error('worker failed')),
    };
    await expect(
      deriveClassificationAsync(positions, n, {}, undefined, failing),
    ).rejects.toThrow(/too large/i);
  });
});
