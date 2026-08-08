/**
 * classificationEvidence.ts — the per-point / per-component evidence record for
 * a classification decision (Phase 3).
 *
 * Every derived class carries WHY it was assigned and how much to trust it: the
 * class, where it came from (producer / derived / manual), a support score, the
 * method version, greppable reason codes, and honesty flags. The support score
 * is a bounded heuristic in [0,1] — deliberately NOT called a calibrated
 * probability, because it is not one. Producer classes are trusted and preserved;
 * only DERIVED points with weak support are candidates for review-isolation.
 *
 * Pure data model + helpers. No side effects.
 */

export type ClassSource = 'producer' | 'derived' | 'manual';

export interface EvidenceFlags {
  /** Support below the review threshold. */
  readonly lowSupport: boolean;
  /** Support sits within a narrow band of the decision threshold. */
  readonly nearThreshold: boolean;
  /** A competing class scored comparably — the assignment is contested. */
  readonly conflicting: boolean;
}

export interface ClassificationEvidence {
  /** ASPRS class code assigned. */
  readonly classCode: number;
  readonly source: ClassSource;
  /** Bounded heuristic support in [0,1]. NOT a calibrated probability. */
  readonly support: number;
  /** Version of the method that produced this decision. */
  readonly methodVersion: string;
  /** Greppable UPPER_SNAKE reasons the class was chosen. */
  readonly reasonCodes: readonly string[];
  readonly flags: EvidenceFlags;
}

/** Support at or below this is treated as weak (review candidate). */
export const LOW_SUPPORT_THRESHOLD = 0.5;
/** Half-width of the band around a threshold that counts as "near". */
export const NEAR_THRESHOLD_BAND = 0.1;

export interface EvidenceInput {
  readonly classCode: number;
  readonly source: ClassSource;
  readonly support: number;
  readonly methodVersion: string;
  readonly reasonCodes?: readonly string[];
  /** The decision threshold the support was compared against, if any. */
  readonly decisionThreshold?: number;
  /** Best competing class support, if a competitor was evaluated. */
  readonly runnerUpSupport?: number;
}

/** Build an evidence record, deriving the honesty flags from the inputs. */
export function buildEvidence(input: EvidenceInput): ClassificationEvidence {
  const support = clamp01(input.support);
  const lowSupport = support <= LOW_SUPPORT_THRESHOLD;
  const nearThreshold = input.decisionThreshold !== undefined
    && Math.abs(support - clamp01(input.decisionThreshold)) <= NEAR_THRESHOLD_BAND;
  const conflicting = input.runnerUpSupport !== undefined
    && clamp01(input.runnerUpSupport) >= support - NEAR_THRESHOLD_BAND;
  return {
    classCode: input.classCode,
    source: input.source,
    support,
    methodVersion: input.methodVersion,
    reasonCodes: input.reasonCodes ?? [],
    flags: { lowSupport, nearThreshold, conflicting },
  };
}

/**
 * Whether a point should be isolated for review. Only DERIVED points qualify —
 * producer and manual classes are trusted and preserved. A derived point is a
 * review candidate when its support is weak, it sits near the threshold, or a
 * competing class scored comparably.
 */
export function isReviewUncertain(e: ClassificationEvidence): boolean {
  if (e.source !== 'derived') return false;
  return e.flags.lowSupport || e.flags.nearThreshold || e.flags.conflicting;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
