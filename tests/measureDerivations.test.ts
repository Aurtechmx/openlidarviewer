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
import { deriveVolumeRecord, horizontalSpanXY, withStockpileGrid } from '../src/render/measure/measureDerivations';
import type { StockpileGridFigure } from '../src/render/measure/measureDerivations';
import type { VolumeResult } from '../src/render/measure/volume';
import { POINT_SAMPLE_VOLUME_METHOD } from '../src/render/measure/volume';
import { readFileSync } from 'node:fs';

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

// `VolumeRecord.method` exists because two estimators can answer for one
// lasso, and its contract says an absent method means UNKNOWN — specifically
// not the newer area-grid one. The hand-drawn polygon path stamped it and the
// lasso path did not, so a lasso volume was persisted, exported and reported
// as an unknown-method figure when the method was never in doubt.
//
// The tag is passed IN rather than imported here: reading it from the method
// registry at this module's top level pulled the whole registry into the eager
// shell, 7 KiB into a bundle with 3 KiB of headroom. So the guard that matters
// is not just "it stamps what it is given" but "the live path gives it".
describe('a derived volume record names its estimator', () => {
  const result = {
    fill: 10, cut: 2, net: 8, footprintArea: 20,
    pointsInPolygon: 500, densityNative: 25, sampleCount: 500,
    medianAbsDelta: 0.1, validity: 'ok' as const,
  };

  it('stamps the estimator it is given', () => {
    const r = deriveVolumeRecord(result as never, 3, POINT_SAMPLE_VOLUME_METHOD);
    expect(r.method).toBe(POINT_SAMPLE_VOLUME_METHOD);
    expect(r.method).toMatch(/^olv\.volume\.stockpile@\d+$/);
  });

  it('leaves the method absent when the caller cannot say', () => {
    // Absent is the contract's "unknown", and deliberately not the newer
    // estimator: a figure must not acquire a meaning it was never computed
    // under.
    expect(deriveVolumeRecord(result as never, 3).method).toBeUndefined();
  });

  it('carries the same figures either way', () => {
    const bare = deriveVolumeRecord(result as never, 3);
    const named = deriveVolumeRecord(result as never, 3, POINT_SAMPLE_VOLUME_METHOD);
    expect([bare.fill, bare.cut, bare.net, bare.referenceZ]).toEqual([10, 2, 8, 3]);
    expect(named.fill).toBe(bare.fill);
    expect(named.net).toBe(bare.net);
  });

  it('the live lasso path supplies it', () => {
    // The Viewer owns the estimator and declares its identity; main.ts passes
    // that through. If either half is dropped the record silently goes back to
    // unknown, which no unit test of this function alone would notice.
    const viewer = readFileSync(new URL('../src/render/Viewer.ts', import.meta.url), 'utf8');
    expect(viewer).toMatch(/volumeMethod:\s*POINT_SAMPLE_VOLUME_METHOD/);
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/deriveVolumeRecord\([^)]*out\.volumeMethod\)/);
    // D2: the live path also runs the point-sample record through the grid
    // switch, not past it — a call that dropped this would silently keep the
    // point-sample figure canonical for every lasso.
    expect(main).toMatch(/withStockpileGrid\(\s*deriveVolumeRecord\(/);
  });
});

// ── D2: withStockpileGrid — the small module main.ts routes the switch through ──

const psRecord = {
  fill: 10, cut: 2, net: 8, referenceZ: 3, footprintArea: 20,
  pointsInPolygon: 500, densityNative: 25, confidence: 'high' as const,
  method: POINT_SAMPLE_VOLUME_METHOD,
};

const gridFigure = (over: Partial<StockpileGridFigure> = {}): StockpileGridFigure => ({
  method: 'olv.volume.stockpile-area-grid@2',
  authority: 'measured', reason: '',
  fillNative: 7, cutNative: 1, netNative: 6,
  ...over,
});

describe('withStockpileGrid', () => {
  it('is a no-op with no grid figure', () => {
    expect(withStockpileGrid(psRecord, null)).toEqual(psRecord);
  });

  it('is total against a record with no method to attribute the cross-check to', () => {
    const noMethod = { ...psRecord, method: undefined };
    expect(withStockpileGrid(noMethod, gridFigure())).toEqual(noMethod);
  });

  it('is total against a record with no point-sample figure at all', () => {
    const noFigure = { ...psRecord, fill: undefined, cut: undefined, net: undefined };
    expect(withStockpileGrid(noFigure, gridFigure())).toEqual(noFigure);
  });

  it('switches fill/cut/net and method, and keeps the rest of the record untouched', () => {
    const out = withStockpileGrid(psRecord, gridFigure());
    expect(out.fill).toBe(7);
    expect(out.cut).toBe(1);
    expect(out.net).toBe(6);
    expect(out.method).toBe('olv.volume.stockpile-area-grid@2');
    expect(out.confidence).toBe(psRecord.confidence);
    expect(out.referenceZ).toBe(psRecord.referenceZ);
    expect(out.footprintArea).toBe(psRecord.footprintArea);
  });

  it('a withheld grid clears fill/cut/net rather than falling back to the cross-check', () => {
    const out = withStockpileGrid(psRecord, gridFigure({ authority: 'withheld', reason: 'insufficient observations' }));
    expect('fill' in out).toBe(false);
    expect('cut' in out).toBe(false);
    expect('net' in out).toBe(false);
    expect(out.gridAuthority).toBe('withheld');
    expect(out.gridAuthorityReason).toBe('insufficient observations');
  });

  it('always moves the ORIGINAL point-sample numbers into crossCheck, whatever the authority', () => {
    for (const authority of ['measured', 'preview', 'withheld'] as const) {
      const out = withStockpileGrid(psRecord, gridFigure({ authority }));
      expect(out.crossCheck).toEqual({ fill: 10, cut: 2, net: 8, method: POINT_SAMPLE_VOLUME_METHOD });
    }
  });
});
