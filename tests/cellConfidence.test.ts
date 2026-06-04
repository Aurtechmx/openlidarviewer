/**
 * cellConfidence.test.ts — Phase A3 specs. Confidence is the honesty
 * spine, so these assertions guard its core properties: measured beats
 * interpolated, far interpolation decays, gaps stay gaps, and the
 * structural honesty guard catches tampering.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDtmGrid,
  isHonestDtm,
  gradeForConfidence,
  distanceToData,
  EVIDENCE_THRESHOLDS,
  type DtmGrid,
} from '../src/terrain/ground/cellConfidence';
import type { DemRaster } from '../src/terrain/ground/rasterizeDtm';

function raster(opts: {
  z: number[];
  counts: number[];
  cols: number;
  rows: number;
}): DemRaster {
  const filled = opts.counts.filter((c) => c > 0).length;
  return {
    z: Float32Array.from(opts.z),
    counts: Uint32Array.from(opts.counts),
    cols: opts.cols,
    rows: opts.rows,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    coverage: 'full',
    sourcePointCount: opts.counts.reduce((a, b) => a + b, 0),
    analyzedPointCount: opts.counts.reduce((a, b) => a + b, 0),
    filledCellCount: filled,
    warnings: [],
  };
}

describe('buildDtmGrid', () => {
  it('grades measured > near-interpolated > far-interpolated', () => {
    // 3x1: one WELL-SAMPLED measured cell, then a gap of increasing
    // distance. The measured cell needs enough returns to clear the
    // absolute-density floor (v0.4.0) — a structural, not a fluke,
    // ordering.
    const g = buildDtmGrid(
      raster({ z: [5, NaN, NaN], counts: [8, 0, 0], cols: 3, rows: 1 }),
      { crs: 'EPSG:32610' },
    );
    expect(g.coverage[0]).toBe(2); // measured
    expect(g.coverage[1]).toBe(1); // interpolated
    expect(g.coverage[2]).toBe(1);
    expect(g.confidence[0]).toBeGreaterThan(g.confidence[1]);
    expect(g.confidence[1]).toBeGreaterThan(g.confidence[2]);
  });

  it('geographic roughness: degree-scale cells are not over-penalised', () => {
    // measured–gap–measured over degree-scale cells with ~2 m of relief.
    // Without the geographic correction the local slope reads near-vertical
    // and the interpolated cell's roughness penalty maxes out; the correction
    // restores a sensible slope, so the cell keeps more confidence.
    const mk = (): DemRaster => ({
      z: Float32Array.from([0, NaN, 2]),
      counts: Uint32Array.from([8, 0, 8]),
      cols: 3,
      rows: 1,
      cellSizeM: 1e-5,
      originH1: 0,
      originH2: 0,
      coverage: 'full',
      sourcePointCount: 16,
      analyzedPointCount: 16,
      filledCellCount: 2,
      warnings: [],
    });
    const projected = buildDtmGrid(mk(), { crs: 'EPSG:4326' });
    const geographic = buildDtmGrid(mk(), { crs: 'EPSG:4326', isGeographic: true });
    expect(projected.coverage[1]).toBe(1); // interpolated
    expect(geographic.confidence[1]).toBeGreaterThan(projected.confidence[1]);
  });

  it('absolute-density floor: a thinly-sampled measured cell is not fully trusted', () => {
    // Two measured cells, one with a single return and one densely
    // sampled, in a scene whose median is dragged down by the sparse
    // cell. Pre-0.4 both would score 100 (relative-only); the absolute
    // floor must rank the dense cell strictly above the 1-return cell.
    const g = buildDtmGrid(
      raster({ z: [5, 6], counts: [1, 20], cols: 2, rows: 1 }),
      { crs: 'EPSG:32610' },
    );
    expect(g.confidence[0]).toBeLessThan(g.confidence[1]);
    expect(g.confidence[0]).toBeLessThan(100); // 1-return cell capped
  });

  it('absoluteHalfCount: 0 restores pre-0.4 relative-only density', () => {
    // Equal counts → relative density = 1 for both cells (each matches
    // the scene median). With the floor disabled they reach a full 100;
    // with the floor on they are capped below 100.
    const r = raster({ z: [5, 6], counts: [20, 20], cols: 2, rows: 1 });
    const off = buildDtmGrid(r, { crs: 'EPSG:32610', absoluteHalfCount: 0 });
    expect(off.confidence[0]).toBe(100);
    expect(off.confidence[1]).toBe(100);
    const on = buildDtmGrid(r, { crs: 'EPSG:32610' }); // default floor (3)
    expect(on.confidence[0]).toBeLessThan(100);
  });

  it('fills interpolated heights (no NaN where coverage>0) and stays honest', () => {
    const g = buildDtmGrid(
      raster({ z: [5, NaN, NaN], counts: [2, 0, 0], cols: 3, rows: 1 }),
      { crs: 'EPSG:32610' },
    );
    for (let i = 0; i < g.z.length; i++) {
      if (g.coverage[i] > 0) expect(Number.isFinite(g.z[i])).toBe(true);
    }
    expect(isHonestDtm(g)).toBe(true);
    expect(Number.isFinite(g.meanConfidence)).toBe(true);
  });

  it('warns when CRS is unknown (export blocker)', () => {
    const g = buildDtmGrid(raster({ z: [5], counts: [1], cols: 1, rows: 1 }));
    expect(g.crs).toBeNull();
    expect(g.warnings.join(' ')).toMatch(/CRS unknown/i);
  });

  it('marks fully-empty rasters as gaps (coverage none, confidence 0)', () => {
    const g = buildDtmGrid(raster({ z: [NaN, NaN], counts: [0, 0], cols: 2, rows: 1 }));
    expect(Array.from(g.coverage)).toEqual([0, 0]);
    expect(Array.from(g.confidence)).toEqual([0, 0]);
  });

  it('passes CRS and vertical datum through to the grid', () => {
    const g = buildDtmGrid(raster({ z: [5], counts: [1], cols: 1, rows: 1 }), {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    });
    expect(g.crs).toBe('EPSG:32610');
    expect(g.verticalDatum).toBe('EPSG:5703');
  });
});

describe('isHonestDtm', () => {
  it('rejects out-of-range confidence', () => {
    const g = buildDtmGrid(raster({ z: [5], counts: [1], cols: 1, rows: 1 }), {
      crs: 'EPSG:32610',
    });
    const tampered: DtmGrid = { ...g, confidence: Float32Array.from([200]) };
    expect(isHonestDtm(tampered)).toBe(false);
  });

  it('rejects a measured cell with a non-finite height', () => {
    const g = buildDtmGrid(raster({ z: [5], counts: [1], cols: 1, rows: 1 }), {
      crs: 'EPSG:32610',
    });
    const tampered: DtmGrid = { ...g, z: Float32Array.from([NaN]) };
    expect(isHonestDtm(tampered)).toBe(false);
  });
});

describe('gradeForConfidence', () => {
  it('maps confidence to the shared visual grammar', () => {
    expect(gradeForConfidence(90)).toBe('solid');
    expect(gradeForConfidence(EVIDENCE_THRESHOLDS.solid)).toBe('solid');
    expect(gradeForConfidence(50)).toBe('dashed');
    expect(gradeForConfidence(EVIDENCE_THRESHOLDS.dashed)).toBe('dashed');
    expect(gradeForConfidence(10)).toBe('gap');
    expect(gradeForConfidence(Number.NaN)).toBe('gap');
  });
});

describe('distanceToData', () => {
  it('computes BFS distance from measured cells', () => {
    const d = distanceToData(Uint8Array.from([1, 0, 0]), 3, 1);
    expect(Array.from(d)).toEqual([0, 1, 2]);
  });

  it('marks unreachable cells as Infinity', () => {
    const d = distanceToData(Uint8Array.from([0, 0]), 2, 1);
    expect(d[0]).toBe(Infinity);
    expect(d[1]).toBe(Infinity);
  });
});
