/**
 * analysedBasisStamp.test.ts
 *
 * Every artifact states what it was built from. The basis comes from the
 * scan facts and the gather count, not from the DTM grid, whose extent flag
 * reads 'full' for a strided read; the provenance record carries it as
 * `analysedBasis` with `gridExtent` beside the deprecated `coverageMode`
 * alias, and prints one sentence into the text stamp, the JSON, the DEM
 * README and the report.
 */

import { describe, it, expect } from 'vitest';
import { analysedBasisOf, analysedBasisLine } from '../src/terrain/export/analysedBasis';
import { buildExportProvenance, provenanceJson, provenanceLines } from '../src/terrain/export/exportProvenance';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

const result = {
  dtm: { coverageMode: 'full', crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' },
  model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode: 'full' },
  cellStatusTally: { measured: 800, interpolated: 150, empty: 50, lowConfidence: 0, edgeRisk: 0, total: 1000 },
  quality: { status: 'Limited', exportReadiness: 'Preview', reasons: [], exportReasons: [] },
  warnings: [], contours: [], labels: [], intervalM: 1,
} as unknown as AnalyseContoursResult;

describe('analysed basis', () => {
  it('a display sample resolves its stride from the declared total', () => {
    const b = analysedBasisOf({ coverage: 'sampled', pointCount: 15_604_926 }, 2_860_558);
    // 15,604,926 / 2,860,558 = 5.455…: not a whole-number decimation, so no stride is claimed.
    expect(b).toEqual({ analysedPointCount: 2_860_558, declaredPointCount: 15_604_926, coverage: 'sampled', loadStride: null });
    expect(analysedBasisLine(b)).toBe('2,860,558 of 15,604,926 points (display sample); whole-dataset support not claimed');
    const strided = analysedBasisOf({ coverage: 'sampled', pointCount: 1_000_000 }, 200_000);
    expect(strided.loadStride).toBe(5);
    expect(analysedBasisLine(strided)).toBe('200,000 of 1,000,000 points (display sample, stride 5); whole-dataset support not claimed');
  });

  it('a full read and a resident set say so; no total stays honest', () => {
    expect(analysedBasisLine(analysedBasisOf({ coverage: 'full', pointCount: 1_000 }, 1_000))).toBe('1,000 of 1,000 points (full read)');
    expect(analysedBasisLine(analysedBasisOf({ coverage: 'resident-only', pointCount: null }, 640)))
      .toBe('640 points (resident streaming set); whole-dataset support not claimed');
    expect(analysedBasisLine(null)).toBe('unknown');
  });

  it('the stamp carries the basis beside the grid extent, with the deprecated alias', () => {
    const basis = analysedBasisOf({ coverage: 'sampled', pointCount: 1_000_000 }, 200_000);
    const p = buildExportProvenance(result, { generatedAt: '2026-09-14T00:00:00.000Z', verticalUnitToMetres: 1, analysedBasis: basis });
    // The grid says full; the stamp says what was read.
    expect(p.gridExtent).toBe('full');
    expect(p.coverageMode).toBe(p.gridExtent);
    expect(p.analysedBasis).toEqual(basis);
    expect(p.analysedBasis?.coverage).toBe('sampled');
    const json = provenanceJson(p);
    expect(json.gridExtent).toBe('full');
    expect(json.coverageMode).toBe('full');
    expect(json.analysedBasis).toEqual(basis);
    expect(provenanceLines(p).some((l) => /^Analysed basis\s+200,000 of 1,000,000 points \(display sample, stride 5\); whole-dataset support not claimed$/.test(l))).toBe(true);
  });

  it('a stamp built without a recorded basis says unknown, never full', () => {
    const p = buildExportProvenance(result, { generatedAt: '2026-09-14T00:00:00.000Z', verticalUnitToMetres: 1 });
    expect(p.analysedBasis).toBeNull();
    expect(p.analysedBasisLine).toBe('unknown');
    expect(provenanceLines(p).some((l) => /^Analysed basis\s+unknown$/.test(l))).toBe(true);
  });
});
