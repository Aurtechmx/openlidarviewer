/**
 * whyNotReasons.test.ts
 *
 * The "Why? / How to improve" engine. From the SAME data the gate already
 * computed, it emits plain-language causes (each carrying the measured figure)
 * paired with actionable fixes — and ONLY the causes that actually apply. A
 * clean, ready result emits nothing.
 *
 * The figures are read straight off the gate ratios / flags; the engine never
 * invents a number. Honesty-first: the whole point is to say WHY a surface is
 * held back AND HOW to improve it.
 */

import { describe, it, expect } from 'vitest';
import { explainLimitations } from '../src/terrain/contour/whyNotReasons';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import type { DtmQualityReport } from '../src/terrain/quality/dtmQualityGate';
import type { DemAccuracyStandards } from '../src/terrain/quality/demAccuracyStandards';
import type { TerrainCoverageMode } from '../src/terrain/TerrainContracts';

interface FixtureOpts {
  interpolatedCellRatio?: number;
  interpolatedOfSurfaceRatio?: number;
  emptyCellRatio?: number;
  edgeRiskRatio?: number;
  measuredCellRatio?: number;
  meanCellConfidence?: number;
  groundPointRatio?: number;
  rmseZM?: number | null;
  crs?: string | null;
  verticalDatum?: string | null;
  coverageMode?: TerrainCoverageMode;
}

/** Build a result skeleton populated only with the fields the engine reads. */
function fixture(o: FixtureOpts = {}): AnalyseContoursResult {
  const crs = o.crs === undefined ? 'EPSG:32610' : o.crs;
  const datum = o.verticalDatum === undefined ? 'EPSG:5703' : o.verticalDatum;
  const coverageMode = o.coverageMode ?? 'full';
  const quality: Partial<DtmQualityReport> = {
    readiness: 'previewOnly',
    exportReadiness: 'previewOnly',
    interpolatedCellRatio: o.interpolatedCellRatio ?? 0.1,
    interpolatedOfSurfaceRatio: o.interpolatedOfSurfaceRatio ?? o.interpolatedCellRatio ?? 0.1,
    emptyCellRatio: o.emptyCellRatio ?? 0.05,
    edgeRiskRatio: o.edgeRiskRatio ?? 0.02,
    measuredCellRatio: o.measuredCellRatio ?? 0.85,
    meanCellConfidence: o.meanCellConfidence ?? 80,
    groundPointRatio: o.groundPointRatio ?? 0.6,
    coverageMode,
    crsKnown: crs != null,
    datumKnown: datum != null,
    reasons: [],
    exportReasons: [],
  };
  const rmseZM = o.rmseZM === undefined ? 0.08 : o.rmseZM;
  const accuracyStandards: Partial<DemAccuracyStandards> = { rmseZM };
  return {
    quality: quality as DtmQualityReport,
    accuracyStandards: accuracyStandards as DemAccuracyStandards,
    dtm: { coverageMode, crs, verticalDatum: datum },
  } as unknown as AnalyseContoursResult;
}

const causeText = (r: AnalyseContoursResult): string =>
  explainLimitations(r).causes.map((c) => c.text).join(' | ');
const fixText = (r: AnalyseContoursResult): string =>
  explainLimitations(r).fixes.map((f) => f.text).join(' | ');

describe('explainLimitations', () => {
  it('emits NO causes/fixes for a clean, ready, georeferenced result', () => {
    const { causes, fixes } = explainLimitations(
      fixture({
        interpolatedCellRatio: 0.05,
        emptyCellRatio: 0.02,
        edgeRiskRatio: 0.01,
        meanCellConfidence: 85,
        groundPointRatio: 0.7,
      }),
    );
    expect(causes).toEqual([]);
    expect(fixes).toEqual([]);
  });

  it('high interpolation → cause names the % and a fly-lower/denser fix', () => {
    const r = fixture({ interpolatedCellRatio: 0.55 });
    expect(causeText(r)).toMatch(/55%/);
    expect(causeText(r)).toMatch(/interpolat/i);
    expect(fixText(r)).toMatch(/fly lower|overlap|dens/i);
  });

  it('"of the surface" uses the of-covered figure, not the whole-grid ratio', () => {
    // A grid where the whole-grid interpolation ratio is comfortably below the
    // threshold (30%) but the surface that actually exists is mostly guessed
    // (60% of covered). The Why-Not cause must speak to the surface figure so a
    // gappy scan is not described as fine.
    const r = fixture({ interpolatedCellRatio: 0.3, interpolatedOfSurfaceRatio: 0.6 });
    expect(causeText(r)).toMatch(/60% of the surface is interpolated/);
    expect(causeText(r)).not.toMatch(/30%/);
  });

  it('high empty coverage → cause names the % with no data and an extend-coverage fix', () => {
    const r = fixture({ emptyCellRatio: 0.5 });
    expect(causeText(r)).toMatch(/50%/);
    expect(causeText(r)).toMatch(/no data/i);
    expect(fixText(r)).toMatch(/coverage|passes/i);
  });

  it('high edge risk → cause names the % boundary-measured cells and an extend-past fix', () => {
    const r = fixture({ edgeRiskRatio: 0.3 });
    expect(causeText(r)).toMatch(/30%/);
    expect(causeText(r)).toMatch(/edge|reach/i);
    expect(fixText(r)).toMatch(/extend|past the area/i);
  });

  it('does NOT mislabel the boundary-measured edge metric as "long interpolation"', () => {
    // REGRESSION: q.edgeRiskRatio is wired from cellMetrics.edgeRiskRatio
    // (analyseContours), i.e. MEASURED cells that sit near the data boundary —
    // they have real returns, just least neighbour support. The "Why?" cause
    // must NOT describe them with the gate's tally-metric phrasing ("a long
    // interpolation from real returns"), which belongs to dtmCellStatus
    // 'edgeRisk' (interpolated cells far from any measurement). This keeps the
    // wording fix consistent with terrainAssessment, which renders in the same
    // surface-quality section directly above this "Why?" panel.
    const r = fixture({ edgeRiskRatio: 0.53 });
    expect(causeText(r)).not.toMatch(/long interpolation/i);
    expect(causeText(r)).toMatch(/53% of measured cells sit at the edge of the data/);
  });

  it('low ground visibility / low confidence → ground-visibility cause + fix', () => {
    const r = fixture({ groundPointRatio: 0.04, meanCellConfidence: 40 });
    expect(causeText(r)).toMatch(/ground|sparse|confidence/i);
    expect(fixText(r)).toMatch(/occlusion|vegetation|angles|visibility/i);
  });

  it('RMSE not validated → vertical-accuracy cause + ground-control fix', () => {
    const r = fixture({ rmseZM: null });
    expect(causeText(r)).toMatch(/vertical accuracy|could not be validated/i);
    expect(fixText(r)).toMatch(/ground-control|check point/i);
  });

  it('unknown CRS → coordinate-system cause + assign-CRS fix', () => {
    const r = fixture({ crs: null });
    expect(causeText(r)).toMatch(/coordinate system|crs/i);
    expect(fixText(r)).toMatch(/crs/i);
  });

  it('unknown vertical datum → datum cause + provide-datum fix', () => {
    const r = fixture({ verticalDatum: null });
    expect(causeText(r)).toMatch(/vertical datum/i);
    expect(fixText(r)).toMatch(/datum/i);
  });

  it('resident-only coverage → partial-cloud cause + stream/load-full fix', () => {
    const r = fixture({ coverageMode: 'resident-only' });
    expect(causeText(r)).toMatch(/part of the cloud|partial/i);
    expect(fixText(r)).toMatch(/full|stream|load/i);
  });

  it('sampled coverage → partial-cloud cause too', () => {
    const r = fixture({ coverageMode: 'sampled' });
    expect(causeText(r)).toMatch(/part of the cloud|partial/i);
  });

  it('deduplicates — repeated triggers never emit the same cause twice', () => {
    // Both unknowns plus high interpolation: each appears exactly once.
    const r = fixture({ crs: null, verticalDatum: null, interpolatedCellRatio: 0.55 });
    const { causes, fixes } = explainLimitations(r);
    const causeKeys = causes.map((c) => c.text);
    expect(new Set(causeKeys).size).toBe(causeKeys.length);
    const fixKeys = fixes.map((f) => f.text);
    expect(new Set(fixKeys).size).toBe(fixKeys.length);
  });

  it('never claims survey-grade in any cause or fix', () => {
    const r = fixture({ crs: null, verticalDatum: null, interpolatedCellRatio: 0.6, rmseZM: null });
    const all = `${causeText(r)} ${fixText(r)}`;
    expect(all).not.toMatch(/survey.?grade|certified|guaranteed/i);
  });
});
