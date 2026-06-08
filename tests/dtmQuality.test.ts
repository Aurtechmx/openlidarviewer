/**
 * dtmQuality.test.ts — cell status, quality gate, grid recommendation.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyCellStatus,
  tallyCellStatus,
  CELL_STATUS_CODE,
} from '../src/terrain/quality/dtmCellStatus';
import {
  evaluateDtmQuality,
  type DtmQualityInput,
} from '../src/terrain/quality/dtmQualityGate';
import { recommendGrid } from '../src/terrain/quality/recommendGrid';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import type { CellStatusTally } from '../src/terrain/quality/dtmCellStatus';

function grid(opts: {
  coverage: number[];
  confidence: number[];
  interpDist: number[];
}): DtmGrid {
  const n = opts.coverage.length;
  return {
    z: Float32Array.from(opts.coverage.map(() => 5)),
    confidence: Float32Array.from(opts.confidence),
    coverage: Uint8Array.from(opts.coverage),
    counts: Uint32Array.from(opts.coverage.map((c) => (c === 2 ? 4 : 0))),
    interpDistanceCells: Float32Array.from(opts.interpDist),
    cols: n,
    rows: 1,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32610',
    verticalDatum: 'EPSG:5703',
    coverageMode: 'full',
    sourcePointCount: 100,
    analyzedPointCount: 100,
    meanConfidence: 80,
    warnings: [],
  };
}

describe('classifyCellStatus', () => {
  it('assigns measured / interpolated / empty / lowConfidence / edgeRisk', () => {
    // 0 measured, 1 interpolated-near, 2 empty, 3 low-conf interpolated,
    // 4 edgeRisk (far interpolation).
    const g = grid({
      coverage: [2, 1, 0, 1, 1],
      confidence: [90, 70, 0, 10, 70],
      interpDist: [0, 1, Infinity, 1, 5],
    });
    const s = classifyCellStatus(g);
    expect(s[0]).toBe(CELL_STATUS_CODE.measured);
    expect(s[1]).toBe(CELL_STATUS_CODE.interpolated);
    expect(s[2]).toBe(CELL_STATUS_CODE.empty);
    expect(s[3]).toBe(CELL_STATUS_CODE.lowConfidence); // interpolated, conf<33
    expect(s[4]).toBe(CELL_STATUS_CODE.edgeRisk); // interp distance ≥ 3
    const t = tallyCellStatus(s);
    expect(t).toMatchObject({ measured: 1, interpolated: 1, empty: 1, lowConfidence: 1, edgeRisk: 1, total: 5 });
  });

  it('a measured cell stays `measured` even at low confidence (provenance, not confidence)', () => {
    // Regression guard: a thinly-sampled measured cell must NOT be demoted
    // to lowConfidence — that would make a sparse-but-real scan look like
    // it has no measured ground and wrongly block it.
    const g = grid({ coverage: [2, 2], confidence: [10, 5], interpDist: [0, 0] });
    const s = classifyCellStatus(g);
    expect(s[0]).toBe(CELL_STATUS_CODE.measured);
    expect(s[1]).toBe(CELL_STATUS_CODE.measured);
  });
});

const baseTally = (over: Partial<CellStatusTally>): CellStatusTally => ({
  measured: 0,
  interpolated: 0,
  empty: 0,
  lowConfidence: 0,
  edgeRisk: 0,
  total: 0,
  ...over,
});

const baseInput = (over: Partial<DtmQualityInput>): DtmQualityInput => ({
  tally: baseTally({ measured: 80, interpolated: 10, empty: 10, total: 100 }),
  meanCellConfidence: 78,
  holdoutRmseM: 0.08,
  groundPointRatio: 0.7,
  coverageMode: 'full',
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
  recommendedIntervalM: 0.5,
  ...over,
});

describe('evaluateDtmQuality', () => {
  it('ready when measured coverage, validated RMSE, CRS + datum all good', () => {
    const r = evaluateDtmQuality(baseInput({}));
    expect(r.readiness).toBe('ready');
    expect(r.exportReadiness).toBe('available');
    expect(r.measuredCellRatio).toBeCloseTo(0.8, 6);
  });

  // SURFACE QUALITY is CRS/datum-independent: an unknown CRS no longer caps the
  // SURFACE verdict (it stays `ready`). It only caps EXPORT readiness, with the
  // reason living on `exportReasons`, NOT on the surface `reasons`. This is the
  // two-axis truth, not a weakening — the honesty (export still gated) is intact.
  it('surface stays ready while EXPORT is preview-only when CRS is unknown', () => {
    const r = evaluateDtmQuality(baseInput({ crs: null }));
    expect(r.readiness).toBe('ready');
    expect(r.exportReadiness).toBe('previewOnly');
    expect(r.exportReasons.join(' ')).toMatch(/CRS unknown/i);
    // CRS is no longer a SURFACE reason — it belongs only to export.
    expect(r.reasons.join(' ')).not.toMatch(/CRS/i);
  });

  it('surface stays ready while EXPORT is preview-only when vertical datum is unknown', () => {
    const r = evaluateDtmQuality(baseInput({ verticalDatum: null }));
    expect(r.readiness).toBe('ready');
    expect(r.exportReadiness).toBe('previewOnly');
    expect(r.exportReasons.join(' ')).toMatch(/vertical datum unknown/i);
    expect(r.reasons.join(' ')).not.toMatch(/datum/i);
  });

  // SEPARATION (gate level): the SAME surface, CRS+datum known vs datum null —
  // the surface verdict is identical (ready); only export readiness differs.
  it('separates the axes: known datum → export available; null datum → export preview', () => {
    const known = evaluateDtmQuality(baseInput({}));
    const noDatum = evaluateDtmQuality(baseInput({ verticalDatum: null }));
    expect(known.readiness).toBe('ready');
    expect(noDatum.readiness).toBe('ready'); // surface quality unchanged
    expect(known.exportReadiness).toBe('available');
    expect(noDatum.exportReadiness).toBe('previewOnly'); // only export gated
    expect(noDatum.exportReasons.join(' ')).toMatch(/vertical datum unknown/i);
  });

  it('surface previewOnly for interpolation; export tracks surface and is NOT capped further by CRS', () => {
    const r = evaluateDtmQuality(
      baseInput({
        tally: baseTally({ measured: 55, interpolated: 38, empty: 7, total: 100 }),
        crs: null,
      }),
    );
    // SURFACE: preview-only because of the interpolation, NOT the CRS.
    expect(r.readiness).toBe('previewOnly');
    expect(r.reasons.join(' ')).toMatch(/interpolated/i);
    expect(r.reasons.join(' ')).not.toMatch(/CRS/i);
    // EXPORT: already preview-only because the SURFACE is preview-only — export
    // simply tracks the surface verdict here and is NOT demoted *further* by the
    // unknown CRS (it cannot drop below previewOnly). Per the documented
    // contract, `exportReasons` lists only the georef gaps that cap export BELOW
    // the surface verdict; when surface is already previewOnly there is no such
    // demotion, so the list is empty. (`crsKnown` is still reported for callers.)
    expect(r.exportReadiness).toBe('previewOnly');
    expect(r.exportReasons).toEqual([]);
    expect(r.crsKnown).toBe(false);
  });

  it('exportReasons names the georef gap ONLY when it demotes a ready surface below itself', () => {
    // Surface ready + CRS unknown → export demoted from available to previewOnly:
    // exportReasons names the gap (this is the only case it's populated).
    const demoted = evaluateDtmQuality(baseInput({ crs: null }));
    expect(demoted.readiness).toBe('ready');
    expect(demoted.exportReadiness).toBe('previewOnly');
    expect(demoted.exportReasons.join(' ')).toMatch(/CRS unknown/i);

    // Surface previewOnly + CRS unknown → export already tracks the surface, the
    // georef gap does NOT cap it further, so exportReasons stays empty.
    const tracking = evaluateDtmQuality(
      baseInput({
        tally: baseTally({ measured: 55, interpolated: 38, empty: 7, total: 100 }),
        crs: null,
        verticalDatum: null,
      }),
    );
    expect(tracking.readiness).toBe('previewOnly');
    expect(tracking.exportReadiness).toBe('previewOnly');
    expect(tracking.exportReasons).toEqual([]);

    // Surface blocked → export blocked; exportReasons empty (export tracks surface).
    const blocked = evaluateDtmQuality(
      baseInput({
        tally: baseTally({ measured: 5, interpolated: 90, empty: 5, total: 100 }),
        crs: null,
        verticalDatum: null,
      }),
    );
    expect(blocked.readiness).toBe('blocked');
    expect(blocked.exportReadiness).toBe('blocked');
    expect(blocked.exportReasons).toEqual([]);
  });

  it('blocked when almost everything is interpolated', () => {
    const r = evaluateDtmQuality(
      baseInput({ tally: baseTally({ measured: 5, interpolated: 90, empty: 5, total: 100 }) }),
    );
    expect(r.readiness).toBe('blocked');
    expect(r.exportReadiness).toBe('blocked');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('blocked when no contour interval is reliable', () => {
    const r = evaluateDtmQuality(baseInput({ recommendedIntervalM: null }));
    expect(r.readiness).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/interval/i);
  });

  it('blocked when there are no covered cells', () => {
    const r = evaluateDtmQuality(
      baseInput({ tally: baseTally({ empty: 100, total: 100 }) }),
    );
    expect(r.readiness).toBe('blocked');
  });

  it('a sparse-but-fully-measured scan is previewOnly, NOT blocked (low confidence is not "no ground")', () => {
    const r = evaluateDtmQuality(
      baseInput({
        tally: baseTally({ measured: 95, empty: 5, total: 100 }),
        meanCellConfidence: 30, // thin returns → low confidence, but it IS measured
      }),
    );
    expect(r.readiness).toBe('previewOnly');
    expect(r.readiness).not.toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/confidence/i);
  });
});

describe('recommendGrid', () => {
  it('recommends a finer grid for dense data and a coarse one for sparse', () => {
    const dense = recommendGrid({ pointCount: 1_000_000, widthM: 100, depthM: 100, reliefM: 20 });
    const sparse = recommendGrid({ pointCount: 2_000, widthM: 200, depthM: 200, reliefM: 20 });
    expect(dense.cellSizeM).toBeLessThanOrEqual(sparse.cellSizeM);
    expect(recommendGrid({ pointCount: 1, widthM: 1, depthM: 1, reliefM: 1 }).cellOptionsM.length).toBeGreaterThan(0);
  });

  it('snaps to the canonical ladder and respects a requested interval', () => {
    const r = recommendGrid({ pointCount: 500_000, widthM: 120, depthM: 120, reliefM: 30, requestedIntervalM: 2 });
    expect([0.25, 0.5, 1, 2, 5]).toContain(r.cellSizeM);
    expect(r.contourIntervalM).toBe(2);
  });

  it('coarsens the grid when the extent would blow the memory budget', () => {
    const r = recommendGrid({ pointCount: 10_000_000, widthM: 5000, depthM: 5000, reliefM: 100, memoryBudgetCells: 1_000_000 });
    expect((5000 / r.cellSizeM) * (5000 / r.cellSizeM)).toBeLessThanOrEqual(1_000_000);
  });
});
