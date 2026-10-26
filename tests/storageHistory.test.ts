/**
 * tests/storageHistory.test.ts
 *
 * The storage-grid test behind the scan report's "Storage history" row, run at its production
 * budget on synthetic clouds with a known history: the candidate set per unit, the recovery of
 * the stored integers from Float32 local positions, and the three outcomes.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_POINTS,
  recoverStoredIntegers,
  runStorageHistory,
  storageHistoryCandidates,
  windowUnitsFor,
  type StorageHistoryRequest,
} from '../src/science/storageHistory';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OFFSET: [number, number] = [500_000, 4_200_000];

/**
 * A LAS-like request: continuous points in a square of `sizeM`, stored on an ancestral grid of
 * step `s1` metres turned `theta` (none when `s1` is null), then rounded to the file's `scale`,
 * written as `offset + scale * N` and loaded as Float32 locals about an origin at the offset.
 */
function request(n: number, sizeM: number, s1: number | null, scale: number, theta = 0, seed = 3, unitToMetres: number | null = 1): StorageHistoryRequest {
  const r = rng(seed);
  const xy = new Float32Array(2 * n);
  const c = Math.cos(theta), s = Math.sin(theta);
  for (let i = 0; i < n; i++) {
    let x = r() * sizeM, y = r() * sizeM;
    if (s1 !== null) {
      const u = Math.round((c * x + s * y) / s1), v = Math.round((-s * x + c * y) / s1);
      x = s1 * (c * u - s * v); y = s1 * (s * u + c * v);
    }
    const nx = Math.round(x / scale), ny = Math.round(y / scale);
    xy[2 * i] = (OFFSET[0] + scale * nx) - OFFSET[0];
    xy[2 * i + 1] = (OFFSET[1] + scale * ny) - OFFSET[1];
  }
  return { xy, sourceOrigin: OFFSET, scale: [scale, scale], offset: OFFSET, unitToMetres };
}

describe('storageHistoryCandidates', () => {
  it('tests same-frame refinements, foot grids over a whole-degree sweep and the US survey foot for a metre file', () => {
    const c = storageHistoryCandidates(0.001, 1);
    const same = c.filter((x) => x.history.sameFrame);
    expect(same.map((x) => x.history.step)).toEqual([0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 1]);
    expect(same.every((x) => x.unit === 'm' && x.rotationDeg === 0)).toBe(true);
    const feet = c.filter((x) => x.unit === 'ft');
    const degrees = [...new Set(feet.map((x) => x.rotationDeg))].sort((a, b) => a - b);
    expect(degrees).toEqual([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]);
    expect(feet.filter((x) => x.rotationDeg === 3).map((x) => x.stepShown)).toEqual([0.01, 0.1]);
    const us = feet.filter((x) => x.history.label.startsWith('US survey'));
    expect(us.map((x) => x.history.step)).toEqual([0.01 * 1200 / 3937, 0.1 * 1200 / 3937]);
    expect(c.filter((x) => x.unit === 'source')).toHaveLength(0);
  });
  it('tests only unit-free same-frame refinements when the linear unit is not established', () => {
    const c = storageHistoryCandidates(0.01, null);
    expect(c.every((x) => x.history.sameFrame && x.unit === 'source')).toBe(true);
    expect(c.map((x) => x.history.step)).toEqual([0.02, 0.05, 0.1, 0.2, 0.5, 1, 10]);
  });
  it('tests metre grids at zero rotation for a file in feet, and shows its own refinements in feet', () => {
    const c = storageHistoryCandidates(0.01, 0.3048);
    const metre = c.filter((x) => x.unit === 'm');
    expect(metre.map((x) => x.stepShown)).toEqual([0.001, 0.01, 0.1]);
    expect(metre.map((x) => x.history.step)).toEqual([0.001 / 0.3048, 0.01 / 0.3048, 0.1 / 0.3048]);
    expect(c.filter((x) => x.history.sameFrame).every((x) => x.unit === 'ft')).toBe(true);
    expect(c.filter((x) => x.history.sameFrame).map((x) => x.history.step)).not.toContain(10);
  });
});

describe('recoverStoredIntegers', () => {
  it('recovers the file integers exactly from Float32 locals about the offset', () => {
    const req = request(500, 60, null, 0.001, 0, 1);
    const rec = recoverStoredIntegers(req);
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.maxResidual).toBeLessThan(0.01);
    expect(rec.nx[7]).toBe(Math.round((req.xy[14] + OFFSET[0] - OFFSET[0]) / 0.001));
  });
  it('refuses positions that do not sit on the header grid', () => {
    const req = request(500, 60, null, 0.001, 0, 1);
    const xy = req.xy.slice();
    for (let i = 0; i < xy.length; i++) xy[i] += 0.00037;
    const rec = recoverStoredIntegers({ ...req, xy });
    expect(rec.ok).toBe(false);
    if (!rec.ok) expect(rec.reason).toBe('stored integers not recoverable from the loaded positions');
  });
  it('refuses a degenerate footprint before any window is packed', () => {
    expect(windowUnitsFor(new Int32Array([1, 1, 1, 1]), new Int32Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('runStorageHistory', { timeout: 120_000 }, () => {
  it('reports the 0.01 ft grid turned 3 degrees that a metre file was re-rounded from', () => {
    const o = runStorageHistory(request(60_000, 60, 0.01 * 1200 / 3937, 0.001, (3 * Math.PI) / 180, 13));
    expect(o.kind).toBe('supported');
    if (o.kind !== 'supported') return;
    expect(o.unit).toBe('ft');
    expect(o.step).toBe(0.01);
    expect(o.rotationDeg).toBe(3);
    expect(o.pBonferroni).toBeLessThan(0.01);
    expect(o.amplitudeRatio).toBeGreaterThan(0.5);
    expect(o.amplitudeRatio).toBeLessThan(2);
    expect(o.windows).toBeGreaterThanOrEqual(20);
    expect(o.points).toBeLessThanOrEqual(12_000);
  });
  it('reports a 0.01 m refinement of a millimetre file in the file frame', () => {
    const o = runStorageHistory(request(60_000, 60, 0.01, 0.001, 0, 12));
    expect(o.kind).toBe('supported');
    if (o.kind !== 'supported') return;
    expect(o.unit).toBe('m');
    expect(o.step).toBe(0.01);
    expect(o.rotationDeg).toBe(0);
  });
  it('detects nothing on a single-quantisation control', () => {
    const o = runStorageHistory(request(60_000, 60, null, 0.001, 0, 11));
    expect(o.kind).toBe('none');
    if (o.kind === 'none') expect(o.candidatesTested).toBeGreaterThan(0);
  });
  it('shows the refinement in source units when the linear unit is not established', () => {
    const o = runStorageHistory(request(60_000, 60, 0.01, 0.001, 0, 12, null));
    expect(o.kind).toBe('supported');
    if (o.kind === 'supported') {
      expect(o.unit).toBe('source');
      expect(o.step).toBe(0.01);
    }
  });
  it('does not run with too few points or unequal scale factors', () => {
    expect(runStorageHistory(request(MIN_POINTS - 1, 60, null, 0.001))).toEqual({ kind: 'not-tested', reason: 'too few points' });
    const req = request(MIN_POINTS, 60, null, 0.001);
    expect(runStorageHistory({ ...req, scale: [0.001, 0.01] })).toEqual({ kind: 'not-tested', reason: 'unequal X and Y scale factors' });
  });
  it('does not run on positions that were moved off the header grid', () => {
    const req = request(MIN_POINTS, 60, null, 0.001);
    const xy = req.xy.slice();
    for (let i = 0; i < xy.length; i++) xy[i] += 0.0004;
    expect(runStorageHistory({ ...req, xy })).toEqual({ kind: 'not-tested', reason: 'stored integers not recoverable from the loaded positions' });
  });
});
