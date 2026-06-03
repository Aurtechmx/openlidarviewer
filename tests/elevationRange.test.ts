/**
 * tests/elevationRange.test.ts
 *
 * Coverage for the v0.3.7 final-polish percentile-clipped elevation
 * range. Pins the outlier-compression case that the screenshots
 * surfaced — a field of points at z ≈ 0 plus a tall tree at z = 30
 * must NOT compress the field into a single colour stop.
 */

import { describe, it, expect } from 'vitest';
import { computeElevationRange } from '../src/render/elevationRange';

function pack(zs: ReadonlyArray<number>): Float32Array {
  const out = new Float32Array(zs.length * 3);
  for (let i = 0; i < zs.length; i++) {
    out[i * 3] = 0;
    out[i * 3 + 1] = 0;
    out[i * 3 + 2] = zs[i];
  }
  return out;
}

describe('computeElevationRange', () => {
  it('returns zero-span for an empty cloud', () => {
    const r = computeElevationRange({ positions: new Float32Array(0) });
    expect(r.minZ).toBe(0);
    expect(r.maxZ).toBe(0);
    expect(r.sampleCount).toBe(0);
  });

  it('returns the single value for a one-point cloud', () => {
    const r = computeElevationRange({ positions: pack([42.5]) });
    expect(r.minZ).toBeCloseTo(42.5, 4);
    expect(r.maxZ).toBeCloseTo(42.5, 4);
    expect(r.trueMinZ).toBeCloseTo(42.5, 4);
    expect(r.trueMaxZ).toBeCloseTo(42.5, 4);
  });

  it('the outlier-compression case — one tall tree must not squeeze the field', () => {
    // 99 points at z ≈ 0 with mild noise + 1 outlier at z = 30.
    const zs: number[] = [];
    for (let i = 0; i < 99; i++) zs.push((i % 5) * 0.1); // 0 .. 0.4
    zs.push(30);
    const r = computeElevationRange({ positions: pack(zs) });
    // True range is 0 .. 30 — the bug.
    expect(r.trueMinZ).toBeCloseTo(0, 4);
    expect(r.trueMaxZ).toBeCloseTo(30, 4);
    // Clipped range MUST NOT include the outlier — the upper bound
    // sits near the top of the field, not at the tree.
    expect(r.maxZ).toBeLessThan(5);
    expect(r.minZ).toBeGreaterThanOrEqual(0);
    expect(r.minZ).toBeLessThan(r.maxZ);
  });

  it('respects a custom upper percentile', () => {
    // 100 evenly-spaced points 0..99. The 80th percentile is ~79.
    const zs: number[] = [];
    for (let i = 0; i < 100; i++) zs.push(i);
    const r = computeElevationRange({
      positions: pack(zs),
      lowerPercentile: 10,
      upperPercentile: 80,
    });
    // 10th percentile of 0..99 ≈ 10, 80th ≈ 80.
    expect(r.minZ).toBeGreaterThanOrEqual(8);
    expect(r.minZ).toBeLessThanOrEqual(12);
    expect(r.maxZ).toBeGreaterThanOrEqual(78);
    expect(r.maxZ).toBeLessThanOrEqual(82);
  });

  it('clamps percentile inputs to [0, 50] and [50, 100]', () => {
    const zs: number[] = [];
    for (let i = 0; i < 100; i++) zs.push(i);
    const r = computeElevationRange({
      positions: pack(zs),
      lowerPercentile: -5,
      upperPercentile: 200,
    });
    // Inputs clamp to 0 and 100 → range covers the full span.
    expect(r.minZ).toBeLessThanOrEqual(1);
    expect(r.maxZ).toBeGreaterThanOrEqual(98);
  });

  it('returns the true range when every point is at the same z', () => {
    // 50 flat points — every percentile maps to the same value, so the
    // guard falls back to the true range (which is also flat here).
    const r = computeElevationRange({
      positions: pack(new Array(50).fill(5.25)),
    });
    expect(r.minZ).toBeCloseTo(5.25, 4);
    expect(r.maxZ).toBeCloseTo(5.25, 4);
  });

  it('the strided sample stays statistically stable on a large cloud', () => {
    // 200 000 points — the stride should cap the sample at ~50 000 but
    // the percentile picks should still match the analytical answer
    // within a small tolerance.
    const zs = new Array(200_000);
    for (let i = 0; i < zs.length; i++) zs[i] = i; // 0 .. 199 999
    const r = computeElevationRange({ positions: pack(zs) });
    expect(r.sampleCount).toBeLessThanOrEqual(50_000);
    // v0.3.7 default percentile is 5 / 95 — 5th percentile of
    // 0..199 999 ≈ 10 000; 95th ≈ 190 000. Allow a ±5 % tolerance —
    // the strided sample is uniform here so the percentile pick lands
    // very close, but we leave room for the stride floor / heap edge.
    expect(r.minZ).toBeGreaterThanOrEqual(9_000);
    expect(r.minZ).toBeLessThanOrEqual(11_000);
    expect(r.maxZ).toBeGreaterThanOrEqual(189_000);
    expect(r.maxZ).toBeLessThanOrEqual(191_000);
  });
});
