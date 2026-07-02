/**
 * demAccuracyStandards.ts
 *
 * Express the DEM's measured vertical accuracy in the terms a surveyor or
 * agency reviewer expects — the ASPRS 2014 / USGS 3DEP vocabulary — instead of
 * a bare RMSE:
 *
 *   NVA  Non-vegetated Vertical Accuracy at 95% confidence = RMSEz × 1.9600
 *        (valid where error is ~Gaussian: open, bare ground).
 *   VVA  Vegetated Vertical Accuracy at the 95th percentile = the 95th
 *        percentile of the ABSOLUTE residuals (non-parametric, because error
 *        under canopy is skewed — so NOT RMSEz × 1.96).
 *   QL   USGS 3DEP Quality Level, the joint (point-density, RMSEz) grade the
 *        national elevation program collects against. QL2 ("≥2 pts/m² and
 *        ≤0.10 m RMSEz") is the 3DEP baseline.
 *
 * HONESTY BOUNDARY: the RMSEz/p95 fed in here come from HOLD-OUT validation
 * (internally withheld ground points), not from the independent survey
 * checkpoints ASPRS 2014 defines NVA/VVA against — and the VVA-analog is the
 * p95 of ALL residuals, not vegetated-class checkpoints. The FORMULAS are
 * ASPRS's; the CLAIM is an estimate. Every user-facing surface must qualify
 * the figures as "-style (hold-out)" and the QL as "(estimated)"; see
 * `verticalAccuracy.ts` for the full statement of this boundary.
 *
 * Pure data: no DOM, no I/O. Deterministic. Arithmetic only — the inputs are
 * already produced by the hold-out validation and the cell-metric rollup.
 */

import { NVA_95_MULTIPLIER } from '../validate/verticalAccuracy';

/**
 * The 95%-confidence multiplier for a normally-distributed vertical error.
 * Single-sourced from {@link NVA_95_MULTIPLIER} so the two surfaces can never
 * drift; kept under the local `NVA_K` name for existing callers and tests.
 */
export const NVA_K = NVA_95_MULTIPLIER;

export type UsgsQualityLevel = 'QL0' | 'QL1' | 'QL2' | 'QL3' | 'below-QL3' | 'unknown';

export interface DemAccuracyStandards {
  /** Measured RMSEz in metres (null when not assessable). */
  readonly rmseZM: number | null;
  /** Non-vegetated Vertical Accuracy (95% conf) = RMSEz × 1.96, metres. */
  readonly nvaM: number | null;
  /** Vegetated Vertical Accuracy = 95th percentile of |residual|, metres. */
  readonly vvaM: number | null;
  /** Mean ground returns per square metre. */
  readonly pointDensityPerM2: number;
  /** Best USGS 3DEP Quality Level the data satisfies on BOTH density + RMSEz. */
  readonly qualityLevel: UsgsQualityLevel;
  /** Human-readable basis for the QL verdict. */
  readonly qualityLevelReason: string;
}

/** USGS 3DEP joint density (pts/m²) + RMSEz (m) thresholds, best level first. */
const QL_TABLE: ReadonlyArray<{
  level: Exclude<UsgsQualityLevel, 'below-QL3' | 'unknown'>;
  minDensity: number;
  maxRmseM: number;
}> = [
  { level: 'QL0', minDensity: 8, maxRmseM: 0.05 },
  { level: 'QL1', minDensity: 8, maxRmseM: 0.1 },
  { level: 'QL2', minDensity: 2, maxRmseM: 0.1 },
  { level: 'QL3', minDensity: 0.25, maxRmseM: 0.2 },
];

/**
 * Derive the standards block from the measured RMSEz (metres), the 95th-
 * percentile absolute residual (metres, = VVA), and the mean ground-return
 * density (pts/m²). RMSEz/VVA may be null when there weren't enough held-out
 * points to validate.
 */
export function demAccuracyStandards(
  rmseZM: number | null,
  vvaM: number | null,
  pointDensityPerM2: number,
): DemAccuracyStandards {
  const rmseOk = rmseZM != null && Number.isFinite(rmseZM) && rmseZM >= 0;
  const density = Number.isFinite(pointDensityPerM2) && pointDensityPerM2 > 0 ? pointDensityPerM2 : 0;

  let qualityLevel: UsgsQualityLevel;
  let qualityLevelReason: string;
  if (!rmseOk || density <= 0) {
    qualityLevel = 'unknown';
    qualityLevelReason = !rmseOk
      ? 'Not enough validated points to measure RMSEz.'
      : 'No measured ground density.';
  } else {
    const rmse = rmseZM as number;
    const match = QL_TABLE.find((q) => density >= q.minDensity && rmse <= q.maxRmseM);
    if (match) {
      qualityLevel = match.level;
      qualityLevelReason = `${density.toFixed(1)} pts/m² and ${rmse.toFixed(2)} m RMSEz meet ${match.level}.`;
    } else {
      qualityLevel = 'below-QL3';
      qualityLevelReason = `${density.toFixed(1)} pts/m² / ${rmse.toFixed(2)} m RMSEz is below USGS QL3.`;
    }
  }

  return {
    rmseZM: rmseOk ? (rmseZM as number) : null,
    nvaM: rmseOk ? (rmseZM as number) * NVA_K : null,
    vvaM: vvaM != null && Number.isFinite(vvaM) ? vvaM : null,
    pointDensityPerM2: density,
    qualityLevel,
    qualityLevelReason,
  };
}
