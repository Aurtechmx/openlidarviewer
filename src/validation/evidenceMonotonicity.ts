/**
 * evidenceMonotonicity.ts — the invariant that a derived terrain product may
 * never present as MORE authoritative than the input it was derived from
 * (validation-only; imported by studies and tests, not by the viewer).
 *
 * A transformation — DTM → slope, DTM → contours, contours → smoothed contours —
 * can lose authority (a shakier surface makes shakier contours) or hold it, but
 * it can never manufacture it. The same applies to coverage: a product built
 * from resident-only streamed points is resident-only however cleanly it
 * finished, and a sampled input never becomes a full-dataset claim just because
 * a later stage succeeded. These are ordered ladders, and a valid transition
 * never moves UP one.
 *
 * Pure, deterministic, no I/O. Each ladder is stated most-authoritative first;
 * an unknown label is treated as its own floor (rank -1) so a typo fails closed
 * rather than silently passing.
 */

/** Export-readiness tier (src/terrain/quality/readinessEngine.ts vocabulary). */
export const READINESS_LADDER = ['Ready', 'Preview', 'Blocked'] as const;
/** Per-product grade (readinessEngine `ProductGradeStatus`). */
export const PRODUCT_GRADE_LADDER = ['good', 'caution', 'blocked'] as const;
/** Coverage of the source universe (ProcessPlan / streaming vocabulary). */
export const COVERAGE_LADDER = ['full', 'sampled', 'resident-only'] as const;
/** Export-gate evidence status (src/validation/exportEvidenceNote.ts). */
export const EVIDENCE_LADDER = ['validated', 'exploratory', 'refused'] as const;

/** Authority rank within a ladder: 0 = most authoritative; unknown = -1 (floor). */
export function rankIn(ladder: readonly string[], label: string): number {
  const i = ladder.indexOf(label);
  return i;
}

/**
 * True when moving `from` → `to` does not gain authority within `ladder`.
 * Equal or lower authority is valid; strengthening is not. An unknown `to`
 * (rank -1) is always valid (it cannot be more authoritative than anything);
 * an unknown `from` is a floor, so only an unknown `to` can follow it — a typo
 * on the input side fails closed.
 */
export function isNonPromoting(ladder: readonly string[], from: string, to: string): boolean {
  const rf = rankIn(ladder, from);
  const rt = rankIn(ladder, to);
  if (rt === -1) return true; // unknown target cannot out-rank anything
  if (rf === -1) return false; // known target under an unknown source: fail closed
  return rt >= rf; // higher index = less authoritative = allowed
}

/** A derived product's authority may not exceed its source's, on the given ladder. */
export function isValidEvidenceTransition(
  ladder: readonly string[],
  sourceState: string,
  derivedState: string,
): boolean {
  return isNonPromoting(ladder, sourceState, derivedState);
}

/**
 * Coverage may only stay the same or narrow. `resident-only` never becomes
 * `sampled` or `full`, and `sampled` never becomes `full`, no matter how cleanly
 * a derived stage completed — the classic "processed all available points"
 * misread of source-universe completeness.
 */
export function isValidCoverageTransition(
  sourceCoverage: string,
  derivedCoverage: string,
): boolean {
  return isNonPromoting(COVERAGE_LADDER, sourceCoverage, derivedCoverage);
}

/** Validate a whole derivation chain link by link on one ladder. */
export function validateChain(
  ladder: readonly string[],
  chain: readonly string[],
): { valid: boolean; brokenAt: number } {
  for (let i = 1; i < chain.length; i++) {
    if (!isNonPromoting(ladder, chain[i - 1], chain[i])) return { valid: false, brokenAt: i };
  }
  return { valid: true, brokenAt: -1 };
}
