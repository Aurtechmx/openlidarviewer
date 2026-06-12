/**
 * objectMetrics.test.ts — OBB dimensions, envelope volume, spacing, completeness.
 */

import { describe, it, expect } from 'vitest';
import { objectMetrics } from '../src/terrain/objectMetrics';
import {
  metresToFeet,
  sqMetresToSqFeet,
  cubicMetresToCubicFeet,
} from '../src/terrain/spaceMetrics';

/** Small, fast, deterministic PRNG (mulberry32) — keeps the density test reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A solid-ish 4×2×1 box sampled on a 0.25 grid, optionally rotated about Z. */
function box(rotRad = 0): Float32Array {
  const out: number[] = [];
  const c = Math.cos(rotRad), s = Math.sin(rotRad);
  for (let x = 0; x <= 4; x += 0.25)
    for (let y = 0; y <= 2; y += 0.25)
      for (let z = 0; z <= 1; z += 0.25) {
        out.push(x * c - y * s, x * s + y * c, z);
      }
  return Float32Array.from(out);
}

describe('objectMetrics', () => {
  it('measures box dimensions and envelope volume', () => {
    const m = objectMetrics(box(0));
    expect(m.obb.lengthM).toBeCloseTo(4, 1);
    expect(m.obb.widthM).toBeCloseTo(2, 1);
    expect(m.obb.heightM).toBeCloseTo(1, 1);
    expect(m.envelopeVolumeM3).toBeCloseTo(8, 0);
  });

  it('reports the longest dimension as max(L,W,H)', () => {
    const m = objectMetrics(box(0)); // 4 × 2 × 1
    expect(m.longestDimensionM).toBeCloseTo(4, 1);
    expect(m.longestDimensionM).toBeCloseTo(Math.max(m.obb.lengthM, m.obb.widthM, m.obb.heightM), 6);
  });

  it('reports the OBB surface area 2(LW+LH+WH) on a known box', () => {
    const m = objectMetrics(box(0)); // 4 × 2 × 1 → 2(8+4+2) = 28
    expect(m.surfaceAreaM2).toBeCloseTo(28, 0);
    const { lengthM: l, widthM: w, heightM: h } = m.obb;
    expect(m.surfaceAreaM2).toBeCloseTo(2 * (l * w + l * h + w * h), 6);
  });

  it('m→ft conversions use the exact 0.3048 factor for length, area, volume', () => {
    expect(metresToFeet(1)).toBeCloseTo(1 / 0.3048, 10);
    expect(sqMetresToSqFeet(1)).toBeCloseTo((1 / 0.3048) ** 2, 10);
    expect(cubicMetresToCubicFeet(1)).toBeCloseTo((1 / 0.3048) ** 3, 10);
  });

  it('empty cloud reports zeroed longest dimension and surface area', () => {
    const m = objectMetrics(new Float32Array([0, 0, 0]));
    expect(m.longestDimensionM).toBe(0);
    expect(m.surfaceAreaM2).toBe(0);
  });

  it('OBB recovers a rotated box that the AABB over-states', () => {
    const m = objectMetrics(box(Math.PI / 6)); // 30°
    // Oriented box stays true to the real side lengths…
    expect(m.obb.lengthM).toBeCloseTo(4, 1);
    expect(m.obb.widthM).toBeCloseTo(2, 1);
    // …while the axis-aligned box is inflated by the rotation.
    expect(m.aabb.lengthM).toBeGreaterThan(m.obb.lengthM + 0.2);
  });

  it('median spacing reflects the sample grid', () => {
    const m = objectMetrics(box(0), { probeSamples: 1500 });
    expect(m.medianSpacingM).toBeGreaterThan(0.2);
    expect(m.medianSpacingM).toBeLessThan(0.4);
  });

  it('median spacing describes the cloud, not the probe (√(P/N) correction)', () => {
    // Known-density synthetic surface: N = 20 000 uniform points over a
    // 20 × 20 m plane → 50 pts/m². For a 2-D Poisson process the median
    // nearest-neighbour distance is √(ln 2 / (π·d)) ≈ 0.4697/√50 ≈ 0.066 m.
    // The probe measures only 2 000 points (5 pts/m² → ≈ 0.21 m); the
    // √(P/N) correction must bring the report back to the cloud's ~0.066 m.
    const rand = mulberry32(42);
    const N = 20_000;
    const full = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      full[i * 3] = rand() * 20;
      full[i * 3 + 1] = rand() * 20;
      full[i * 3 + 2] = 0;
    }
    const expected = Math.sqrt(Math.LN2 / (Math.PI * 50)); // ≈ 0.0664 m
    const m = objectMetrics(full); // probe defaults to 2000
    expect(m.medianSpacingM).toBeGreaterThan(expected * 0.75);
    expect(m.medianSpacingM).toBeLessThan(expected * 1.35);

    // Strided-gather path: pass every 4th point plus the honest source count —
    // the report must still describe the 20 000-point scan, not the gather.
    const gathered = new Float32Array((N / 4) * 3);
    for (let i = 0; i < N / 4; i++) {
      gathered[i * 3] = full[i * 4 * 3];
      gathered[i * 3 + 1] = full[i * 4 * 3 + 1];
      gathered[i * 3 + 2] = 0;
    }
    const g = objectMetrics(gathered, { sourcePointCount: N });
    expect(g.medianSpacingM).toBeGreaterThan(expected * 0.75);
    expect(g.medianSpacingM).toBeLessThan(expected * 1.35);
  });

  it('completeness is high for a full sphere shell, low for a flat plane', () => {
    const sphere: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const u = Math.random(), v = Math.random();
      const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
      sphere.push(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph));
    }
    const sm = objectMetrics(Float32Array.from(sphere));
    expect(sm.completenessPct).toBeGreaterThan(85);

    const plane: number[] = [];
    for (let x = 0; x <= 20; x += 0.5) for (let y = 0; y <= 20; y += 0.5) plane.push(x, y, 0);
    const pm = objectMetrics(Float32Array.from(plane));
    expect(pm.completenessPct).toBeLessThan(60);
  });
});
