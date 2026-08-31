/**
 * demAccuracyStandards.ts
 *
 * Express the DEM's measured vertical accuracy in the terms a surveyor or
 * agency reviewer expects — the ASPRS 2014 formula vocabulary — instead of a
 * bare RMSE, and place the measured GROUND-RETURN density against the USGS 3DEP
 * density figures as a REFERENCE:
 *
 *   NVA  Non-vegetated Vertical Accuracy at 95% confidence = RMSEz × 1.9600
 *        (valid where error is ~Gaussian: open, bare ground).
 *   VVA  Vegetated Vertical Accuracy at the 95th percentile = the 95th
 *        percentile of the ABSOLUTE residuals (non-parametric, because error
 *        under canopy is skewed — so NOT RMSEz × 1.96).
 *
 * WHY NO QUALITY-LEVEL GRADE. A USGS 3DEP Quality Level is a PULSE-density
 * determination (NPD/ANPD), measured from first returns with single-/usable-
 * swath context — not the mean GROUND-return density this module has. Ground
 * returns per square metre are not nominal pulse density, and a merged/tiled
 * cloud may not carry enough information to determine a collection QL at all.
 * So this module does NOT emit an "estimated QLx" grade from ground density +
 * hold-out RMSE. It reports the measured ground-return density and, as CONTEXT
 * only, which 3DEP nominal-pulse-density FLOORS that density clears — a
 * reference threshold, never a quality-level determination.
 *
 * HONESTY BOUNDARY: the RMSEz/p95 fed in here come from HOLD-OUT validation
 * (internally withheld ground points), not from the independent survey
 * checkpoints ASPRS 2014 defines NVA/VVA against — and the VVA-analog is the
 * p95 of ALL residuals, not vegetated-class checkpoints. The FORMULAS are
 * ASPRS's; the CLAIM is an estimate. Every user-facing surface qualifies the
 * figures as "-style (hold-out)"; see `verticalAccuracy.ts` for the full
 * statement of this boundary.
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

/** A USGS 3DEP quality level whose nominal-pulse-density floor is used here only
 *  as a REFERENCE threshold against measured ground-return density. */
export type UsgsDensityFloor = 'QL0' | 'QL1' | 'QL2' | 'QL3';

export interface DemAccuracyStandards {
  /** Measured RMSEz in metres (null when not assessable). */
  readonly rmseZM: number | null;
  /** Non-vegetated Vertical Accuracy (95% conf) = RMSEz × 1.96, metres. */
  readonly nvaM: number | null;
  /** Vegetated Vertical Accuracy = 95th percentile of |residual|, metres. */
  readonly vvaM: number | null;
  /**
   * Mean GROUND-return density (pts/m²). Named `pointDensityPerM2` for the
   * export-provenance schema that carries it; it is ground-return density, which
   * is NOT nominal pulse density (NPD/ANPD).
   */
  readonly pointDensityPerM2: number;
  /**
   * The USGS 3DEP nominal-pulse-density FLOORS the measured ground-return
   * density clears, strongest first — a REFERENCE comparison only. Empty when
   * the density is unknown or below the QL3 floor. Never a quality-level
   * determination: ground-return density is not a pulse-density measurement.
   */
  readonly densityReferenceFloorsMet: readonly UsgsDensityFloor[];
  /** Human-readable reference note for the density figure (context, not a grade). */
  readonly densityReferenceNote: string;
}

/**
 * USGS 3DEP nominal-pulse-density floors (pts/m²), transcribed from the USGS
 * Lidar Base Specification quality-level table. These are PULSE-density figures;
 * here they are used only as reference thresholds against measured ground-return
 * density. QL0 and QL1 share the same 8 pts/m² density floor (they differ by
 * RMSEz, which is not part of a density reference). Ordered strongest first.
 * `tests/qualityLevelOracle.test.ts` pins these against an independent
 * transcription.
 */
const DENSITY_FLOORS: ReadonlyArray<{ level: UsgsDensityFloor; minDensity: number }> = [
  { level: 'QL0', minDensity: 8 },
  { level: 'QL1', minDensity: 8 },
  { level: 'QL2', minDensity: 2 },
  { level: 'QL3', minDensity: 0.5 },
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

  const densityReferenceFloorsMet = density > 0
    ? DENSITY_FLOORS.filter((f) => density >= f.minDensity).map((f) => f.level)
    : [];

  let densityReferenceNote: string;
  if (density <= 0) {
    densityReferenceNote = 'No measured ground-return density.';
  } else {
    // The strongest floor cleared, named as a reference. QL0/QL1 share the 8
    // pts/m² floor, so report the first (strongest) distinct label.
    const strongest = densityReferenceFloorsMet[0];
    const floorText = strongest
      ? `clears the USGS 3DEP ${strongest} nominal-pulse-density floor`
      : 'is below the USGS 3DEP QL3 nominal-pulse-density floor (0.5 pulses/m²)';
    densityReferenceNote =
      `${density.toFixed(1)} ground returns/m² ${floorText}. ` +
      'Ground-return density is a reference against the 3DEP pulse-density figures, ' +
      'not a nominal-pulse-density (NPD/ANPD) determination or a quality-level grade.';
  }

  return {
    rmseZM: rmseOk ? (rmseZM as number) : null,
    nvaM: rmseOk ? (rmseZM as number) * NVA_K : null,
    vvaM: vvaM != null && Number.isFinite(vvaM) ? vvaM : null,
    pointDensityPerM2: density,
    densityReferenceFloorsMet,
    densityReferenceNote,
  };
}
