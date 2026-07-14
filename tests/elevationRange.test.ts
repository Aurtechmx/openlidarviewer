/**
 * tests/elevationRange.test.ts
 *
 * Coverage for the v0.3.7 final-polish percentile-clipped elevation
 * range. Pins the outlier-compression case that the screenshots
 * surfaced — a field of points at z ≈ 0 plus a tall tree at z = 30
 * must NOT compress the field into a single colour stop.
 */

import { describe, it, expect } from 'vitest';
import { computeElevationRange, computeScalarRange } from '../src/render/elevationRange';

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

  it('ignores non-finite up-axis samples so a NaN cannot blow out the range', () => {
    // 90% clean ramp + 10% NaN (well over the 100-95=5% that lands on hiIdx).
    const zs: number[] = [];
    for (let i = 0; i < 900; i++) zs.push(i);
    for (let i = 0; i < 100; i++) zs.push(Number.NaN);
    const r = computeElevationRange({ positions: pack(zs), lowerPercentile: 5, upperPercentile: 95 });
    expect(Number.isFinite(r.minZ)).toBe(true);
    expect(Number.isFinite(r.maxZ)).toBe(true);
    expect(r.maxZ).toBeGreaterThan(r.minZ);
  });

  it('returns a finite zero-span when every sample is non-finite', () => {
    const r = computeElevationRange({ positions: pack([NaN, Infinity, -Infinity, NaN]) });
    expect(Number.isFinite(r.minZ) && Number.isFinite(r.maxZ)).toBe(true);
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

  it('is a thin wrapper over computeScalarRange — identical numbers', () => {
    const zs: number[] = [];
    for (let i = 0; i < 500; i++) zs.push((i * 37) % 100);
    const viaElevation = computeElevationRange({ positions: pack(zs) });
    const viaScalar = computeScalarRange(Float32Array.from(zs));
    expect(viaElevation.minZ).toBe(viaScalar.min);
    expect(viaElevation.maxZ).toBe(viaScalar.max);
    expect(viaElevation.trueMinZ).toBe(viaScalar.trueMin);
    expect(viaElevation.trueMaxZ).toBe(viaScalar.trueMax);
    expect(viaElevation.sampleCount).toBe(viaScalar.sampleCount);
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

describe('computeScalarRange', () => {
  it('returns zero-span for an empty input', () => {
    const r = computeScalarRange(new Float64Array(0));
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
    expect(r.sampleCount).toBe(0);
  });

  it('returns the single value for a one-element input', () => {
    const r = computeScalarRange([42.5]);
    expect(r.min).toBeCloseTo(42.5, 6);
    expect(r.max).toBeCloseTo(42.5, 6);
  });

  it('clips outliers to the requested percentile band', () => {
    // 99 values in 0..0.4 plus one outlier at 30 — the generic twin of the
    // tall-tree case the elevation range was built for.
    const values: number[] = [];
    for (let i = 0; i < 99; i++) values.push((i % 5) * 0.1);
    values.push(30);
    const r = computeScalarRange(values, { lowerPercentile: 5, upperPercentile: 95 });
    expect(r.trueMax).toBeCloseTo(30, 4);
    expect(r.max).toBeLessThan(5);
    expect(r.min).toBeLessThan(r.max);
  });

  it('honours explicit lower/upper percentiles', () => {
    const values: number[] = [];
    for (let i = 0; i < 100; i++) values.push(i);
    const r = computeScalarRange(values, { lowerPercentile: 10, upperPercentile: 80 });
    expect(r.min).toBeGreaterThanOrEqual(8);
    expect(r.min).toBeLessThanOrEqual(12);
    expect(r.max).toBeGreaterThanOrEqual(78);
    expect(r.max).toBeLessThanOrEqual(82);
  });

  it('skips non-finite values', () => {
    const r = computeScalarRange([NaN, 1, 2, Infinity, 3, -Infinity]);
    expect(Number.isFinite(r.min)).toBe(true);
    expect(Number.isFinite(r.max)).toBe(true);
    expect(r.trueMin).toBe(1);
    expect(r.trueMax).toBe(3);
  });

  it('preserves Float64 precision on huge-magnitude values (GPS time)', () => {
    // GPS adjusted standard time: ~3.2e8 s base with 0.5 s spacing. A Float32
    // sample buffer quantises 3.2e8 to ~32 s steps, collapsing the band; the
    // Float64 path must keep the ~90 % percentile span near its analytic 45 s.
    const base = 3.2e8;
    const values = new Float64Array(100);
    for (let i = 0; i < 100; i++) values[i] = base + i * 0.5;
    const r = computeScalarRange(values, { lowerPercentile: 5, upperPercentile: 95 });
    const span = r.max - r.min;
    expect(span).toBeGreaterThan(40);
    expect(span).toBeLessThan(50);
  });

  it('respects an explicit count over the array length', () => {
    const r = computeScalarRange([1, 2, 3, 999], { count: 3, lowerPercentile: 0, upperPercentile: 100 });
    expect(r.trueMax).toBe(3);
  });
});
