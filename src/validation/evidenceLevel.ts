/**
 * evidenceLevel.ts
 *
 * The scientific-evidence ladder for OpenLiDARViewer's generated products
 * (research-hardening Phase 1). Every claim the software makes — a distance, a
 * DTM, a stockpile volume, a quality-level comparison — carries an evidence
 * level stating how strongly it is supported, and a *required* level it must
 * reach before it may be exported as a validated (non-exploratory) result.
 *
 * The ladder is deliberately ordered and gapless. Higher is stronger. The
 * boundary that matters most is E3 → E4/E5: everything at or below E3 is
 * verified only against the software's own code or its own synthetic fixtures
 * ("precision is not accuracy; synthetic validation is not field validation").
 * Independent evidence begins at E4 (a second implementation agrees) and only
 * reaches "validated" at E5 (external ground truth) / E6 (independent
 * reproduction).
 *
 * Pure: enums, ranks, labels, gates. No DOM, no I/O. The machine-readable claim
 * register (docs/validation/claim-register.yaml) uses these identifiers, and the
 * v0.5.7 UI evidence badges (Phase 17) map from them.
 */

/** The evidence ladder, weakest → strongest. Order is the rank. */
export const EVIDENCE_LEVELS = [
  'E0_IMPLEMENTED',
  'E1_UNIT_VERIFIED',
  'E2_ANALYTICALLY_VERIFIED',
  'E3_SYNTHETICALLY_VALIDATED',
  'E4_CROSS_IMPLEMENTATION_VALIDATED',
  'E5_EXTERNALLY_VALIDATED',
  'E6_INDEPENDENTLY_REPRODUCED',
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

const RANK: ReadonlyMap<EvidenceLevel, number> = new Map(
  EVIDENCE_LEVELS.map((l, i) => [l, i]),
);

/** Numeric rank (0 = weakest). Throws on an unknown level so typos surface. */
export function evidenceRank(level: EvidenceLevel): number {
  const r = RANK.get(level);
  if (r === undefined) throw new Error(`Unknown evidence level: ${String(level)}`);
  return r;
}

/** True when `current` is at least as strong as `required`. */
export function meetsRequired(current: EvidenceLevel, required: EvidenceLevel): boolean {
  return evidenceRank(current) >= evidenceRank(required);
}

/**
 * The first level at which a claim counts as INDEPENDENTLY supported rather
 * than self-verified. At or below this floor, a claim is verified only against
 * the software's own code or its own synthetic fixtures.
 */
export const INDEPENDENCE_FLOOR: EvidenceLevel = 'E4_CROSS_IMPLEMENTATION_VALIDATED';

/** True when the level rests only on the software's own code / synthetic data. */
export function isSelfVerified(level: EvidenceLevel): boolean {
  return evidenceRank(level) < evidenceRank(INDEPENDENCE_FLOOR);
}

/** Full human-readable status wording (for the validation matrix / reports). */
const LABEL: Record<EvidenceLevel, string> = {
  E0_IMPLEMENTED: 'Implemented — not assessed',
  E1_UNIT_VERIFIED: 'Unit verified',
  E2_ANALYTICALLY_VERIFIED: 'Analytically verified',
  E3_SYNTHETICALLY_VALIDATED: 'Synthetically validated',
  E4_CROSS_IMPLEMENTATION_VALIDATED: 'Cross-implementation validated',
  E5_EXTERNALLY_VALIDATED: 'Externally validated',
  E6_INDEPENDENTLY_REPRODUCED: 'Independently reproduced',
};

export function evidenceLabel(level: EvidenceLevel): string {
  return LABEL[level];
}

/** The compact UI badge vocabulary (Phase 17). */
export type EvidenceBadge =
  | 'Not assessed'
  | 'Analytic'
  | 'Synthetic'
  | 'Cross-implementation'
  | 'External'
  | 'Independently reproduced';

const BADGE: Record<EvidenceLevel, EvidenceBadge> = {
  E0_IMPLEMENTED: 'Not assessed',
  E1_UNIT_VERIFIED: 'Analytic',
  E2_ANALYTICALLY_VERIFIED: 'Analytic',
  E3_SYNTHETICALLY_VALIDATED: 'Synthetic',
  E4_CROSS_IMPLEMENTATION_VALIDATED: 'Cross-implementation',
  E5_EXTERNALLY_VALIDATED: 'External',
  E6_INDEPENDENTLY_REPRODUCED: 'Independently reproduced',
};

export function evidenceBadge(level: EvidenceLevel): EvidenceBadge {
  return BADGE[level];
}

export interface ExportDecision {
  /** May the result be exported as a validated (non-exploratory) artifact? */
  readonly allowed: boolean;
  /** When not allowed, the result may still export as an EXPLORATORY artifact. */
  readonly exploratoryOnly: boolean;
  /** Human-readable reason, for the refusal / watermark text. */
  readonly reason: string;
}

/**
 * The export gate (Phase 17). A product whose current evidence has not reached
 * its required level is not blocked outright — it may still be exported, but
 * only as an explicitly watermarked EXPLORATORY artifact carrying this reason.
 * A product that declares `exportAllowed: false` in the register is never
 * offered even as exploratory.
 */
export function exportDecision(
  current: EvidenceLevel,
  required: EvidenceLevel,
  exportAllowed: boolean,
): ExportDecision {
  if (!exportAllowed) {
    return {
      allowed: false,
      exploratoryOnly: false,
      reason: 'Export is disabled for this product in the claim register.',
    };
  }
  if (meetsRequired(current, required)) {
    return { allowed: true, exploratoryOnly: false, reason: '' };
  }
  return {
    allowed: false,
    exploratoryOnly: true,
    reason:
      `Evidence ${evidenceLabel(current)} is below the required `
      + `${evidenceLabel(required)}; exportable only as an exploratory artifact.`,
  };
}
