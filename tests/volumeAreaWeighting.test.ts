/**
 * volumeAreaWeighting.test.ts: regressions for the area-weighted cut-fill
 * estimator (`olv.volume.stockpile@3`) and the fixes that shipped with it.
 *
 *   - Density bias: the v1/v2 sum Σ Δz · (A / N) weighted each POINT, so a
 *     footprint scanned 9:1 denser on its raised half read 90 m³ for 50 m³.
 *   - Lasso footprint: the convex hull of the selection counted the empty notch
 *     of an L-shaped pick (67.2 m² for 36 m²); the drawn lasso is the footprint.
 *   - Empty cells: interpolated inside the covered extent, excluded outside it,
 *     the interpolated share reported; over 25 % low-confidence, over 50 %
 *     withheld. Never zero-filled.
 *   - Sample standard deviations divide by n − 1.
 *   - Stationing rounds to centimetres before splitting km from metres.
 */
import { describe, it, expect } from 'vitest';
import {
  volumeCutFill,
  pointSampleCutFill,
  interpolationVerdict,
  INTERPOLATED_LOW_CONFIDENCE,
  INTERPOLATED_WITHHOLD,
} from '../src/render/measure/volume';
import { volumeFromLassoWithFootprint } from '../src/render/measure/lassoVolume';
import { stockpileVolume } from '../src/render/measure/stockpileVolume';
import { presentStockpile } from '../src/render/measure/stockpilePresenter';
import { deriveVolumeRecord } from '../src/render/measure/measureDerivations';
import { formatStationing } from '../src/render/measure/civilProfileStats';
import type { Vec3 } from '../src/render/navMath';

/** Deterministic LCG in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

const SQUARE: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];

/** The dense-half / sparse-half repro: 900 points at z = 1 on x < 5, 100 at z = 0 on x > 5. */
function denseHalf(): Float32Array {
  const r = lcg(12345);
  const pts: number[] = [];
  for (let i = 0; i < 900; i++) pts.push(r() * 5, r() * 10, 1);
  for (let i = 0; i < 100; i++) pts.push(5 + r() * 5, r() * 10, 0);
  return new Float32Array(pts);
}

/** A regular 0.25 m lattice over [0,10]² at height h, minus points `drop` rejects. */
function lattice(h: number, drop: (x: number, y: number) => boolean = () => false): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      const x = (i + 0.5) * 0.25;
      const y = (j + 0.5) * 0.25;
      if (!drop(x, y)) pts.push(x, y, h);
    }
  }
  return new Float32Array(pts);
}

describe('density does not weight the volume', () => {
  it('reads the dense-half / sparse-half footprint near its true 50 m³, where v2 read 90', () => {
    const positions = denseHalf();
    const legacy = pointSampleCutFill({ polygon: SQUARE, referenceZ: 0, positions });
    expect(legacy.fill).toBeCloseTo(90, 6);
    const r = volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions });
    // The remaining error is the column of cells straddling the x = 5 step,
    // whose median goes to the denser side (measured 56.3 m³).
    expect(r.fill).toBeGreaterThan(45);
    expect(r.fill).toBeLessThan(60);
    expect(r.interpolatedFraction).toBeGreaterThan(0);
    expect(r.interpolationVerdict).toBe('ok');
  });

  it('gives the same figure when the dense half is thinned to the sparse density', () => {
    const r = lcg(777);
    const pts: number[] = [];
    for (let i = 0; i < 2500; i++) pts.push(r() * 5, r() * 10, 1);
    for (let i = 0; i < 2500; i++) pts.push(5 + r() * 5, r() * 10, 0);
    const even = volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions: new Float32Array(pts) });
    expect(even.fill).toBeGreaterThan(47);
    expect(even.fill).toBeLessThan(53);
  });
});

describe('the lasso footprint is the drawn lasso', () => {
  // L-shaped slab: [0,10]×[0,2] ∪ [0,2]×[0,10] (36 m²), 1 m tall over a z = 0 rim.
  const pts: number[] = [];
  for (let i = 0; i <= 100; i++) {
    for (let j = 0; j <= 100; j++) {
      const x = i * 0.1;
      const y = j * 0.1;
      if (y <= 2 || x <= 2) pts.push(x, y, x < 0.05 || y < 0.05 ? 0 : 1);
    }
  }
  const positions = new Float32Array(pts);
  const selected = Array.from({ length: pts.length / 3 }, (_, i) => i);
  const L: Array<[number, number]> = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]];

  it('measures 36 m² and ~36 m³ on the drawn L, not the 67 m² hull', () => {
    const out = volumeFromLassoWithFootprint({
      positions,
      selected,
      footprint: (z) => L.map(([x, y]) => [x, y, z] as Vec3),
    });
    expect(out.footprintBasis).toBe('drawn-lasso');
    expect(out.result.footprintArea).toBeCloseTo(36, 6);
    expect(out.result.fill).toBeGreaterThan(34);
    expect(out.result.fill).toBeLessThan(37);
    expect(out.polygon3D).toHaveLength(6);
  });

  it('falls back to the hull, and says so, when the lasso cannot be projected', () => {
    const out = volumeFromLassoWithFootprint({ positions, selected, footprint: () => null });
    expect(out.footprintBasis).toBe('convex-hull');
    expect(out.result.footprintArea).toBeGreaterThan(60);
    // The empty notch lies inside the covered extent, so it is interpolated
    // and the interpolated share puts the figure at low confidence.
    expect(out.result.interpolationVerdict).toBe('low-confidence');
  });
});

describe('empty cells are interpolated inside the covered extent, never zero-filled', () => {
  it('fills a hole in the middle and reports the interpolated share', () => {
    const positions = lattice(2, (x, y) => x > 4 && x < 6 && y > 4 && y < 6);
    const r = volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions });
    expect(r.fill).toBeCloseTo(200, 6); // a zero-filled hole would read ~192
    // The 4 m² hole is 4 % of the footprint; cells on its rim hold points, so
    // the wholly empty cells are a little less (measured 1.6 %).
    expect(r.interpolatedFraction).toBeGreaterThan(0.01);
    expect(r.interpolatedFraction).toBeLessThan(0.05);
    expect(r.excludedFraction).toBeCloseTo(0, 9);
    expect(r.interpolationVerdict).toBe('ok');
    const rec = deriveVolumeRecord(r, 0);
    expect(rec.interpolatedFraction).toBe(r.interpolatedFraction);
    expect(rec.fill).toBeCloseTo(200, 6);
  });

  it('marks a volume low-confidence above 25 % interpolated', () => {
    const positions = lattice(2, (x, y) => x > 2 && x < 8 && y > 2 && y < 8);
    const r = volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions });
    expect(r.interpolatedFraction).toBeGreaterThan(INTERPOLATED_LOW_CONFIDENCE);
    expect(r.interpolatedFraction).toBeLessThanOrEqual(INTERPOLATED_WITHHOLD);
    expect(r.interpolationVerdict).toBe('low-confidence');
    const rec = deriveVolumeRecord(r, 0);
    expect(rec.confidence).toBe('low');
    expect(rec.fill).toBeCloseTo(200, 6);
  });

  it('withholds a volume above 50 % interpolated, with a stated reason', () => {
    const positions = lattice(2, (x, y) => x > 1 && x < 9 && y > 1 && y < 9);
    const r = volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions });
    expect(r.interpolatedFraction).toBeGreaterThan(INTERPOLATED_WITHHOLD);
    expect(r.interpolationVerdict).toBe('withheld');
    expect(r.withheldReason).toMatch(/interpolated, above the 50% limit/);
    const rec = deriveVolumeRecord(r, 0);
    expect(rec.fill).toBeUndefined();
    expect(rec.cut).toBeUndefined();
    expect(rec.net).toBeUndefined();
    expect(rec.gridAuthority).toBe('withheld');
    expect(rec.gridAuthorityReason).toMatch(/50% limit/);
    const view = presentStockpile(stockpileVolume({
      polygon: SQUARE, positions, base: { mode: 'explicit', z: 0 },
    }));
    expect(view.headline).toMatch(/^Volume withheld \(/);
    expect(view.headline).not.toMatch(/m³/);
  });

  it('excludes, and reports, footprint outside the data coverage rather than extrapolating', () => {
    const positions = lattice(2, (x) => x > 6);
    const r = volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions });
    expect(r.excludedFraction).toBeGreaterThan(0.35);
    expect(r.excludedFraction).toBeLessThan(0.45);
    expect(r.interpolatedFraction).toBeLessThan(0.02);
    // Volume over the scanned 6 m × 10 m only: 120 m³, not 200. The column of
    // cells holding the scan's edge counts whole (one ~0.6 m cell width, so up
    // to ~12 m³; measured 129.1 m³).
    expect(r.fill).toBeGreaterThan(115);
    expect(r.fill).toBeLessThan(135);
    const s = stockpileVolume({ polygon: SQUARE, positions, base: { mode: 'explicit', z: 0 } });
    expect(s.caveats.some((c) => /outside the scanned extent/.test(c))).toBe(true);
  });

  it('grades by the thresholds exactly', () => {
    expect(interpolationVerdict(0.25).verdict).toBe('ok');
    expect(interpolationVerdict(0.2501).verdict).toBe('low-confidence');
    expect(interpolationVerdict(0.5).verdict).toBe('low-confidence');
    expect(interpolationVerdict(0.5001).verdict).toBe('withheld');
  });
});

describe('sample standard deviations divide by n − 1', () => {
  it('reports the thickness spread of {0, 1, 2, 3} as 1.291, not 1.118', () => {
    const positions = new Float32Array([1, 1, 0, 9, 1, 1, 9, 9, 2, 1, 9, 3]);
    const r = stockpileVolume({ polygon: SQUARE, positions, base: { mode: 'explicit', z: 0 } });
    expect(r.breakdown.thicknessStdDev).toBeCloseTo(Math.sqrt(5 / 3), 9);
  });

  it('a single inside point has no spread rather than a division by zero', () => {
    const positions = new Float32Array([5, 5, 2]);
    const r = stockpileVolume({ polygon: SQUARE, positions, base: { mode: 'explicit', z: 0 } });
    expect(r.breakdown.thicknessStdDev).toBe(0);
  });
});

describe('stationing rounds before it splits', () => {
  it('formats 999.999 m as 1+000.00, not 0+1000.00', () => {
    expect(formatStationing(999.999)).toBe('1+000.00');
    expect(formatStationing(1999.996)).toBe('2+000.00');
    expect(formatStationing(999.994)).toBe('0+999.99');
    expect(formatStationing(-0.001)).toBe('0+000.00');
    expect(formatStationing(-12.34)).toBe('-0+012.34');
  });
});
