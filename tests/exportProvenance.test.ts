/**
 * exportProvenance.test.ts
 *
 * The single provenance object every export stamps. Verifies the builder
 * derives the right fields from an analysis result (CRS known vs unknown,
 * export-ready vs preview, accuracy present vs null, style / interval, software
 * + metric version), that honesty is preserved (no fabrication, always carries
 * the export-readiness verdict + not-survey-grade note), and that the two
 * formatters agree verbatim.
 */

import { describe, it, expect } from 'vitest';
import {
  buildExportProvenance,
  provenanceLines,
  provenanceJson,
  NOT_SURVEY_GRADE_NOTE,
  SOFTWARE_NAME,
  type ExportProvenance,
} from '../src/terrain/export/exportProvenance';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

/** A complete, full-coverage, export-ready analysis result with everything known. */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      coverageMode: 'full',
      meanConfidence: 82,
    },
    intervalM: 1,
    model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode: 'full' },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: ['Removed 2 outlier ground cell(s) before building the surface.'],
  } as unknown as AnalyseContoursResult;
}

const OPTS = { basename: 'site', generatedAt: '2026-06-05T00:00:00.000Z', softwareVersion: '9.9.9', metricVersion: 'v0.4.1' } as const;

describe('buildExportProvenance — field derivation', () => {
  it('derives software + version + metric version + date + source', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.software).toBe(SOFTWARE_NAME);
    expect(p.softwareVersion).toBe('9.9.9');
    expect(p.metricVersion).toBe('v0.4.1');
    expect(p.generated).toBe('2026-06-05T00:00:00.000Z');
    expect(p.source).toBe('site');
  });

  it('reports a known CRS + datum and the ready verdict honestly', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.horizontalCrs).toBe('EPSG:32610');
    expect(p.crsKnown).toBe(true);
    expect(p.verticalDatum).toBe('EPSG:5703');
    expect(p.datumKnown).toBe(true);
    expect(p.surfaceQuality).toBe('Good');
    expect(p.exportReadiness).toBe('Ready');
    expect(p.exportReason).toBe('');
  });

  it('reports style, interval and coverage from the run', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.contourStyle).toBe('smooth');
    expect(p.contourStyleLabel).toBe('Smooth');
    expect(p.contourIntervalM).toBe(1);
    expect(p.coverageMode).toBe('full');
  });

  it('carries the accuracy block when present', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.accuracy).not.toBeNull();
    expect(p.accuracy?.rmseZM).toBeCloseTo(0.14);
    expect(p.accuracy?.usgsQualityLevel).toBe('QL2');
    expect(p.pointDensityPerM2).toBeCloseTo(4.2);
  });

  it('always carries the not-survey-grade note', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(p.notSurveyGrade).toMatch(/not survey-grade/i);
  });

  it('says "not georeferenced" / "unknown" for missing CRS + datum (no fabrication)', () => {
    const base = readyResult() as unknown as { dtm: Record<string, unknown>; model: Record<string, unknown>; quality: Record<string, unknown> };
    const noGeoref = {
      ...(base as unknown as AnalyseContoursResult),
      dtm: { ...base.dtm, crs: null, verticalDatum: null },
      model: { ...base.model, crs: null, verticalDatum: null },
      quality: { ...base.quality, crsKnown: false, datumKnown: false, exportReadiness: 'previewOnly' },
    } as unknown as AnalyseContoursResult;
    const p = buildExportProvenance(noGeoref, OPTS);
    expect(p.horizontalCrs).toBe('not georeferenced');
    expect(p.crsKnown).toBe(false);
    expect(p.verticalDatum).toBe('unknown');
    expect(p.datumKnown).toBe(false);
    // Unknown CRS/datum caps export readiness to Preview with a naming reason.
    expect(p.exportReadiness).toBe('Preview');
    expect(p.exportReason).toMatch(/unknown/i);
  });

  it('null accuracy when the run measured no RMSEz', () => {
    const base = readyResult() as unknown as { accuracyStandards: Record<string, unknown> };
    const noAcc = {
      ...(base as unknown as AnalyseContoursResult),
      accuracyStandards: { rmseZM: null, nvaM: null, vvaM: null, pointDensityPerM2: 0, qualityLevel: 'unknown', qualityLevelReason: 'x' },
    } as unknown as AnalyseContoursResult;
    const p = buildExportProvenance(noAcc, OPTS);
    expect(p.accuracy).toBeNull();
    expect(p.pointDensityPerM2).toBeNull();
  });

  it('says contourStyle null + "none" interval when neither is present', () => {
    const base = readyResult() as unknown as Record<string, unknown>;
    delete base.generationParams;
    delete base.model;
    delete base.intervalM;
    const p = buildExportProvenance(base as unknown as AnalyseContoursResult, OPTS);
    expect(p.contourStyle).toBeNull();
    expect(p.contourStyleLabel).toBe('unknown');
    expect(p.contourIntervalM).toBeNull();
  });

  it('defaults software + metric version to "unknown" when not supplied', () => {
    const p = buildExportProvenance(readyResult());
    expect(p.softwareVersion).toBe('unknown');
    expect(p.metricVersion).toBe('unknown');
    expect(p.source).toBeNull();
  });
});

describe('provenanceLines / provenanceJson — shape + identical values', () => {
  const p: ExportProvenance = buildExportProvenance(readyResult(), OPTS);

  it('lines carry every meaningful field with consistent wording', () => {
    const text = provenanceLines(p).join('\n');
    expect(text).toMatch(/Software\s+OpenLiDARViewer 9\.9\.9/);
    expect(text).toMatch(/Metric version\s+v0\.4\.1/);
    expect(text).toMatch(/Generated\s+2026-06-05T00:00:00\.000Z/);
    expect(text).toMatch(/Horizontal CRS\s+EPSG:32610/);
    expect(text).toMatch(/Vertical datum\s+EPSG:5703/);
    expect(text).toMatch(/Coverage\s+full/);
    expect(text).toMatch(/Contour interval\s+1 m/);
    expect(text).toMatch(/Contour style\s+Smooth/);
    expect(text).toMatch(/Surface quality\s+Good/);
    expect(text).toMatch(/Export readiness\s+Ready/);
    expect(text).toMatch(/USGS 3DEP\s+QL2/);
    expect(text).toMatch(/not survey-grade/i);
  });

  it('json mirrors the line values exactly', () => {
    const j = provenanceJson(p);
    expect(j.software).toBe(SOFTWARE_NAME);
    expect(j.softwareVersion).toBe('9.9.9');
    expect(j.metricVersion).toBe('v0.4.1');
    expect(j.horizontalCrs).toBe('EPSG:32610');
    expect(j.verticalDatum).toBe('EPSG:5703');
    expect(j.contourStyle).toBe('smooth');
    expect(j.contourStyleLabel).toBe('Smooth');
    expect(j.surfaceQuality).toBe('Good');
    expect(j.exportReadiness).toBe('Ready');
    expect((j.accuracy as { usgsQualityLevel: string }).usgsQualityLevel).toBe('QL2');
    expect(j.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(Array.isArray(j.warnings)).toBe(true);
  });

  it('preview / unknown-CRS provenance shows the reason in the readiness line', () => {
    const base = readyResult() as unknown as { dtm: Record<string, unknown>; quality: Record<string, unknown> };
    const preview = {
      ...(base as unknown as AnalyseContoursResult),
      dtm: { ...base.dtm, crs: null },
      quality: { ...base.quality, crsKnown: false },
    } as unknown as AnalyseContoursResult;
    const pv = buildExportProvenance(preview, OPTS);
    const line = provenanceLines(pv).find((l) => l.startsWith('Export readiness'));
    expect(line).toMatch(/Preview\s+—\s+.*unknown/i);
  });
});
