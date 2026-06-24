/**
 * sampleGrade.test.ts — the GradeFn the full-cloud B-trigger runs over a decoded
 * octree sample. Pins: density tier reuses classifyDensity (per-m³); the
 * back-scale lifts a sample's density to the whole cloud; occupancy distinguishes
 * a filled box from a hollow footprint; vertical span is real; and degenerate
 * inputs (empty, 1-point, zero-volume, non-finite scale) never produce
 * NaN/Infinity or a confident-but-false grade.
 */

import { describe, it, expect } from 'vitest';
import { gradeSampleDensity, summarizeSampleGrade } from '../src/render/streaming/sampleGrade';

/** Build a filled box of `perAxis³` points spanning [0,size] on each axis.
 *  A regular lattice — exact count/volume — used by the density-tier tests. */
function filledBox(perAxis: number, size: number): Float32Array {
  const out: number[] = [];
  const step = size / Math.max(1, perAxis - 1);
  for (let i = 0; i < perAxis; i++)
    for (let j = 0; j < perAxis; j++)
      for (let k = 0; k < perAxis; k++)
        out.push(i * step, j * step, k * step);
  return new Float32Array(out);
}

/** A deterministic xorshift32 in [0,1) — seeded so the cloud is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

/** A continuously-filled box of `n` points uniformly spread in [0,size]³ —
 *  models a real cloud (continuous XY footprint), so a filled footprint reads
 *  as occupying its bounding box. */
function filledCloud(n: number, size: number, seed = 12345): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = r() * size;
  return out;
}

describe('gradeSampleDensity — density tier', () => {
  it('grades a dense filled box and reports a real vertical span', () => {
    // 20³ = 8000 points in a 10×10×10 box ⇒ 8 pts/m³ ⇒ "moderate" band (<40).
    const g = gradeSampleDensity(filledBox(20, 10), 1);
    expect(g.sampledPoints).toBe(8000);
    expect(g.bboxVolumeM3).toBeCloseTo(1000, 0);
    expect(g.bucket).toBe('moderate');
    expect(g.verticalSpanM).toBeCloseTo(10, 5);
  });

  it('back-scales sample density to the whole cloud (a sample reads denser ×scale)', () => {
    const box = filledBox(20, 10); // 8 pts/m³ at scale 1 → moderate
    const at1 = gradeSampleDensity(box, 1);
    const at10 = gradeSampleDensity(box, 10); // whole cloud ~80 pts/m³ → dense
    expect(at1.bucket).toBe('moderate');
    expect(at10.bucket).toBe('dense');
    expect(at10.estimatedTotalPoints).toBe(at1.sampledPoints * 10);
  });
});

describe('gradeSampleDensity — occupancy honesty', () => {
  it('a filled box reads as near-fully occupying its bounding box', () => {
    const g = gradeSampleDensity(filledCloud(12000, 12), 1);
    expect(g.occupancyRatio).not.toBeNull();
    expect(g.occupancyRatio as number).toBeGreaterThan(0.85);
    expect(g.arealDensityPerM2).not.toBeNull();
  });

  it('a hollow footprint occupies far less of its bbox than a filled one', () => {
    // Points only on the XY border (a frame) — bbox is full, footprint hollow.
    const pts: number[] = [];
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 100;
      // four edges of a 100×100 square at z spread 0..5
      pts.push(t, 0, (i % 6)); pts.push(t, 100, (i % 6));
      pts.push(0, t, (i % 6)); pts.push(100, t, (i % 6));
    }
    const hollow = gradeSampleDensity(new Float32Array(pts), 1);
    const filled = gradeSampleDensity(filledCloud(12000, 100), 1);
    expect(hollow.occupancyRatio).not.toBeNull();
    expect(filled.occupancyRatio).not.toBeNull();
    expect(hollow.occupancyRatio as number).toBeLessThan(filled.occupancyRatio as number);
    expect(hollow.occupancyRatio as number).toBeLessThan(0.5);
  });
});

describe('gradeSampleDensity — degenerate inputs never lie', () => {
  it('empty sample → unknown bucket, finite fields, no occupancy claim', () => {
    const g = gradeSampleDensity(new Float32Array(0), 5);
    expect(g.sampledPoints).toBe(0);
    expect(g.bucket).toBe('unknown');
    expect(g.bucketLabel).toBe('—');
    expect(g.occupancyRatio).toBeNull();
    expect(g.arealDensityPerM2).toBeNull();
    expect(Number.isFinite(g.bboxVolumeM3)).toBe(true);
    expect(Number.isFinite(g.estimatedTotalPoints)).toBe(true);
  });

  it('a single point (zero-volume bbox) is unknown, never Infinity density', () => {
    const g = gradeSampleDensity(new Float32Array([1, 2, 3]), 1);
    expect(g.bucket).toBe('unknown');
    expect(g.bboxVolumeM3).toBe(0);
    expect(g.arealDensityPerM2).toBeNull();
  });

  it('a non-finite / <1 scale is floored to 1 (never amplifies to NaN)', () => {
    const box = filledBox(10, 10);
    const bad = gradeSampleDensity(box, Number.NaN);
    const low = gradeSampleDensity(box, 0.01);
    const one = gradeSampleDensity(box, 1);
    expect(bad.estimatedTotalPoints).toBe(one.estimatedTotalPoints);
    expect(low.estimatedTotalPoints).toBe(one.estimatedTotalPoints);
    expect(Number.isFinite(bad.bboxVolumeM3)).toBe(true);
  });

  it('skips non-finite coordinates without crashing the AABB', () => {
    const g = gradeSampleDensity(
      new Float32Array([0, 0, 0, Number.NaN, Number.NaN, Number.NaN, 10, 10, 10]),
      1,
    );
    expect(g.verticalSpanM).toBeCloseTo(10, 5);
    expect(Number.isFinite(g.bboxVolumeM3)).toBe(true);
  });
});

describe('summarizeSampleGrade', () => {
  it('leads with the density tier and includes vertical + occupancy lines', () => {
    const lines = summarizeSampleGrade(gradeSampleDensity(filledBox(24, 12), 4));
    expect(lines[0]).toMatch(/^Density:/);
    expect(lines.some((l) => /Vertical extent/.test(l))).toBe(true);
    expect(lines.some((l) => /Coverage of bounding box/.test(l))).toBe(true);
  });

  it('an unknown grade summarises without fabricating density/occupancy lines', () => {
    const lines = summarizeSampleGrade(gradeSampleDensity(new Float32Array(0), 1));
    expect(lines[0]).toBe('Density: —');
    expect(lines.some((l) => /pts\/m²/.test(l))).toBe(false);
    expect(lines.some((l) => /Coverage of bounding box/.test(l))).toBe(false);
  });
});

describe('metresPerUnit conversion', () => {
  it('treats spans in source units, converting to metres for the volume', () => {
    // Same box, but declared in US survey feet (≈0.3048 m/unit): the metric
    // volume shrinks ~0.3048³, pushing per-m³ density up a tier vs metres.
    const box = filledBox(20, 10);
    const metres = gradeSampleDensity(box, 1, 1);
    const feet = gradeSampleDensity(box, 1, 0.3048);
    expect(feet.bboxVolumeM3).toBeLessThan(metres.bboxVolumeM3);
    expect(feet.verticalSpanM).toBeLessThan(metres.verticalSpanM);
  });

  it('applies a distinct vertical unit to Z only (foot height over a metre grid)', () => {
    const box = filledBox(20, 10); // 10×10×10 in source units
    // Horizontal metres, vertical feet: X/Y spans stay 10 m, Z span → 3.048 m.
    const mixed = gradeSampleDensity(box, 1, 1, 0.3048);
    expect(mixed.verticalSpanM).toBeCloseTo(3.048, 3);
    // Volume = 10 m × 10 m × 3.048 m = 304.8 m³ (not 1000).
    expect(mixed.bboxVolumeM3).toBeCloseTo(304.8, 1);
  });

  it('defaults the vertical factor to the horizontal one when omitted', () => {
    const box = filledBox(20, 10);
    const horizOnly = gradeSampleDensity(box, 1, 0.3048);
    const explicit = gradeSampleDensity(box, 1, 0.3048, 0.3048);
    expect(horizOnly.verticalSpanM).toBeCloseTo(explicit.verticalSpanM, 6);
    expect(horizOnly.bboxVolumeM3).toBeCloseTo(explicit.bboxVolumeM3, 6);
  });
});
