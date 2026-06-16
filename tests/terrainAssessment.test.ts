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

  // TWO-AXIS truth: an unknown CRS does NOT cap SURFACE quality (a clean, dense
  // surface stays Good) — it caps EXPORT READINESS to Preview, with a reason.
  // This is the new-correct behaviour, not a weakening: the honesty contract
  // (no survey-grade export without a known frame) lives on the export axis.
  it('unknown CRS leaves surface quality Good but caps EXPORT readiness to Preview, and says so', () => {
    const a = terrainAssessment(fixture({ crs: null, score: 90 }));
    expect(a.status).toBe('Good'); // surface quality NOT capped by CRS
    expect(a.exportReadiness).toBe('Preview'); // export gated by unknown CRS
    expect(a.exportReason).toMatch(/CRS/i);
    const crs = findMetric(a.supportingMetrics, 'CRS');
    expect(crs?.value).toMatch(/unknown/i);
    expect(crs?.rating).toBe('unknown');
  });

  it('unknown vertical datum leaves surface quality Good but caps EXPORT readiness to Preview', () => {
    const a = terrainAssessment(fixture({ verticalDatum: null, score: 90 }));
    expect(a.status).toBe('Good'); // surface quality NOT capped by datum
    expect(a.exportReadiness).toBe('Preview');
    expect(a.exportReason).toMatch(/datum/i);
    const datum = findMetric(a.supportingMetrics, 'Vertical datum');
    expect(datum?.value).toMatch(/unknown/i);
    expect(datum?.rating).toBe('unknown');
  });

  // The headline separation: the SAME clean, dense scene reads Good/Ready when
  // georeferenced, and Good/Preview (datum unknown) when the datum is dropped.
  it('separates the axes: known datum → Good + export Ready; null datum → Good + export Preview', () => {
    const known = terrainAssessment(fixture({ score: 90 }));
    expect(known.status).toBe('Good');
    expect(known.exportReadiness).toBe('Ready');
    expect(known.exportReason).toBe('');

    const noDatum = terrainAssessment(fixture({ verticalDatum: null, score: 90 }));
    expect(noDatum.status).toBe('Good'); // surface quality UNCHANGED
    expect(noDatum.exportReadiness).toBe('Preview'); // only export readiness drops
    expect(noDatum.exportReason).toMatch(/vertical datum unknown/i);
  });

  it('a blocked surface blocks export readiness too', () => {
    const a = terrainAssessment(fixture({ readiness: 'blocked', reasons: ['Too sparse'] }));
    expect(a.status).toBe('Blocked');
    expect(a.exportReadiness).toBe('Blocked');
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

  it('a Limited surface does not borrow the gate’s "Preview only" wording', () => {
    // Regression: a real project showed "Limited · 49/100" with the reason
    // "Preview only: 46% of cells are interpolated." — the Limited headline must
    // not describe itself as "preview only".
    const a = terrainAssessment(
      fixture({
        readiness: 'previewOnly',
        reasons: ['Preview only: 46% of cells are interpolated.'],
        interpolatedFraction: 0.46,
        score: 30, // below LIMITED_SCORE_FLOOR -> Limited
        crs: null,
        verticalDatum: null,
      }),
    );
    expect(a.status).toBe('Limited');
    expect(a.reason).not.toMatch(/preview only/i);
    expect(a.reason).toMatch(/insufficient/i);
    expect(a.reason).toMatch(/46% of the surface is interpolated/);
    // Export reason names both the surface limitation and the georef gaps, with
    // a clean separator (no awkward "...grade and CRS... and datum...").
    expect(a.exportReadiness).toBe('Preview');
    expect(a.exportReason).toContain('below export grade;');
    expect(a.exportReason).not.toMatch(/grade and/i);
  });

  it('makes resident-only coverage visible and never reads as Good', () => {
    const a = terrainAssessment(fixture({ coverageMode: 'resident-only', score: 90 }));
    expect(a.status).not.toBe('Good');
    const cov = findMetric(a.supportingMetrics, 'Scan scope');
    expect(cov?.value).toMatch(/resident/i);
    expect(cov?.rating).not.toBe('good');
  });

  it('makes sampled coverage visible and never reads as Good', () => {
    const a = terrainAssessment(fixture({ coverageMode: 'sampled', score: 90 }));
    expect(a.status).not.toBe('Good');
    const cov = findMetric(a.supportingMetrics, 'Scan scope');
    expect(cov?.value).toMatch(/sampled/i);
  });

  it('a resident-only PARTIAL STREAM stays Preview (not Limited) and reads as preliminary', () => {
    // The real-world case: a streaming COPC analysed on the few resident octree
    // nodes is sparse (high interpolation, ~all measured cells near a gap) — but
    // that reflects how little has loaded, not the scan. It must NOT render a
    // definitive "Limited"; the verdict stays Preview and the reason says so.
    const a = terrainAssessment(
      fixture({
        readiness: 'previewOnly',
        coverageMode: 'resident-only',
        interpolatedFraction: 0.49,
        edgeRiskRatio: 1.0,
        score: 56,
      }),
    );
    expect(a.status).toBe('Preview');
    expect(a.reason).toMatch(/preliminary/i);
    expect(a.reason).toMatch(/stream/i);
    expect(a.reason).not.toMatch(/insufficient quality/i);
    expect(a.reason).not.toMatch(/100% of measured cells/i);
  });

  it('the SAME deficiency on a fully-walked cloud IS Limited (guard is partial-stream-only)', () => {
    const a = terrainAssessment(
      fixture({
        readiness: 'previewOnly',
        coverageMode: 'full',
        interpolatedFraction: 0.49,
        edgeRiskRatio: 1.0,
        score: 56,
      }),
    );
    expect(a.status).toBe('Limited');
  });

  it('populates supportingMetrics with the required labels', () => {
    const a = terrainAssessment(fixture());
    const labels = a.supportingMetrics.map((m) => m.label);
    for (const required of [
      'Scan scope',
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

  // exportReason completeness: when a surface is BELOW Good *and* has a georef
  // gap, BOTH cap export — so the reason must name BOTH, not just one. Naming
  // only the georef gap (the old behaviour) was incomplete: it implied that
  // fixing the CRS/datum alone would make the surface exportable, when the
  // surface itself is also below export grade. This is a correctness fix.
  it('names BOTH the surface limitation and the georef gap when both hold export back', () => {
    const a = terrainAssessment(
      fixture({
        readiness: 'previewOnly',
        reasons: ['Preview only: mean confidence is low.'],
        crs: null,
        score: 70,
      }),
    );
    expect(a.exportReadiness).toBe('Preview');
    // The georef gap is named …
    expect(a.exportReason).toMatch(/CRS/i);
    // … AND the surface limitation is named too (one readable sentence).
    expect(a.exportReason).toMatch(/surface|preview|below/i);
  });

  it('names ONLY the georef gap when the surface is Good (unchanged behaviour)', () => {
    const a = terrainAssessment(fixture({ crs: null, verticalDatum: null, score: 90 }));
    expect(a.status).toBe('Good');
    expect(a.exportReadiness).toBe('Preview');
    expect(a.exportReason).toMatch(/CRS unknown/i);
    expect(a.exportReason).toMatch(/vertical datum unknown/i);
    // No surface limitation is named — the surface is Good, only georef holds it.
    expect(a.exportReason).not.toMatch(/below export grade|surface quality is below/i);
  });

  it('names ONLY the surface limitation when below Good with known CRS+datum (unchanged)', () => {
    const a = terrainAssessment(
      fixture({ readiness: 'previewOnly', reasons: ['Preview only: mean confidence is low.'], score: 70 }),
    );
    expect(a.exportReadiness).toBe('Preview');
    expect(a.exportReason).toMatch(/surface|below/i);
    expect(a.exportReason).not.toMatch(/CRS|datum/i);
  });

  it('maps previewOnly to Preview and surfaces a plain (surface) reason', () => {
    // The gate's surface verdict is previewOnly with a SURFACE reason (CRS/datum
    // are no longer surface reasons — they live on the export axis).
    const a = terrainAssessment(
      fixture({ readiness: 'previewOnly', reasons: ['Preview only: mean confidence is low.'] }),
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

  it('is Limited (weak-but-not-blocked) when the surface is seriously deficient', () => {
    // previewOnly readiness plus a composite score under the Limited floor and
    // sparse ground returns — a genuinely weak surface that the gate did not
    // outright block. This must read as Limited, not Preview.
    const a = terrainAssessment(
      fixture({
        readiness: 'previewOnly',
        score: 28,
        meanDensity: 0.3,
        groundPointRatio: 0.05,
      }),
    );
    expect(a.status).toBe('Limited');
    expect(a.bestFor).toMatch(/visual inspection/i);
    expect(a.useCaution).toMatch(/too incomplete/i);
  });

  it('is Limited when two or more supporting metrics are rated poor', () => {
    // High interpolation + high empty fraction => two poor metrics, but the
    // gate is only previewOnly (not blocked). Score stays above the floor so
    // the multi-poor rule is what drives Limited.
    const a = terrainAssessment(
      fixture({
        readiness: 'previewOnly',
        score: 60,
        interpolatedFraction: 0.55,
        emptyFraction: 0.55,
      }),
    );
    expect(a.status).toBe('Limited');
  });

  it('does not over-trigger Limited: a middling preview surface stays Preview', () => {
    // A single soft SURFACE weakness (resident-only coverage) on an otherwise
    // healthy, well-scored surface caps to Preview — it is not seriously
    // deficient, so not Limited. (CRS/datum no longer cap surface quality, so
    // the soft weakness here must be a surface signal.)
    const a = terrainAssessment(fixture({ coverageMode: 'resident-only', score: 75 }));
    expect(a.status).toBe('Preview');
  });

  it('keeps an all-green surface Good (Limited never raises or over-triggers)', () => {
    const a = terrainAssessment(fixture({ score: 90 }));
    expect(a.status).toBe('Good');
  });

  // ── Panel-math validation: the real interior-360 case (v0.4.5 field report) ──
  // A 360 interior COPC, terrain analysis forced: panel showed "Limited 52/100",
  // reason "72% of the surface is interpolated and 53% of cells are a long
  // interpolation", chips: coverage full, ground density 1047.3 pts/m², DTM
  // quality 52/100, interpolation 72%, empty cells 0%, edge risk 53%, vertical
  // RMSE 0.15 m, CRS unknown. This pins (a) the tier derivation (52 ≥ the
  // Limited score floor, so Limited comes from the 2-poor-metric rule AND the
  // severe-gap rule, interp 0.72 > 0.6), (b) that the reason sentence quotes the
  // SAME numbers the chips show, and (c) the wording fix: cellMetrics'
  // edgeRiskRatio counts MEASURED cells near the data boundary, so the reason
  // must no longer call them "a long interpolation from real returns" (that
  // phrase belongs to the gate's tally-based edgeRisk cell status only).
  describe('interior-360 field case (Limited 52/100)', () => {
    const a = terrainAssessment(
      fixture({
        readiness: 'previewOnly',
        reasons: ['Preview only: 72% of the surface is interpolated and 53% of cells are a long interpolation from real returns.'],
        interpolatedFraction: 0.72,
        edgeRiskRatio: 0.53,
        emptyFraction: 0,
        score: 52,
        meanDensity: 1047.3,
        rmseZM: 0.15,
        crs: null,
        verticalDatum: null,
      }),
    );

    it('maps the field numbers to Limited with the 52 score intact', () => {
      expect(a.status).toBe('Limited');
      expect(a.score).toBe(52);
      expect(a.scoreKnown).toBe(true);
      // 52 is ABOVE the Limited score floor (40): Limited is driven by the
      // two-poor-metric rule (interp 72% + edge 53%) and the severe-gap rule
      // (0.72 > 0.6) — both must independently hold for these numbers.
      const poor = a.supportingMetrics.filter((m) => m.rating === 'poor').map((m) => m.label);
      expect(poor).toContain('Interpolation');
      expect(poor).toContain('Edge risk');
      expect(poor.length).toBeGreaterThanOrEqual(2);
    });

    it('chips carry the field values with honest ratings', () => {
      expect(findMetric(a.supportingMetrics, 'Scan scope')?.value).toBe('full');
      expect(findMetric(a.supportingMetrics, 'Ground density')?.value).toBe('1047.3 pts/m²');
      expect(findMetric(a.supportingMetrics, 'Ground density')?.rating).toBe('good');
      expect(findMetric(a.supportingMetrics, 'DTM quality')?.value).toBe('52/100');
      expect(findMetric(a.supportingMetrics, 'DTM quality')?.rating).toBe('fair');
      expect(findMetric(a.supportingMetrics, 'Interpolation')?.value).toBe('72%');
      expect(findMetric(a.supportingMetrics, 'Empty cells')?.value).toBe('0%');
      expect(findMetric(a.supportingMetrics, 'Edge risk')?.value).toBe('53%');
      expect(findMetric(a.supportingMetrics, 'Vertical RMSE')?.value).toBe('0.15 m');
      expect(findMetric(a.supportingMetrics, 'Vertical RMSE')?.rating).toBe('fair');
      expect(findMetric(a.supportingMetrics, 'CRS')?.value).toBe('unknown');
    });

    it('the reason quotes the SAME percentages as the chips', () => {
      expect(a.reason).toMatch(/^Insufficient quality/);
      expect(a.reason).toContain('72% of the surface is interpolated');
      expect(a.reason).toContain('53% of measured cells sit at the edge of the data');
    });

    it('no longer mislabels boundary-measured cells as "a long interpolation"', () => {
      // cellMetrics.edgeRiskRatio cells ARE measured (they have real returns,
      // just near the data edge) — calling them interpolated was untrue.
      expect(a.reason).not.toMatch(/long interpolation/i);
    });

    it('export readiness is Preview, naming the surface limitation AND the georef gaps', () => {
      expect(a.exportReadiness).toBe('Preview');
      expect(a.exportReason).toContain('surface quality is below export grade');
      expect(a.exportReason).toMatch(/CRS unknown/);
      expect(a.exportReason).toMatch(/vertical datum unknown/);
    });
  });

  it('renders DTM quality as unknown (never 0/100) when qualityScore is absent', () => {
    const f = fixture();
    (f as { qualityScore: unknown }).qualityScore = undefined;
    const a = terrainAssessment(f);
    const dtm = findMetric(a.supportingMetrics, 'DTM quality');
    expect(dtm?.value).toMatch(/unknown/i);
    expect(dtm?.value).not.toMatch(/0\/100/);
    expect(dtm?.rating).toBe('unknown');
    expect(a.scoreKnown).toBe(false);
    // Status is unaffected by the missing score: gating depends on readiness.
    expect(a.status).toBe('Good');
  });
});
