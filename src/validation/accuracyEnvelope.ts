/**
 * accuracyEnvelope.ts — an absolute-accuracy figure is only valid inside the
 * conditions it was measured in, and only as independent as its reference.
 *
 * A surveyed-checkpoint result (e.g. "DTM vertical RMSE 2.8 cm") is measured on
 * one biome, one relief band, one sensor class, under one vertical-datum
 * situation. Presenting that number for a scan outside those conditions is
 * overgeneralisation. This module carries the VALIDATION ENVELOPE with each
 * accuracy claim and answers, fail-closed, whether a given scan is covered:
 * an unknown scan fact, or a scan outside the envelope, gets no survey-grade
 * figure — the same discipline OLV already applies to unknown units and
 * coverage, extended to accuracy provenance.
 *
 * It also carries a CONFOUNDER: when the checkpoint truth and the gridded points
 * come from the same upstream solution (e.g. one photogrammetric bundle), the
 * comparison is not fully independent and the evidence level is capped below the
 * external tier. Pure and deterministic; no runtime dependency.
 */

import { type EvidenceLevel, evidenceRank } from './evidenceLevel';

export type Biome = 'coastal-marsh' | 'bare-dune' | 'forest' | 'urban' | 'riparian' | 'slope' | 'plain' | 'unknown';
export type ReliefBand = 'flat' | 'low' | 'moderate' | 'steep' | 'unknown';
export type SensorClass = 'airborne-lidar' | 'uav-lidar' | 'uav-photogrammetry' | 'terrestrial-lidar' | 'unknown';
/** How the scan's vertical datum relates to the checkpoint/reference datum. */
export type DatumMatch = 'matched' | 'reconciled' | 'unreconciled' | 'unknown';

/** The conditions an absolute-accuracy figure was actually validated under. */
export interface ValidationEnvelope {
  readonly biomes: readonly Biome[];
  readonly reliefBands: readonly ReliefBand[];
  readonly sensorClasses: readonly SensorClass[];
  /** The weakest datum-match handling the validation covered. */
  readonly datumMatch: DatumMatch;
}

/** The facts about the scan a figure is being requested for. */
export interface ScanContext {
  readonly biome: Biome;
  readonly reliefBand: ReliefBand;
  readonly sensorClass: SensorClass;
  readonly datumMatch: DatumMatch;
}

/** An absolute-accuracy claim, scoped to the envelope it was measured in. */
export interface AccuracyClaim {
  readonly id: string;
  readonly rmseM: number;
  readonly n: number;
  readonly envelope: ValidationEnvelope;
  /**
   * True when the checkpoint truth and the gridded points share an upstream
   * solution (the same photogrammetric bundle, the same lidar adjustment), so
   * the comparison leans toward self-consistency rather than full independence.
   */
  readonly sharedSolutionWithReference: boolean;
}

/** Datum-match strength ordering: matched > reconciled > unreconciled ≈ unknown. */
const DATUM_RANK: Record<DatumMatch, number> = { matched: 3, reconciled: 2, unreconciled: 1, unknown: 0 };
function datumAtLeast(scan: DatumMatch, required: DatumMatch): boolean {
  return DATUM_RANK[scan] >= DATUM_RANK[required];
}

/**
 * Whether a scan falls inside the envelope a claim was validated in. Fail-closed:
 * any unknown scan fact, or a datum situation weaker than the validation's, means
 * NOT covered.
 */
export function isWithinEnvelope(env: ValidationEnvelope, scan: ScanContext): boolean {
  if (scan.biome === 'unknown' || scan.reliefBand === 'unknown' || scan.sensorClass === 'unknown' || scan.datumMatch === 'unknown') {
    return false;
  }
  if (!datumAtLeast(scan.datumMatch, env.datumMatch)) return false;
  return env.biomes.includes(scan.biome)
    && env.reliefBands.includes(scan.reliefBand)
    && env.sensorClasses.includes(scan.sensorClass);
}

export interface AccuracyDecision {
  /** May a survey-grade accuracy figure be presented for this scan? */
  readonly allowed: boolean;
  readonly rmseM?: number;
  readonly reason: string;
  /** Greppable UPPER_SNAKE code. */
  readonly reasonCode: string;
}

/**
 * Fail-closed accuracy display: return the figure ONLY when the scan is inside
 * the claim's validated envelope; otherwise refuse with a reason. A refusal is
 * not "no accuracy" — it is "this scan was not validated", which the UI states
 * rather than showing a number that does not apply.
 */
export function accuracyFigureFor(scan: ScanContext, claim: AccuracyClaim): AccuracyDecision {
  if (!isWithinEnvelope(claim.envelope, scan)) {
    return {
      allowed: false,
      reason: 'This scan is outside the conditions the accuracy figure was validated under (biome / relief / sensor / datum), so no survey-grade figure is shown.',
      reasonCode: 'OUTSIDE_ENVELOPE',
    };
  }
  return { allowed: true, rmseM: claim.rmseM, reason: `Within the validated envelope (N=${claim.n}).`, reasonCode: 'WITHIN_ENVELOPE' };
}

/**
 * Cap a checkpoint leg's evidence level for the shared-solution confounder: a
 * comparison whose truth shares an upstream solution with the gridded points is
 * not externally independent, so it cannot reach the external tier — it holds at
 * the cross-implementation tier. A claim without the confounder is unchanged.
 */
export function confounderCappedLevel(nominal: EvidenceLevel, claim: AccuracyClaim): EvidenceLevel {
  if (claim.sharedSolutionWithReference && evidenceRank(nominal) >= evidenceRank('E5_EXTERNALLY_VALIDATED')) {
    return 'E4_CROSS_IMPLEMENTATION_VALIDATED';
  }
  return nominal;
}
