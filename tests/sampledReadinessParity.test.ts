import { test, expect } from 'vitest';
import {geojsonString} from '../src/terrain/contour/geojsonContours';
import type {AnalyseContoursResult} from '../src/terrain/contour/analyseContours';
import {analysisRecordFromProvenance, buildExportProvenance, provenanceJson, provenanceLines} from '../src/terrain/export/exportProvenance';
import {buildTerrainReportContent} from '../src/terrain/export/terrainReportContent';
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      coverageMode: 'full',
      meanConfidence: 82,
      cols: 200,
      rows: 150,
      cellSizeM: 1,
      sourcePointCount: 1_200_000,
      analyzedPointCount: 900_000,
    },
    intervalM: 1,
    model: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      intervalM: 1,
      contourStyle: 'smooth',
      coverageMode: 'full',
      features: [{}, {}],
    },
    // A frame that RESOLVED its vertical scale, which is what makes the
    // metre-named standards below legitimate. Every residual-derived figure in
    // the report reads this flag for its suffix.
    verticalScaleResolved: true,
    accuracyStandards: {
      rmseZM: 0.14,
      nvaM: 0.27,
      vvaM: 0.3,
      pointDensityPerM2: 4.2,
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
    },
    quality: {
      readiness: 'ready',
      exportReadiness: 'available',
      crsKnown: true,
      datumKnown: true,
      coverageMode: 'full',
      reasons: [],
      exportReasons: [],
      interpolatedCellRatio: 0.06,
      emptyCellRatio: 0.05,
      edgeRiskRatio: 0.02,
      meanCellConfidence: 82,
      groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: {
      measured: 90,
      interpolated: 5,
      lowConfidence: 0,
      edgeRisk: 0,
      empty: 5,
      total: 100,
    },
    excludedByClassification: 1200,
    generationParams: {
      interpolation: 'geodesic',
      contourStyle: 'smooth',
      smoothing: true,
      despike: true,
      aggregation: 'median',
    },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}


test('sampled terrain exports agree with the PDF about readiness', () => {
  const opts = {
    basename: 'sampled',
    verticalUnitToMetres: 1,
    linearUnit: 'metre' as const,
    analysedBasis: {
      coverage: 'sampled' as const, loadStride: 10,
      analysedPointCount: 100, declaredPointCount: 1000,
    },
  };
  const result = readyResult();
  const provenance = buildExportProvenance(result, opts);
  const json = provenanceJson(provenance);
  const report = buildTerrainReportContent(result, opts);
  const model = {
    ...result.model!, warnings: [], interpolatedFraction: 0,
    features: [{
      coordinates: [[0, 0], [1, 1]], value: 10,
      grade: 'solid', isIndex: true, meanConfidence: 90, closed: false,
    }],
  } as Parameters<typeof geojsonString>[0];
  const geojson = JSON.parse(geojsonString(model, true, provenance));
  const rows = report.sections.flatMap(section => section.rows)
    .filter(row => row.label === 'Export readiness');

  expect(rows.every(row => row.value.startsWith('Preview'))).toBe(true);
  expect(provenanceLines(provenance).some(line =>
    line.includes('Export readiness') && line.includes('Preview'))).toBe(true);
  expect(json.exportReadiness).toBe('Preview');
  expect(geojson.metadata.exportReadiness).toBe('Preview');
  expect(geojson.metadata.exportReason).toContain('sample');
  expect(analysisRecordFromProvenance(provenance).summary.exportReadiness).toBe('Preview');
});

test('a full read retains Ready', () => {
  expect(buildExportProvenance(readyResult(), { verticalUnitToMetres: 1 })
    .exportReadiness).toBe('Ready');
});

test('a sampled grid also cannot stamp Ready', () => {
  const base = readyResult();
  const result = { ...base, dtm: { ...base.dtm!, coverageMode: 'sampled' as const } };
  expect(buildExportProvenance(result, { verticalUnitToMetres: 1 })
    .exportReadiness).toBe('Preview');
});

test('a sampled basis cannot promote a blocked export', () => {
  const base = readyResult();
  const result = {
    ...base,
    quality: { ...base.quality, readiness: 'blocked' as const, exportReasons: ['blocked surface'] },
  };
  const full = buildExportProvenance(result, { verticalUnitToMetres: 1 });
  const sampled = buildExportProvenance(result, {
    verticalUnitToMetres: 1,
    analysedBasis: { coverage: 'sampled', loadStride: 10, analysedPointCount: 10, declaredPointCount: 100 },
  });
  expect(full.exportReadiness).toBe('Blocked');
  expect(sampled.exportReadiness).toBe('Blocked');
  expect(sampled.exportReason).toBe(full.exportReason);
});
