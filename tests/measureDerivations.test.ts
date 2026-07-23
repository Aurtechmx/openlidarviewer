/**
 * measureDerivations.test.ts — two pure measure helpers lifted from main.ts.
 *
 * `deriveVolumeRecord` shapes a raw VolumeResult into the record the UI stores,
 * assigning a confidence tier and carrying the non-finite-skip disclosure. Its
 * tier boundaries (1000, 100) and the conditional skip field had no test.
 *
 * `horizontalSpanXY` is the larger of a point set's X and Y extents, strided
 * for speed and origin-shifted into world coordinates. Empty input, all-
 * non-finite input, and the origin offset are the edges that were unguarded —
 * and it is one of the world-coordinate boundary sites the Float64 migration
 * targets, so pinning its behaviour now protects that later change.
 */

import { describe, it, expect } from 'vitest';
import { deriveVolumeRecord, horizontalSpanXY } from '../src/render/measure/measureDerivations';
import type { VolumeResult } from '../src/render/measure/volume';

function result(over: Partial<VolumeResult> = {}): VolumeResult {
  return {
    fill: 10,
    cut: 4,
    net: 6,
    footprintArea: 50,
    pointsInPolygon: 500,
    sampleCount: 500,
    densityNative: 10,
    medianAbsDelta: 0.2,
    ...over,
  };
}

describe('deriveVolumeRecord', () => {
  it('copies the volume fields and the reference plane', () => {
    const r = deriveVolumeRecord(result({ fill: 12, cut: 3, net: 9 }), 100.5);
    expect(r.fill).toBe(12);
    expect(r.cut).toBe(3);
    expect(r.net).toBe(9);
    expect(r.referenceZ).toBe(100.5);
  });

  it('is high confidence at exactly 1000 points, medium just below', () => {
    expect(deriveVolumeRecord(result({ pointsInPolygon: 1000 }), 0).confidence).toBe('high');
    expect(deriveVolumeRecord(result({ pointsInPolygon: 999 }), 0).confidence).toBe('medium');
  });

  it('is medium at exactly 100 points, low just below', () => {
    expect(deriveVolumeRecord(result({ pointsInPolygon: 100 }), 0).confidence).toBe('medium');
    expect(deriveVolumeRecord(result({ pointsInPolygon: 99 }), 0).confidence).toBe('low');
  });

  it('carries the non-finite skip count only when there was one', () => {
    expect(deriveVolumeRecord(result({ skippedNonFinite: 7 }), 0).skippedNonFinite).toBe(7);
    expect('skippedNonFinite' in deriveVolumeRecord(result({ skippedNonFinite: 0 }), 0)).toBe(false);
    expect('skippedNonFinite' in deriveVolumeRecord(result(), 0)).toBe(false);
  });
});

describe('horizontalSpanXY', () => {
  it('is zero for an empty point set', () => {
    expect(horizontalSpanXY(new Float32Array(0))).toBe(0);
  });

  it('returns the larger of the X and Y extents', () => {
    // X spans 0..10, Y spans 0..4 → 10.
    const p = Float32Array.from([0, 0, 0, 10, 4, 0]);
    expect(horizontalSpanXY(p)).toBe(10);
  });

  it('adds the origin so the span is in world coordinates', () => {
    // The extent is invariant to a translation, so the origin must not change
    // the result — this pins that the offset is applied to BOTH ends, not one.
    const p = Float32Array.from([0, 0, 0, 6, 2, 0]);
    expect(horizontalSpanXY(p, [500000, 4100000, 0])).toBe(6);
  });

  it('skips non-finite points rather than poisoning the bounds', () => {
    const p = Float32Array.from([0, 0, 0, NaN, NaN, 0, 8, 3, 0]);
    expect(horizontalSpanXY(p)).toBe(8);
  });

  it('is zero when every point is non-finite', () => {
    const p = Float32Array.from([NaN, NaN, 0, Infinity, Infinity, 0]);
    expect(horizontalSpanXY(p)).toBe(0);
  });
});
