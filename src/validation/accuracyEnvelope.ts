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
  /** Root-mean-square error in metres: finite and non-negative. */
  readonly rmseM: number;
  /** Independent checkpoints behind the figure: a positive integer, at least {@link minSample}. */
  readonly n: number;
  /**
   * The study's own sample rule: the smallest checkpoint count it accepts for
   * a figure (the `minSample` a `checkpointAccuracy.ts` run was configured
   * with). A positive integer; a claim without one is refused.
   */
  readonly minSample: number;
  /** Where the figure comes from (study id, report path or DOI). Required. */
  readonly evidenceRef: string;
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
 * Why a claim itself cannot support a figure, before any envelope question:
 * an RMSE that is not a finite non-negative length, a sample count that is not
 * a positive integer meeting the study's own minimum, or no evidence reference.
 * Null when the claim is sound. The claim may arrive from a JSON file, so every
 * field is checked at runtime rather than trusted from its type.
 */
export function accuracyClaimProblem(claim: AccuracyClaim): AccuracyDecision | null {
  const refuse = (reasonCode: string, reason: string): AccuracyDecision => ({ allowed: false, reason, reasonCode });
  if (typeof claim.rmseM !== 'number' || !Number.isFinite(claim.rmseM) || claim.rmseM < 0) {
    return refuse('INVALID_RMSE', `The accuracy claim's RMSE (${String(claim.rmseM)}) is not a finite non-negative length, so no figure is shown.`);
  }
  if (!Number.isInteger(claim.n) || claim.n < 1) {
    return refuse('INVALID_SAMPLE_COUNT', `The accuracy claim's checkpoint count (${String(claim.n)}) is not a positive integer, so no figure is shown.`);
  }
  if (!Number.isInteger(claim.minSample) || claim.minSample < 1) {
    return refuse('INVALID_SAMPLE_RULE', 'The accuracy claim does not state its study\'s minimum checkpoint count as a positive integer, so no figure is shown.');
  }
  if (claim.n < claim.minSample) {
    return refuse('BELOW_STUDY_MINIMUM', `The accuracy claim rests on ${claim.n} checkpoints, below the ${claim.minSample} its study requires, so no figure is shown.`);
  }
  if (typeof claim.evidenceRef !== 'string' || claim.evidenceRef.trim() === '') {
    return refuse('MISSING_EVIDENCE', 'The accuracy claim cites no evidence, so no figure is shown.');
  }
  return null;
}

/**
 * Fail-closed accuracy display: return the figure ONLY when the claim itself is
 * sound (see {@link accuracyClaimProblem}) and the scan is inside the claim's
 * validated envelope; otherwise refuse with a reason. A refusal is not "no
 * accuracy" — it is "this scan was not validated", which the UI states rather
 * than showing a number that does not apply.
 */
export function accuracyFigureFor(scan: ScanContext, claim: AccuracyClaim): AccuracyDecision {
  const problem = accuracyClaimProblem(claim);
  if (problem) return problem;
  if (!isWithinEnvelope(claim.envelope, scan)) {
    return {
      allowed: false,
      reason: 'This scan is outside the conditions the accuracy figure was validated under (biome / relief / sensor / datum), so no survey-grade figure is shown.',
      reasonCode: 'OUTSIDE_ENVELOPE',
    };
  }
  return { allowed: true, rmseM: claim.rmseM, reason: `Within the validated envelope (N=${claim.n}; evidence: ${claim.evidenceRef}).`, reasonCode: 'WITHIN_ENVELOPE' };
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
