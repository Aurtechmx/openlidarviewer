import { describe, it, expect } from 'vitest';
import {
  terrainAssessment,
  type SupportingMetric,
} from '../src/terrain/contour/terrainAssessment';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import type { DtmQualityReport } from '../src/terrain/quality/dtmQualityGate';
import type { TerrainQualityScore } from '../src/terrain/quality/terrainQualityScore';
import type { CellMetricsSummary } from '../src/terrain/quality/cellMetrics';
import type { DemAccuracyStandards } from '../src/terrain/quality/demAccuracyStandards';
import type { CellStatusTally } from '../src/terrain/quality/dtmCellStatus';
import type { TerrainCoverageMode } from '../src/terrain/TerrainContracts';

interface FixtureOpts {
  readiness?: DtmQualityReport['readiness'];
  reasons?: string[];
  score?: number;
  interpolatedFraction?: number; // 0..1 of covered cells that are NOT measured
  emptyFraction?: number; // 0..1 of grid that is empty
  edgeRiskRatio?: number; // 0..1 of measured cells on the boundary
  crs?: string | null;
  verticalDatum?: string | null;
  coverageMode?: TerrainCoverageMode;
  groundPointRatio?: number;
  meanDensity?: number; // pts/m²
  rmseZM?: number | null;
}

/**
 * Build an AnalyseContoursResult skeleton populated only with the fields the
 * assessment reads. Defaults describe a clean, fully-georeferenced, dense scan
 * so individual tests can toggle a single weakness and assert the cap.
 */
function fixture(o: FixtureOpts = {}): AnalyseContoursResult {
  const interpFrac = o.interpolatedFraction ?? 0;
  const emptyFrac = o.emptyFraction ?? 0;
  const edge = o.edgeRiskRatio ?? 0;
  // 100 covered cells, split measured / interpolated by interpFrac.
  const covered = 100;
  const interpolated = Math.round(covered * interpFrac);
  const measured = covered - interpolated;
  const empty = Math.round((covered / (1 - emptyFrac || 1)) * emptyFrac);
  const tally: CellStatusTally = {
    measured,
    interpolated,
    empty,
    lowConfidence: 0,
    edgeRisk: 0,
    total: covered + empty,
  };
  const quality: Partial<DtmQualityReport> = {
    readiness: o.readiness ?? 'ready',
    exportReadiness: (o.readiness ?? 'ready') === 'ready' ? 'available' : (o.readiness ?? 'ready') === 'blocked' ? 'blocked' : 'previewOnly',
    reasons: o.reasons ?? [],
    measuredCellRatio: measured / (covered + empty),
    interpolatedCellRatio: interpolated / (covered + empty),
    emptyCellRatio: empty / (covered + empty),
    edgeRiskRatio: edge,
    meanCellConfidence: 80,
    holdoutRmseM: o.rmseZM ?? 0.08,
    groundPointRatio: o.groundPointRatio ?? 0.7,
    coverageMode: o.coverageMode ?? 'full',
    crsKnown: (o.crs ?? 'EPSG:32610') != null,
    datumKnown: (o.verticalDatum ?? 'EPSG:5703') != null,
  };
  const qualityScore: Partial<TerrainQualityScore> = {
    score: o.score ?? 82,
    band: 'good',
    components: [],
  };
  const cellMetrics: Partial<CellMetricsSummary> = {
    measuredCellCount: measured,
    meanDensity: o.meanDensity ?? 6,
    medianDensity: o.meanDensity ?? 6,
    meanCompleteness: 0.9,
    edgeRiskRatio: edge,
  };
  const rmseZM = o.rmseZM === undefined ? 0.08 : o.rmseZM;
  const accuracyStandards: Partial<DemAccuracyStandards> = {
    rmseZM,
    nvaM: rmseZM != null ? rmseZM * 1.96 : null,
    vvaM: 0.12,
    pointDensityPerM2: o.meanDensity ?? 6,
    qualityLevel: 'QL2',
    qualityLevelReason: 'meets QL2',
  };
  return {
    quality: quality as DtmQualityReport,
    qualityScore: qualityScore as TerrainQualityScore,
    cellMetrics: cellMetrics as CellMetricsSummary,
    accuracyStandards: accuracyStandards as DemAccuracyStandards,
    cellStatusTally: tally,
    dtm: {
      coverageMode: o.coverageMode ?? 'full',
      crs: o.crs === undefined ? 'EPSG:32610' : o.crs,
      verticalDatum: o.verticalDatum === undefined ? 'EPSG:5703' : o.verticalDatum,
    },
  } as unknown as AnalyseContoursResult;
}

function findMetric(metrics: ReadonlyArray<SupportingMetric>, label: string): SupportingMetric | undefined {
  return metrics.find((m) => m.label === label);
}

function allText(a: ReturnType<typeof terrainAssessment>): string {
  return [a.reason, a.bestFor, a.useCaution, a.notRecommendedFor, ...a.supportingMetrics.map((m) => `${m.label} ${m.value}`)].join(' ');
}

describe('terrainAssessment', () => {
  it('is Good only when every signal is green, folding in the score', () => {
    const a = terrainAssessment(fixture({ score: 84 }));
    expect(a.status).toBe('Good');
    expect(a.score).toBe(84);
    expect(a.useCaution).toBe('');
    expect(a.bestFor).toMatch(/terrain products/i);
    expect(a.notRecommendedFor).toMatch(/legally require certified/i);
  });

  it('is Blocked (not Limited) when the quality gate is blocked', () => {
    const a = terrainAssessment(fixture({ readiness: 'blocked', reasons: ['Too sparse'] }));
    expect(a.status).toBe('Blocked');
    expect(a.notRecommendedFor).toMatch(/terrain products|DEM export|contour/i);
  });

  it('is Blocked when there is effectively no usable DTM (no covered cells)', () => {
    const f = fixture();
    (f.cellStatusTally as { measured: number }).measured = 0;
    (f.cellStatusTally as { interpolated: number }).interpolated = 0;
    const a = terrainAssessment(f);
    expect(a.status).toBe('Blocked');
  });

  it('caps below Good when the CRS is unknown, and says so', () => {
    const a = terrainAssessment(fixture({ crs: null, score: 90 }));
    expect(a.status).not.toBe('Good');
    expect(a.status).toBe('Preview');
    const crs = findMetric(a.supportingMetrics, 'CRS');
    expect(crs?.value).toMatch(/unknown/i);
    expect(crs?.rating).toBe('unknown');
    expect(allText(a)).toMatch(/CRS|coordinate/i);
  });

  it('caps below Good when the vertical datum is unknown', () => {
    const a = terrainAssessment(fixture({ verticalDatum: null, score: 90 }));
    expect(a.status).not.toBe('Good');
    const datum = findMetric(a.supportingMetrics, 'Vertical datum');
    expect(datum?.value).toMatch(/unknown/i);
    expect(datum?.rating).toBe('unknown');
  });

  it('caps below Good when interpolation is high', () => {
    const a = terrainAssessment(fixture({ interpolatedFraction: 0.55, score: 88 }));
    expect(a.status).not.toBe('Good');
    const interp = findMetric(a.supportingMetrics, 'Interpolation');
    expect(interp?.value).toMatch(/%/);
    expect(interp?.rating).toBe('poor');
  });

  it('caps below Good when ground visibility / density is low', () => {
    const a = terrainAssessment(fixture({ meanDensity: 0.3, groundPointRatio: 0.05, score: 85 }));
    expect(a.status).not.toBe('Good');
  });

  it('makes resident-only coverage visible and never reads as Good', () => {
    const a = terrainAssessment(fixture({ coverageMode: 'resident-only', score: 90 }));
    expect(a.status).not.toBe('Good');
    const cov = findMetric(a.supportingMetrics, 'Coverage');
    expect(cov?.value).toMatch(/resident/i);
    expect(cov?.rating).not.toBe('good');
  });

  it('makes sampled coverage visible and never reads as Good', () => {
    const a = terrainAssessment(fixture({ coverageMode: 'sampled', score: 90 }));
    expect(a.status).not.toBe('Good');
    const cov = findMetric(a.supportingMetrics, 'Coverage');
    expect(cov?.value).toMatch(/sampled/i);
  });

  it('populates supportingMetrics with the required labels', () => {
    const a = terrainAssessment(fixture());
    const labels = a.supportingMetrics.map((m) => m.label);
    for (const required of [
      'Coverage',
      'Ground density',
      'DTM quality',
      'Interpolation',
      'Empty cells',
      'Edge risk',
      'Vertical RMSE',
      'CRS',
      'Vertical datum',
    ]) {
      expect(labels).toContain(required);
    }
  });

  it('shows unknown (never fabricated) when RMSE is not assessable', () => {
    const a = terrainAssessment(fixture({ rmseZM: null }));
    const rmse = findMetric(a.supportingMetrics, 'Vertical RMSE');
    expect(rmse?.value).toMatch(/unknown/i);
    expect(rmse?.rating).toBe('unknown');
  });

  it('maps previewOnly to Preview and surfaces a plain reason', () => {
    const a = terrainAssessment(
      fixture({ readiness: 'previewOnly', reasons: ['Preview only: CRS is unknown.'], crs: null }),
    );
    expect(a.status).toBe('Preview');
    expect(a.reason.length).toBeGreaterThan(0);
    expect(a.notRecommendedFor).toMatch(/validation/i);
  });

  it('never makes a bare affirmative survey-grade / certified / guaranteed claim', () => {
    for (const f of [
      fixture(),
      fixture({ readiness: 'blocked', reasons: ['x'] }),
      fixture({ readiness: 'previewOnly', crs: null }),
      fixture({ coverageMode: 'resident-only' }),
      fixture({ interpolatedFraction: 0.6 }),
    ]) {
      const a = terrainAssessment(f);
      const text = allText(a);
      // Affirmative claims of survey-grade / certified / guaranteed accuracy
      // are forbidden. The honest phrasing names them only to disclaim them
      // (e.g. "uses that legally require certified survey data"), so we forbid
      // the bare affirmative pattern, not the word in a disclaiming context.
      expect(text).not.toMatch(/\bsurvey.?grade\b/i);
      expect(text).not.toMatch(/\bguaranteed\b/i);
      expect(text).not.toMatch(/professional accuracy/i);
    }
  });

  it('score reflects the qualityScore single source of truth', () => {
    const a = terrainAssessment(fixture({ score: 41 }));
    expect(a.score).toBe(41);
  });
});
