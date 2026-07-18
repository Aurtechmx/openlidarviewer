/**
 * tests/volumeAnalyticalFixtures.test.ts
 *
 * Volume / cut-fill validation against named analytical fixtures with
 * known expected answers. These exist alongside the lower-level unit
 * tests in `volume.test.ts` so the release notes can point at a single
 * file that documents the correctness contract in plain numbers a
 * surveyor can verify by hand.
 *
 * Each fixture has:
 *   - a geometry described in real-world metres
 *   - an analytical answer (the integral of the shape, by hand)
 *   - a tolerance band (documented inline)
 *
 * The estimator is a point-sample approximation, so tolerance is finite —
 * but with a regular grid at the densities used here, the absolute error
 * is well below 1 % on every fixture. Failures of these tests mean
 * either the integration logic regressed or the area-per-point
 * normalisation drifted; either is a release blocker.
 */

import { describe, it, expect } from 'vitest';
import { volumeCutFill } from '../src/render/measure/volume';

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

/**
 * Build a regular N × N point grid spanning [x0, x1] × [y0, y1] at a
 * constant elevation `z`. The grid stays strictly inside the polygon
 * footprint (no boundary samples) so the ray-cast inside test counts
 * every sample, matching the analytical area exactly.
 */
function grid(
  n: number,
  xRange: [number, number],
  yRange: [number, number],
  z: number,
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = xRange[0] + ((xRange[1] - xRange[0]) * i) / (n - 1);
      const y = yRange[0] + ((yRange[1] - yRange[0]) * j) / (n - 1);
      out.push([x, y, z]);
    }
  }
  return out;
}

describe('Fixture A — 10 m × 10 m × 1 m fill cube (expected 100 m³)', () => {
  it('integrates to 100 m³ ± 1 %', () => {
    // 21 × 21 = 441 samples on a 10 m × 10 m footprint, all 1 m above
    // the reference plane. Strict-interior margin (0.2 m) keeps every
    // sample inside the polygon.
    const positions = pack(grid(21, [0.2, 9.8], [0.2, 9.8], 1.0));
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    const expected = 100; // 10 × 10 × 1
    const tolerance = expected * 0.01; // ±1 %
    expect(result.footprintArea).toBeCloseTo(100, 6);
    expect(Math.abs(result.fill - expected)).toBeLessThan(tolerance);
    expect(result.cut).toBe(0);
    expect(Math.abs(result.net - expected)).toBeLessThan(tolerance);
  });
});

describe('Fixture B — 20 m × 20 m × 2 m fill plateau (expected 800 m³)', () => {
  it('integrates to 800 m³ ± 1 %', () => {
    const positions = pack(grid(31, [0.4, 19.6], [0.4, 19.6], 2.0));
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [20, 0, 0],
        [20, 20, 0],
        [0, 20, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    const expected = 800; // 20 × 20 × 2
    const tolerance = expected * 0.01;
    expect(result.footprintArea).toBeCloseTo(400, 6);
    expect(Math.abs(result.fill - expected)).toBeLessThan(tolerance);
    expect(result.cut).toBe(0);
    expect(Math.abs(result.net - expected)).toBeLessThan(tolerance);
  });
});

describe('Fixture C — symmetric half-fill / half-cut (expected net ≈ 0, |volume| = 100 m³ each)', () => {
  it('separates fill and cut buckets at ±2 m over a 10 m × 10 m footprint', () => {
    // Left half (x ∈ [0, 5)) at z = +2 → expected fill = 5 × 10 × 2 = 100 m³.
    // Right half (x ∈ (5, 10]) at z = −2 → expected cut = 5 × 10 × 2 = 100 m³.
    // Net = 0. Strict-interior margin keeps samples off the polygon edge.
    const left = pack(grid(15, [0.2, 4.8], [0.2, 9.8], 2.0));
    const right = pack(grid(15, [5.2, 9.8], [0.2, 9.8], -2.0));
    const positions = new Float32Array(left.length + right.length);
    positions.set(left, 0);
    positions.set(right, left.length);
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    const expectedSide = 100;
    const tolerance = expectedSide * 0.02; // ±2 % per side to absorb the half-half split rounding
    expect(Math.abs(result.fill - expectedSide)).toBeLessThan(tolerance);
    expect(Math.abs(result.cut - expectedSide)).toBeLessThan(tolerance);
    expect(Math.abs(result.net)).toBeLessThan(tolerance);
  });
});

describe('Fixture D — pure cut basin (expected 50 m³)', () => {
  it('integrates to 50 m³ ± 1 % below the reference plane', () => {
    // 5 m × 5 m × 2 m below z = 0 → expected cut = 50 m³.
    const positions = pack(grid(21, [0.2, 4.8], [0.2, 4.8], -2.0));
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [5, 0, 0],
        [5, 5, 0],
        [0, 5, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    const expected = 50; // 5 × 5 × 2
    const tolerance = expected * 0.01;
    expect(result.fill).toBe(0);
    expect(Math.abs(result.cut - expected)).toBeLessThan(tolerance);
    expect(Math.abs(result.net + expected)).toBeLessThan(tolerance);
  });
});

describe('Volume confidence indicators populate as documented', () => {
  it('density and sample-in-polygon match the documented analytical density', () => {
    // 21 × 21 = 441 samples over 100 m² → density 4.41 points / m².
    const positions = pack(grid(21, [0.2, 9.8], [0.2, 9.8], 1.0));
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    expect(result.sampleCount).toBe(441);
    expect(result.pointsInPolygon).toBe(441);
    expect(result.densityNative).toBeCloseTo(4.41, 2);
  });
});
