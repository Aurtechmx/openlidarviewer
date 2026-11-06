import { test, expect } from 'vitest';
import { assessmentOnBasis } from '../src/terrain/export/analysedBasis';
import {geojsonString} from '../src/terrain/contour/geojsonContours';
import { readyResult } from './support/readyContourResult';
import {analysisRecordFromProvenance, buildExportProvenance, provenanceJson, provenanceLines} from '../src/terrain/export/exportProvenance';
import {buildTerrainReportContent} from '../src/terrain/export/terrainReportContent';


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

const SAMPLED_OPTS = {
  verticalUnitToMetres: 1,
  analysedBasis: {
    coverage: 'sampled' as const, loadStride: 10,
    analysedPointCount: 25_600, declaredPointCount: 256_000,
  },
};
const DELIVERABLES = ['DEM', 'Contours', 'Map sheet'];

test('a sampled report never lists a product deliverable as Available', () => {
  const report = buildTerrainReportContent(readyResult(), SAMPLED_OPTS);
  const rows = report.products.filter(p => DELIVERABLES.some(d => p.label.includes(d)));
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.availability).toBe('Preview');
    expect(row.note).toContain('sample');
  }
  expect(report.workflows.some(w => /DEM|Contour|Map sheet/.test(w.label) && w.mark === '✓')).toBe(false);
});

test('a full read still lists the deliverables as Available', () => {
  const report = buildTerrainReportContent(readyResult(), { verticalUnitToMetres: 1 });
  const rows = report.products.filter(p => DELIVERABLES.some(d => p.label.includes(d)));
  expect(rows.map(p => p.availability)).toEqual(['Available', 'Available', 'Available']);
});

test('a blocked assessment stays blocked on a sample', () => {
  expect(assessmentOnBasis(
    { exportReadiness: 'Blocked', exportReason: 'gate' },
    SAMPLED_OPTS.analysedBasis, 'sampled',
  )).toEqual({ exportReadiness: 'Blocked', exportReason: 'gate' });
});
