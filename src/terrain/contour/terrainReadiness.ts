/**
 * terrainReadiness.ts
 *
 * Pure-data leaf — turns a full `analyseContours` result into three
 * plain-language readiness indicators that a non-specialist can read at a
 * glance BEFORE committing to contour generation:
 *
 *   - Ground Confidence — how trustworthy the bare-earth surface is,
 *     read from the (calibrated) mean confidence and how much of it was
 *     actually measured vs interpolated.
 *   - DTM Quality — how much of the surface is real measurement, how big
 *     the validated vertical error is, and whether confidence is
 *     calibrated.
 *   - Contour Readiness — whether a reliable contour interval exists for
 *     this scan at all, and at what spacing.
 *
 * The point (per the product direction): never present raw contours as if
 * they were trustworthy before the confidence and DTM layers underneath
 * them are. These indicators surface that judgement honestly. Every
 * number here is already measured/validated upstream; this module only
 * classifies and phrases it.
 *
 * No DOM, no three.js, no I/O. Deterministic.
 */

import type { AnalyseContoursResult } from './analyseContours';

/** Ordered ratings, best → worst. `unavailable` = could not assess. */
export type ReadinessRating =
  | 'excellent'
  | 'strong'
  | 'good'
  | 'moderate'
  | 'weak'
  | 'unavailable';

/** One readiness indicator. */
export interface ReadinessIndicator {
  /** Short label, e.g. "Ground confidence". */
  readonly label: string;
  /** Classification of the headline value. */
  readonly rating: ReadinessRating;
  /** Headline value, already formatted, e.g. "92%" or "0.5 m". */
  readonly value: string;
  /** One plain-language supporting line. */
  readonly detail: string;
}

/** The three-indicator readiness summary. */
export interface TerrainReadiness {
  readonly groundConfidence: ReadinessIndicator;
  readonly dtmQuality: ReadinessIndicator;
  readonly contourReadiness: ReadinessIndicator;
  /** True when a reliable contour interval exists for this scan. */
  readonly contoursRecommended: boolean;
}

/** Per-coverage cell tallies over the DTM grid. */
interface CoverageTally {
  measured: number;
  interpolated: number;
  gap: number;
  covered: number; // measured + interpolated
  total: number;
}

function tallyCoverage(coverage: Uint8Array): CoverageTally {
  let measured = 0;
  let interpolated = 0;
  let gap = 0;
  for (let i = 0; i < coverage.length; i++) {
    if (coverage[i] === 2) measured++;
    else if (coverage[i] === 1) interpolated++;
    else gap++;
  }
  return {
    measured,
    interpolated,
    gap,
    covered: measured + interpolated,
    total: coverage.length,
  };
}

/** Map a 0..100 score to a rating with documented thresholds. */
function rate(score: number): ReadinessRating {
  if (!Number.isFinite(score)) return 'unavailable';
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'strong';
  if (score >= 55) return 'good';
  if (score >= 40) return 'moderate';
  return 'weak';
}

/** Demote a rating by one step (used when calibration is uncertain). */
function demote(r: ReadinessRating): ReadinessRating {
  const order: ReadinessRating[] = ['excellent', 'strong', 'good', 'moderate', 'weak'];
  const i = order.indexOf(r);
  if (i < 0) return r;
  return order[Math.min(order.length - 1, i + 1)];
}

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;

/** Compute the readiness indicators from an analysis result. */
export function computeTerrainReadiness(result: AnalyseContoursResult): TerrainReadiness {
  const cov = tallyCoverage(result.dtm.coverage);
  const meanConf = result.dtm.meanConfidence;
  const measuredFrac = cov.covered > 0 ? cov.measured / cov.covered : 0;
  const coverageFrac = cov.total > 0 ? cov.covered / cov.total : 0;
  const calibrated = result.confidenceCalibrationApplied;
  const tol = result.confidenceToleranceM;
  const rmse = result.validation.rmse;

  // ── Ground confidence ────────────────────────────────────────────────
  let groundRating = rate(meanConf);
  // A confident-looking surface that is mostly interpolated should not
  // read "excellent" — temper by how much was actually measured.
  if (groundRating !== 'unavailable' && measuredFrac < 0.5) {
    groundRating = demote(groundRating);
  }
  const groundConfidence: ReadinessIndicator = {
    label: 'Ground confidence',
    rating: groundRating,
    value: Number.isFinite(meanConf) ? pct(meanConf / 100) : '—',
    detail: !Number.isFinite(meanConf)
      ? 'No ground surface could be built for this scan.'
      : calibrated && tol != null
        ? `Calibrated to held-out error · ±${tol.toFixed(2)} m`
        : 'Heuristic estimate — not enough held-out points to calibrate.',
  };

  // ── DTM quality ──────────────────────────────────────────────────────
  // Driven by how much of the surface is real measurement; tempered by
  // whether the confidence is calibrated.
  let dtmRating = rate(measuredFrac * 100);
  if (dtmRating !== 'unavailable' && !calibrated) dtmRating = demote(dtmRating);
  const rmseText = Number.isFinite(rmse) ? `${rmse.toFixed(2)} m` : 'not measurable';
  const dtmQuality: ReadinessIndicator = {
    label: 'DTM quality',
    rating: cov.covered === 0 ? 'unavailable' : dtmRating,
    value: cov.covered === 0 ? '—' : `${pct(measuredFrac)} measured`,
    detail:
      cov.covered === 0
        ? 'No covered cells — nothing to model.'
        : `${pct(1 - measuredFrac)} interpolated · vertical RMSE ${rmseText}`,
  };

  // ── Contour readiness ────────────────────────────────────────────────
  const recommended = result.gate.recommendedM;
  const contoursRecommended = recommended != null;
  let contourRating: ReadinessRating;
  if (!contoursRecommended) {
    contourRating = 'unavailable';
  } else {
    // Readiness is no better than the weaker of the two layers beneath it.
    const groundScore = Number.isFinite(meanConf) ? meanConf : 0;
    const combined = Math.min(groundScore, measuredFrac * 100, coverageFrac * 100 + 20);
    contourRating = rate(combined);
  }
  const contourReadiness: ReadinessIndicator = {
    label: 'Contour readiness',
    rating: contourRating,
    value: contoursRecommended ? `${recommended} m` : 'Not ready',
    detail: contoursRecommended
      ? `Coverage ${pct(coverageFrac)} · relief ${result.elevationRangeM.toFixed(1)} m`
      : 'No reliable contour interval — the scan is too sparse or the vertical error is too high for honest contours.',
  };

  return { groundConfidence, dtmQuality, contourReadiness, contoursRecommended };
}
