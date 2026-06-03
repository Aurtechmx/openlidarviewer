/**
 * volumeValidity.test.ts
 *
 * Pins the new `validity` field on `VolumeResult` so a future change
 * to `volumeCutFill` can't silently regress the polygon-hygiene gate.
 *
 * The pure-data hygiene layer is tested in `polygonHygiene.test.ts`;
 * these tests verify the math layer correctly propagates the verdict
 * into the result and returns conservative zeros in every failure
 * mode (so the inspector never gets a NaN to render).
 */

import { describe, it, expect } from 'vitest';
import { volumeCutFill } from '../src/render/measure/volume';
import type { Vec3 } from '../src/render/navMath';

// A flat 10 m × 10 m polygon at z = 0, walked counter-clockwise.
const SQUARE: Vec3[] = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 10, 0],
  [0, 10, 0],
];

function flat(points: number): Float32Array {
  // A grid of equally-spaced points at z = 0 inside the unit square.
  const n = Math.floor(Math.sqrt(points));
  const buf = new Float32Array(n * n * 3);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const idx = (i * n + j) * 3;
      buf[idx] = i * (10 / n) + 0.5;
      buf[idx + 1] = j * (10 / n) + 0.5;
      buf[idx + 2] = 0;
    }
  }
  return buf;
}

describe('volumeCutFill — validity tag propagates from polygonHygiene', () => {
  it('returns validity "ok" for a clean square + non-empty cloud', () => {
    const result = volumeCutFill({
      polygon: SQUARE,
      referenceZ: 0,
      positions: flat(100),
    });
    expect(result.validity).toBe('ok');
  });

  it('returns validity "too-few-vertices" for a 2-point polygon', () => {
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 1, 0],
      ],
      referenceZ: 0,
      positions: flat(100),
    });
    expect(result.validity).toBe('too-few-vertices');
    expect(result.fill).toBe(0);
    expect(result.cut).toBe(0);
  });

  it('returns validity "zero-area" for a collinear polygon', () => {
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ],
      referenceZ: 0,
      positions: flat(100),
    });
    expect(result.validity).toBe('zero-area');
    expect(result.fill).toBe(0);
  });

  it('returns validity "self-intersecting" for a bow-tie polygon', () => {
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [10, 10, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
      referenceZ: 0,
      positions: flat(100),
    });
    expect(result.validity).toBe('self-intersecting');
    expect(result.fill).toBe(0);
  });

  it('returns validity "non-finite-vertex" for a NaN vertex', () => {
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [Number.NaN, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      referenceZ: 0,
      positions: flat(100),
    });
    expect(result.validity).toBe('non-finite-vertex');
    expect(result.fill).toBe(0);
  });

  it('returns ok + zeros for an empty cloud against a valid polygon', () => {
    const result = volumeCutFill({
      polygon: SQUARE,
      referenceZ: 0,
      positions: new Float32Array(0),
    });
    // The polygon itself is valid; the cloud is empty. We expect
    // validity 'ok' (the polygon check passed) but the result is all
    // zeros because nothing landed inside.
    expect(result.validity).toBe('ok');
    expect(result.pointsInPolygon).toBe(0);
    expect(result.fill).toBe(0);
    expect(result.cut).toBe(0);
  });

  it('never returns NaN for fill/cut/net even on a degenerate polygon', () => {
    const bad = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      referenceZ: 0,
      positions: flat(100),
    });
    expect(Number.isFinite(bad.fill)).toBe(true);
    expect(Number.isFinite(bad.cut)).toBe(true);
    expect(Number.isFinite(bad.net)).toBe(true);
    expect(Number.isFinite(bad.footprintArea)).toBe(true);
  });
});
