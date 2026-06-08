/**
 * terrainReportPdf.test.ts
 *
 * Smoke test for the lazy Terrain Intelligence Report PDF builder: it produces a
 * valid (non-empty, %PDF-headed) multi-section document for both a Good + Ready
 * fixture and a Preview fixture, driven from real assembled content, without
 * throwing. Asserts bytes only — the field-level content is covered by
 * terrainReportContent.test.ts; pdf-lib isolation is covered by chunkIsolation.
 */

import { describe, it, expect } from 'vitest';
import { buildTerrainReportPdf } from '../src/render/measure/terrainReportPdf';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

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
    accuracyStandards: {
      rmseZM: 0.14,
      nvaM: 0.27,
      vvaM: 0.3,
      pointDensityPerM2: 4.2,
      qualityLevel: 'QL2',
      qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready',
      exportReadiness: 'available',
      crsKnown: true,
      datumKnown: true,
      coverageMode: 'full',
      reasons: [],
      exportReasons: [],
      measuredCellRatio: 0.9,
      interpolatedCellRatio: 0.06,
      emptyCellRatio: 0.05,
      edgeRiskRatio: 0.02,
      meanCellConfidence: 82,
      groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    excludedByClassification: 1200,
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

function previewResult(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610',
      verticalDatum: null,
      coverageMode: 'resident-only',
      meanConfidence: 48,
      cols: 80,
      rows: 60,
      cellSizeM: 2,
      sourcePointCount: 300_000,
      analyzedPointCount: 120_000,
    },
    intervalM: 2,
    model: { crs: 'EPSG:32610', verticalDatum: null, intervalM: 2, contourStyle: 'crisp', coverageMode: 'resident-only', features: [{}] },
    accuracyStandards: { rmseZM: null, nvaM: null, vvaM: null, pointDensityPerM2: 0, qualityLevel: 'unknown', qualityLevelReason: 'Not enough validated points to measure RMSEz.' },
    quality: {
      readiness: 'previewOnly',
      exportReadiness: 'previewOnly',
      crsKnown: true,
      datumKnown: false,
      coverageMode: 'resident-only',
      reasons: ['Surface is preview-only — high interpolation.'],
      exportReasons: ['vertical datum unknown'],
      measuredCellRatio: 0.4,
      interpolatedCellRatio: 0.55,
      emptyCellRatio: 0.2,
      edgeRiskRatio: 0.05,
      meanCellConfidence: 48,
      groundPointRatio: 0.6,
    },
    qualityScore: { score: 41 },
    cellMetrics: { meanDensity: 1.4, edgeRiskRatio: 0.05 },
    cellStatusTally: { measured: 40, interpolated: 40, lowConfidence: 0, edgeRisk: 0, empty: 20, total: 100 },
    excludedByClassification: 0,
    generationParams: { interpolation: 'idw', contourStyle: 'crisp', smoothing: false, despike: true, aggregation: 'median' },
    warnings: ['Void-filled 40% of cells by interpolation.'],
  } as unknown as AnalyseContoursResult;
}

const OPTS = { basename: 'site-42', generatedAt: '2026-06-05T00:00:00.000Z', softwareVersion: '9.9.9', metricVersion: 'v0.4.1' } as const;

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length > 800 &&
  bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF

describe('buildTerrainReportPdf', () => {
  it('builds a non-empty report for a Good + Ready scan', async () => {
    const bytes = await buildTerrainReportPdf(readyResult(), OPTS);
    expect(isPdf(bytes)).toBe(true);
  });

  it('builds a non-empty report for a Preview / datum-unknown scan', async () => {
    const bytes = await buildTerrainReportPdf(previewResult(), OPTS);
    expect(isPdf(bytes)).toBe(true);
  });

  it('accepts a pre-built content object', async () => {
    const { buildTerrainReportContent } = await import('../src/terrain/export/terrainReportContent');
    const content = buildTerrainReportContent(readyResult(), OPTS);
    const bytes = await buildTerrainReportPdf(content);
    expect(isPdf(bytes)).toBe(true);
  });
});
