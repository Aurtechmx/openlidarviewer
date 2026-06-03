/**
 * tests/ssaoApproximation.test.ts
 *
 * Coverage for the v0.3.7 SSAO approximation (A.1):
 *   - returns a value in [minOcclusion, 1] for every point
 *   - strength=0 yields a flat 1.0 (no darkening)
 *   - points in a pit get a lower AO than points on a plateau
 *   - the minOcclusion floor is honoured
 */

import { describe, it, expect } from 'vitest';
import { ssaoApproximation } from '../src/render/ssaoApproximation';

function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

describe('ssaoApproximation — per-point AO factor', () => {
  it('returns one factor per point', () => {
    const positions = pack([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const out = ssaoApproximation({ positions, cellSize: 1 });
    expect(out).toHaveLength(3);
  });

  it('returns an empty array for an empty cloud', () => {
    const out = ssaoApproximation({ positions: new Float32Array(0), cellSize: 1 });
    expect(out).toHaveLength(0);
  });

  it('strength=0 returns a flat 1.0 (no darkening)', () => {
    const positions = pack([
      [0, 0, 0],
      [1, 0, 5],
      [0, 1, -5],
    ]);
    const out = ssaoApproximation({ positions, cellSize: 1, strength: 0 });
    for (const v of out) {
      expect(v).toBe(1);
    }
  });

  it('every factor is in [minOcclusion, 1]', () => {
    // A pit at the origin surrounded by elevated rim cells.
    const positions = pack([
      // rim ring at z = 5
      [-1, -1, 5],
      [0, -1, 5],
      [1, -1, 5],
      [-1, 0, 5],
      [1, 0, 5],
      [-1, 1, 5],
      [0, 1, 5],
      [1, 1, 5],
      // pit at z = 0
      [0, 0, 0],
    ]);
    const out = ssaoApproximation({
      positions,
      cellSize: 1,
      depthWindow: 5,
      minOcclusion: 0.4,
    });
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0.4);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('a point at the bottom of a pit has a lower AO than a point on a plateau', () => {
    const positions = pack([
      // rim ring at z = 5
      [-1, -1, 5],
      [0, -1, 5],
      [1, -1, 5],
      [-1, 0, 5],
      [1, 0, 5],
      [-1, 1, 5],
      [0, 1, 5],
      [1, 1, 5],
      // pit at z = 0
      [0, 0, 0],
      // plateau point far away at z = 5
      [10, 10, 5],
    ]);
    const out = ssaoApproximation({
      positions,
      cellSize: 1,
      depthWindow: 5,
      minOcclusion: 0.4,
    });
    const pitAo = out[8];
    const plateauAo = out[9];
    expect(pitAo).toBeLessThan(plateauAo);
  });

  it('minOcclusion floor is honoured even in deep pits', () => {
    // Pit far below any rim.
    const positions = pack([
      [-1, -1, 100],
      [0, -1, 100],
      [1, -1, 100],
      [-1, 0, 100],
      [1, 0, 100],
      [-1, 1, 100],
      [0, 1, 100],
      [1, 1, 100],
      [0, 0, -50], // deep, deep pit
    ]);
    const out = ssaoApproximation({
      positions,
      cellSize: 1,
      depthWindow: 5,
      minOcclusion: 0.3,
    });
    const pitAo = out[8];
    // The pit point's depth-below-rim is way past depthWindow → AO
    // reaches the minOcclusion floor, but cannot dip below it.
    expect(pitAo).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(pitAo).toBeCloseTo(0.3, 5);
  });
});
