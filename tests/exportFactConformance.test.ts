/**
 * exportFactConformance.test.ts — every artifact of one run tells the same story.
 *
 * The defects this file exists to catch are not defects in any one exporter.
 * Each was individually correct and the SET disagreed:
 *
 *   - "interpolated" meant 13% in the Analyse panel, 34% in the terrain report
 *     and 100% on the map sheet, for one analysis.
 *   - One GeoJSON carried `contourIntervalUnit: "unknown"` beside
 *     `elevationUnit: "metre"` on all 1,681 features and `zUnit: "m"` in its
 *     complexity block.
 *   - One map sheet hedged "10 (vertical unit unverified)" in its title block
 *     ten rows above a note reading "interval 10 m".
 *
 * No type catches those: every value was a well-formed string. What catches
 * them is rendering the artifacts TOGETHER from one analysis and asserting they
 * agree, which is what this does.
 *
 * The rule for adding to this file: if two exports can state the same fact,
 * that fact belongs in the matrix below.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import { buildExportProvenance } from '../src/terrain/export/exportProvenance';
import { buildTerrainReportContent } from '../src/terrain/export/terrainReportContent';
import { gradePercent } from '../src/terrain/contour/evidenceGrade';

/** Options every exporter in the matrix is built from. One analysis, one set. */
const OPTS = {
  basename: 'conformance',
  generatedAt: '2026-09-07T00:00:00.000Z',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.4',
} as const;

/**
 * A resolved vertical scale, and an unresolved one. Both are legitimate states;
 * what must never happen is two artifacts of one run disagreeing about which.
 */
const SCALES: ReadonlyArray<readonly [string, number | null]> = [
  ['a resolved metre frame', 1],
  ['a resolved foot frame', 0.3048],
  ['an unresolved frame', null],
];


/** One analysis, of the shape every exporter in the matrix consumes. */
function oneAnalysis(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', coverageMode: 'full',
      meanConfidence: 82, cols: 200, rows: 150, cellSizeM: 1,
      sourcePointCount: 1_200_000, analyzedPointCount: 900_000,
    },
    intervalM: 10,
    model: {
      crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 10,
      contourStyle: 'smooth', coverageMode: 'full', features: [{}, {}],
      interpolatedFraction: 0.998,
    },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available', crsKnown: true,
      datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
      interpolatedCellRatio: 0.06, emptyCellRatio: 0.05, edgeRiskRatio: 0.02,
      meanCellConfidence: 82, groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: {
      measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100,
    },
    excludedByClassification: 0,
    generationParams: {
      interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true,
      despike: true, aggregation: 'median',
    },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

describe('provenance is the single answer for the vertical unit', () => {
  it.each(SCALES)('agrees with the terrain report on %s', (_label, scale) => {
    const result = oneAnalysis();
    const provenance = buildExportProvenance(result, { ...OPTS, verticalUnitToMetres: scale });
    const report = buildTerrainReportContent(result, { ...OPTS, verticalUnitToMetres: scale });
    // The report stamps its header from the same provenance builder, so the two
    // cannot answer the unit question differently.
    expect(report.provenance.contourIntervalUnit).toBe(provenance.contourIntervalUnit);
    expect(report.provenance.verticalUnitLabel).toBe(provenance.verticalUnitLabel);
  });

  it('says "unknown" only when the frame really resolved nothing', () => {
    const result = oneAnalysis();
    const unresolved = buildExportProvenance(result, { ...OPTS, verticalUnitToMetres: null });
    const resolved = buildExportProvenance(result, { ...OPTS, verticalUnitToMetres: 1 });
    expect(unresolved.contourIntervalUnit).toBe('unknown');
    expect(resolved.contourIntervalUnit).toBe('m');
    // The distinction the shipped file lost: a metre frame must not read the
    // same as a frame nobody resolved.
    expect(resolved.contourIntervalUnit).not.toBe(unresolved.contourIntervalUnit);
  });

  it('labels a foot frame as feet, never as metres', () => {
    const p = buildExportProvenance(oneAnalysis(), { ...OPTS, verticalUnitToMetres: 0.3048 });
    expect(p.contourIntervalUnit).toBe('ft');
  });
});

describe('a grade share is reported as what it counts', () => {
  // The map sheet called this "interpolated"; the number includes gap. Whatever
  // wording a surface chooses, the VALUE must come from one place, and it must
  // not round an exception away.
  it('never reads as all-or-nothing when it is neither', () => {
    for (const f of [0.998, 0.004, 0.9999, 1e-9]) {
      const pct = gradePercent(f);
      expect(pct).toBeGreaterThan(0);
      expect(pct).toBeLessThan(100);
    }
  });

  it('keeps the exact ends exact', () => {
    expect(gradePercent(0)).toBe(0);
    expect(gradePercent(1)).toBe(100);
  });
});

describe('the provenance option cannot be silently skipped', () => {
  it('is required on the options type', () => {
    // A compile-time contract, asserted here so the intent survives a refactor
    // that might otherwise restore the `?`. Two shipped defects came from an
    // options object that simply omitted this field.
    const src = readFileSync(
      new URL('../src/terrain/export/exportProvenance.ts', import.meta.url), 'utf8',
    );
    expect(src).toContain('readonly verticalUnitToMetres: number | null;');
    expect(src).not.toContain('readonly verticalUnitToMetres?:');
  });
});
