/**
 * evidenceBoundaryInspector.ts
 *
 * A human-auditable VIEW over {@link resolveEvidence}. It contains NO
 * applicability logic of its own: it calls the resolver, copies the resolver's
 * decision verbatim, and adds a per-envelope-field breakdown that EXPLAINS why
 * the artifact context did or did not fall inside a scoped study's envelope.
 *
 * The distinction matters. `resolveEvidence` is the single authority on whether
 * external evidence applies; this module must never recompute or override its
 * `effectiveEvidence` / `resolutionState`. It only projects that result plus a
 * field-by-field comparison, so a reader can see exactly which envelope key
 * matched, mismatched, was missing from the context, or was left unconstrained.
 *
 * Pure: it builds a plain object from the resolver's output. No DOM, no I/O.
 */

import { resolveEvidence } from './scopedEvidence';
import type {
  ScopedEvidenceRecord,
  EvidenceContext,
  ApplicabilityEnvelope,
} from './scopedEvidence';
import { evidenceRank } from './evidenceLevel';

/** The per-field verdict of one envelope key against the artifact context. */
export type EnvelopeCheckStatus = 'match' | 'mismatch' | 'missing' | 'unconstrained';

/** One row of the envelope breakdown: what the record pinned vs what the context carried. */
export interface EnvelopeCheck {
  /** The envelope field name (a key of {@link ApplicabilityEnvelope}). */
  readonly field: string;
  /** The value the record's envelope pins for this field (undefined when unconstrained). */
  readonly expected: unknown;
  /** The value the artifact context supplies for this field (undefined when absent). */
  readonly observed: unknown;
  /**
   * `match`         — record pins it, context supplies an equal value;
   * `mismatch`      — record pins it, context supplies a differing value;
   * `missing`       — record pins it, context does not supply it;
   * `unconstrained` — the record does not pin this field.
   */
  readonly status: EnvelopeCheckStatus;
}

/**
 * A pure projection of one {@link resolveEvidence} lookup. The decision fields
 * (`effectiveEvidence`, `resolutionState`, `matchedStudy`, `applicabilityVerdict`,
 * `baselineEvidence`) are copied verbatim from the resolver; `envelopeChecks`
 * explains them field by field.
 */
export interface EvidenceContractView {
  readonly claimId: string;
  readonly baselineEvidence: string | null;
  readonly effectiveEvidence: string | null;
  /** Exactly `resolveEvidence`'s state string — never recomputed. */
  readonly resolutionState: string;
  readonly matchedStudy: string | null;
  readonly applicabilityVerdict: string;
  readonly envelopeChecks: readonly EnvelopeCheck[];
}

/**
 * The envelope keys, in a stable display order. Every key of
 * {@link ApplicabilityEnvelope} appears so the breakdown is complete: a field the
 * record omits is reported `unconstrained` rather than silently dropped.
 */
const ENVELOPE_FIELDS: readonly (keyof ApplicabilityEnvelope)[] = [
  'methodDigest',
  'horizontalEpsg',
  'verticalEpsg',
  'geoidModel',
  'verticalDatum',
  'terrainStratum',
  'studyArea',
  'slopeRange',
  'aggregation',
  'interpolation',
  'cellSize',
  'trustGroundClassification',
  'candidateRevision',
];

/** Compare one envelope field against the context; pure, decides nothing. */
function checkField(
  field: keyof ApplicabilityEnvelope,
  env: ApplicabilityEnvelope,
  ctx: EvidenceContext | undefined,
): EnvelopeCheck {
  const expected = env[field];
  if (expected === undefined) {
    // The record does not pin this field. Still surface any observed value.
    const observed =
      field === 'slopeRange' ? ctx?.slopeDegrees : (ctx as Record<string, unknown> | undefined)?.[field];
    return { field, expected: undefined, observed, status: 'unconstrained' };
  }

  if (field === 'slopeRange') {
    const [lo, hi] = expected as readonly [number, number];
    const observed = ctx?.slopeDegrees;
    if (observed === undefined) return { field, expected, observed, status: 'missing' };
    const status: EnvelopeCheckStatus = observed >= lo && observed <= hi ? 'match' : 'mismatch';
    return { field, expected, observed, status };
  }

  const observed = (ctx as Record<string, unknown> | undefined)?.[field];
  if (observed === undefined) return { field, expected, observed: undefined, status: 'missing' };
  return { field, expected, observed, status: observed === expected ? 'match' : 'mismatch' };
}

/**
 * Pick the record whose envelope the breakdown should explain: the record that
 * WOULD apply if any matched, otherwise the highest scoped level registered for
 * the claim (the one the resolver considers first). Returns null when the claim
 * has no scoped record — the caller then emits an empty breakdown.
 */
function selectRecord(
  matchedStudyId: string | null,
  forClaim: readonly ScopedEvidenceRecord[],
): ScopedEvidenceRecord | null {
  if (forClaim.length === 0) return null;
  if (matchedStudyId !== null) {
    const matched = forClaim.find((r) => r.studyId === matchedStudyId);
    if (matched) return matched;
  }
  return forClaim.reduce((best, r) =>
    best === null || evidenceRank(r.evidenceLevel) > evidenceRank(best.evidenceLevel) ? r : best,
    null as ScopedEvidenceRecord | null,
  );
}

/**
 * Build the auditable view for a claim. Calls {@link resolveEvidence} and copies
 * its decision verbatim, then attaches a per-envelope-field breakdown for the
 * record that would apply. NEVER recomputes or overrides the resolver's verdict.
 */
export function buildEvidenceContractView(
  claimId: string,
  context?: EvidenceContext,
  records?: readonly ScopedEvidenceRecord[],
): EvidenceContractView {
  const resolution =
    records === undefined
      ? resolveEvidence(claimId, context)
      : resolveEvidence(claimId, context, records);

  const forClaim = (records ?? []).filter((r) => r.claimId === claimId);
  const record = selectRecord(resolution.matchedScopedStudy, forClaim);

  const envelopeChecks =
    record === null
      ? []
      : ENVELOPE_FIELDS.map((f) => checkField(f, record.applicabilityEnvelope, context));

  return {
    claimId,
    baselineEvidence: resolution.baselineEvidence,
    effectiveEvidence: resolution.effectiveEvidence,
    resolutionState: resolution.resolutionState,
    matchedStudy: resolution.matchedScopedStudy,
    applicabilityVerdict: resolution.applicabilityVerdict,
    envelopeChecks,
  };
}
