/**
 * tests/profileAnalyticalFixtures.test.ts
 *
 * Cross-section / profile validation against named analytical fixtures.
 * Pairs with `tests/volumeAnalyticalFixtures.test.ts` to give the
 * release notes a single file per analytical surface that documents the
 * correctness contract in plain numbers.
 *
 * Each fixture builds a synthetic surface with a known elevation
 * function, samples it along an axis-aligned transect, and asserts the
 * resulting (distance, height) polyline against the analytical answer
 * with documented tolerances.
 *
 * The sampler is a nearest-point binner, so tolerances are finite but
 * small. Failure of these tests means either the projection geometry
 * regressed or the bin-selection logic drifted; either is a release
 * blocker.
 */

import { describe, it, expect } from 'vitest';
import { sampleProfile, summariseProfile } from '../src/render/measure/profileSampler';

const Z_UP: [number, number, number] = [0, 0, 1];

/** Pack an interleaved x/y/z Float32Array from a flat list of triples. */
function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

describe('Fixture 1 — flat plane at z = 5 (expected uniform height 5 m)', () => {
  it('returns a constant height across every bin', () => {
    // 50 samples along x ∈ [0, 10], every cloud point at z = 5.
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 50; i++) {
      pts.push([i * (10 / 49), 0, 5]);
    }
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 10,
    });
    for (const sample of out) {
      expect(Number.isFinite(sample.height)).toBe(true);
      expect(Math.abs(sample.height - 5)).toBeLessThan(1e-5);
    }
    const summary = summariseProfile(out);
    expect(summary.heightSpan).toBeCloseTo(0, 5);
    expect(summary.coverage).toBe(1);
  });
});

describe('Fixture 2 — linear ramp from z = 0 to z = 10 over 10 m horizontal (expected slope 1.0)', () => {
  it('reproduces the ramp height at each sample exactly when cloud points land at bin centres', () => {
    // 11 cloud points laid exactly on the ramp surface at the same x
    // positions as the 11 bins, so the nearest-point sampler reads each
    // bin's elevation without bin-center bias.
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i <= 10; i++) {
      pts.push([i, 0, i]); // z = x linear ramp at x = 0, 1, ..., 10
    }
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 10], // end point on the ramp surface; horizontal distance is 10 m
      up: Z_UP,
      positions: pack(pts),
      samples: 11,
    });
    // Distance is horizontal (10 m total), bin spacing is 1 m, expected
    // height = bin distance exactly.
    for (let i = 0; i < out.length; i++) {
      const expectedHeight = out[i].distance;
      expect(out[i].height).toBeCloseTo(expectedHeight, 4);
    }
    const summary = summariseProfile(out);
    expect(summary.minHeight).toBeCloseTo(0, 4);
    expect(summary.maxHeight).toBeCloseTo(10, 4);
    expect(summary.heightSpan).toBeCloseTo(10, 4);
    expect(summary.coverage).toBe(1);
  });
});

describe('Fixture 3 — step from z = 0 to z = 5 at x = 5 m (expected sharp jump)', () => {
  it('binses both plateaus and produces a recognisable step', () => {
    // Lower plateau x ∈ [0, 5) at z = 0; upper plateau x ∈ [5, 10] at z = 5.
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 50; i++) {
      const x = (i * 5) / 49;
      pts.push([x, 0, 0]); // lower plateau
    }
    for (let i = 0; i < 50; i++) {
      const x = 5 + (i * 5) / 49;
      pts.push([x, 0, 5]); // upper plateau
    }
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 11,
    });
    // First bin (distance 0) should read the lower plateau.
    expect(out[0].height).toBeCloseTo(0, 1);
    // Last bin (distance 10) should read the upper plateau.
    expect(out[10].height).toBeCloseTo(5, 1);
    // Step contrast survives in the summary.
    const summary = summariseProfile(out);
    expect(summary.heightSpan).toBeGreaterThanOrEqual(4.9);
  });
});

describe('Fixture 4 — axis orientation: diagonal transect on a tilted ramp (expected horizontal-plane distance)', () => {
  it('reports horizontal-plane distance, not 3D length', () => {
    // 3-4-5 right triangle in the map: a = (0, 0), b = (3, 4), with the
    // surface climbing along the transect from z = 0 at a to z = 12 at b
    // (so the 3D length is 13 m). The reported distance must be 5 m, not 13.
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 50; i++) {
      const t = i / 49;
      const x = 3 * t;
      const y = 4 * t;
      const z = 12 * t;
      pts.push([x, y, z]);
    }
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [3, 4, 12],
      up: Z_UP,
      positions: pack(pts),
      samples: 2,
    });
    expect(out[0].distance).toBe(0);
    expect(out[1].distance).toBeCloseTo(5, 4); // horizontal hypotenuse, not 3D length
  });
});

describe('Fixture 5 — gap detection: empty middle bin (expected NaN coverage hole)', () => {
  it('marks bins outside the band as NaN and reduces summary coverage', () => {
    // Two clusters of points at the ends, nothing in the middle 60 % of
    // the transect.
    const pts: Array<[number, number, number]> = [
      [0, 0, 1],
      [0.1, 0, 1],
      [0.2, 0, 1],
      [9.8, 0, 7],
      [9.9, 0, 7],
      [10, 0, 7],
    ];
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 11,
      bandWidth: 0.4,
    });
    const summary = summariseProfile(out);
    // At least one middle bin must be NaN.
    const nanBins = out.filter((s) => Number.isNaN(s.height)).length;
    expect(nanBins).toBeGreaterThan(0);
    expect(summary.coverage).toBeLessThan(1);
    // The populated bins still expose the right elevation range.
    expect(summary.minHeight).toBeCloseTo(1, 0);
    expect(summary.maxHeight).toBeCloseTo(7, 0);
  });
});
