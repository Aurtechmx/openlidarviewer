/**
 * scopedEvidence.ts
 *
 * SCOPED evidence overlays with a conservative fallback.
 *
 * The runtime evidence registry (`evidenceRegistry.ts`) carries ONE global
 * evidence level per claim: `DTM` is `E4` for every dataset the app has ever
 * opened. That is correct for cross-implementation evidence, which is a property
 * of the CODE. External field validation (E5) is NOT a property of the code — it
 * is a property of a specific study: a specific method revision, a specific CRS
 * and geoid, a specific terrain, validated against specific ground control. If a
 * single global `DTM = E5` switch existed, OLV would then treat a forest DTM from
 * another country in another CRS as "externally validated" — which is false and
 * unacceptable.
 *
 * This module makes external evidence SCOPED: a {@link ScopedEvidenceRecord}
 * raises a claim's effective evidence ONLY for artifacts that fall inside its
 * registered applicability envelope (exact agreement on the safety-critical keys:
 * method digest, horizontal/vertical EPSG, geoid model, plus any further envelope
 * key the record sets). Everything else falls back to the baseline registry
 * level. The fallback is deliberately conservative: if scoped evidence exists but
 * the artifact context is absent or incomplete, applicability CANNOT be
 * established, so the effective level stays at baseline and the state is
 * `applicability-unknown` — never the scoped level.
 *
 * A record is DATA, passed to {@link resolveEvidence}; the resolver never reads
 * files. The shipped runtime record set {@link SCOPED_EVIDENCE_RECORDS} is EMPTY:
 * no E5-qualified scoped study is registered yet, so no committed record may
 * raise any real artifact above its baseline. Real external checkpoint studies
 * DO exist under `validation/terrain-field/` (Marsh Island, Coconino); none was
 * preregistered against a protocol frozen before its survey, which is what the
 * E5 bar asks for, so none of them mints a record here. Records are only ever created after a real, frozen
 * study, and any file committed under `validation/evidence/scoped/` before then is
 * an `EXAMPLE-` template that is structurally incapable of matching a real
 * artifact.
 *
 * Pure: types, ranks, a matching predicate, a resolver. No DOM, no I/O.
 */

import type { EvidenceLevel, ExportDecision } from './evidenceLevel';
import { evidenceLabel, evidenceRank, meetsRequired, INDEPENDENCE_FLOOR, exportDecision } from './evidenceLevel';
import { EVIDENCE_REGISTRY, type RegistryEntry } from './claimRegistry.generated';
import { exportGate } from './evidenceRegistry';

/**
 * The explicit resolution state of an evidence lookup. The first three are new
 * scoped-overlay outcomes; the last three carry the baseline registry verdict.
 *
 *  - `validated-in-scope`             — a scoped record's envelope matched the
 *                                       artifact; effective evidence is the
 *                                       scoped level.
 *  - `external-evidence-out-of-scope` — a scoped record exists for the claim, the
 *                                       artifact context is complete, but the
 *                                       artifact is OUTSIDE every envelope.
 *  - `applicability-unknown`          — a scoped record exists but the context is
 *                                       absent/incomplete, so applicability cannot
 *                                       be established (fails closed to baseline).
 *  - `cross-implementation`           — baseline meets its required level and is at
 *                                       or above the independence floor (E4+).
 *  - `exploratory`                    — baseline below required, or self-verified.
 *  - `refused`                        — unregistered claim, or export disabled.
 */
export type ResolutionState =
  | 'validated-in-scope'
  | 'external-evidence-out-of-scope'
  | 'applicability-unknown'
  | 'cross-implementation'
  | 'exploratory'
  | 'refused';

/**
 * The matching predicate inputs of a scoped record — the envelope the artifact
 * context must fall inside for the record to apply. Every key is optional; a key
 * the record SETS becomes a hard constraint (the context must supply an equal
 * value). Keys the record omits are unconstrained.
 */
export interface ApplicabilityEnvelope {
  /** Digest of the exact DTM/terrain METHOD the study validated. Safety-critical. */
  readonly methodDigest?: string;
  /** Horizontal CRS EPSG code the study validated. Safety-critical. */
  readonly horizontalEpsg?: number;
  /** Vertical CRS EPSG code the study validated. Safety-critical. */
  readonly verticalEpsg?: number;
  /** Geoid model the vertical datum was realised through. Safety-critical. */
  readonly geoidModel?: string;
  /** Vertical datum name, when the study pins it beyond the EPSG. */
  readonly verticalDatum?: string;
  /** Terrain stratum the study covers (e.g. 'bare-earth', 'open-terrain'). */
  readonly terrainStratum?: string;
  /** Named study area the checkpoints lie within. */
  readonly studyArea?: string;
  /** Slope band, degrees, the checkpoints span; context slope must lie within. */
  readonly slopeRange?: readonly [number, number];
  /** Aggregation the surface was built with (e.g. 'idw', 'mean'). */
  readonly aggregation?: string;
  /** Interpolation/fill the surface was built with. */
  readonly interpolation?: string;
  /** Grid cell size (source units) the study validated. */
  readonly cellSize?: number;
  /** Whether the study trusted source ground classification. */
  readonly trustGroundClassification?: boolean;
  /** The candidate build revision the study was frozen against. */
  readonly candidateRevision?: string;
}

/**
 * A scoped external-evidence record. Created ONLY after a real, frozen field
 * study. It raises {@link resolveEvidence}'s effective evidence for `claimId` to
 * `evidenceLevel`, but ONLY for artifacts whose context matches
 * `applicabilityEnvelope`.
 */
export interface ScopedEvidenceRecord {
  /** The claim id this record scopes (must exist in the runtime registry). */
  readonly claimId: string;
  /** The evidence level this study establishes inside its envelope (e.g. E5). */
  readonly evidenceLevel: EvidenceLevel;
  /** Stable study identifier (appears in provenance as the matched study). */
  readonly studyId: string;
  /** Build revision the study was frozen against. */
  readonly candidateRevision?: string;
  /** Registered method id the study validated. */
  readonly methodId?: string;
  /** Method version the study validated. */
  readonly methodVersion?: string;
  /** Digest of the validated method — the anchor for method-match. */
  readonly methodDigest?: string;
  /** Horizontal EPSG the study was performed in. */
  readonly horizontalEpsg?: number;
  /** Vertical EPSG the study was performed in. */
  readonly verticalEpsg?: number;
  /** Vertical datum name. */
  readonly verticalDatum?: string;
  /** Geoid model realising the vertical datum. */
  readonly geoidModel?: string;
  /** Grid cell size (source units). */
  readonly cellSize?: number;
  /** Aggregation used. */
  readonly aggregation?: string;
  /** Interpolation/fill used. */
  readonly interpolation?: string;
  /** Whether source ground classification was trusted. */
  readonly trustGroundClassification?: boolean;
  /** Terrain stratum covered. */
  readonly terrainStratum?: string;
  /** Slope band, degrees, the checkpoints span. */
  readonly slopeRange?: readonly [number, number];
  /** Support state (checkpoint count / distribution descriptor). */
  readonly supportState?: string;
  /** Named study area. */
  readonly studyArea?: string;
  /** Survey date (ISO), for the audit trail. */
  readonly surveyDate?: string;
  /** The matching predicate: the artifact context must fall inside this. */
  readonly applicabilityEnvelope: ApplicabilityEnvelope;
}

/**
 * The context of the artifact under export — what the resolver checks against a
 * record's envelope. Every field is optional: a MISSING safety-critical field is
 * exactly what triggers the conservative `applicability-unknown` fallback.
 */
export interface EvidenceContext {
  /** Digest of the method that actually produced this artifact. */
  readonly methodDigest?: string;
  /** Horizontal CRS EPSG of this artifact. */
  readonly horizontalEpsg?: number;
  /** Vertical CRS EPSG of this artifact. */
  readonly verticalEpsg?: number;
  /** Geoid model of this artifact. */
  readonly geoidModel?: string;
  /** Vertical datum name of this artifact. */
  readonly verticalDatum?: string;
  /** Terrain stratum of this artifact. */
  readonly terrainStratum?: string;
  /** Named study area of this artifact. */
  readonly studyArea?: string;
  /** Representative slope, degrees, of this artifact (checked against slopeRange). */
  readonly slopeDegrees?: number;
  /**
   * The parameter set this artifact was built with, checked against the
   * register's scope.supported. Omitted: the shipped product's set
   * ({@link LIVE_PARAMETER_SET}), when one is declared.
   */
  readonly parameterSetId?: string;
  /**
   * For the live DTM, which of its cells the artifact stands for: measured
   * cells (at least one return, median aggregated) or filled (interpolated)
   * cells. Selects the parameter set (see {@link dtmMeasuredParameterSet})
   * when no explicit parameterSetId is given.
   */
  readonly cells?: DtmCellClass;
  /**
   * For the live DTM's measured cells, the grid the run used. Required for
   * coverage: without it, measured cells resolve to not covered.
   */
  readonly dtmGrid?: DtmGridRule;
  /** Aggregation this artifact was built with. */
  readonly aggregation?: string;
  /** Interpolation/fill this artifact was built with. */
  readonly interpolation?: string;
  /** Grid cell size (source units) of this artifact. */
  readonly cellSize?: number;
  /** Whether ground classification was trusted for this artifact. */
  readonly trustGroundClassification?: boolean;
  /** The build revision that produced this artifact. */
  readonly candidateRevision?: string;
}

/** The full resolution result. `effectiveEvidence` is what gates may act on. */
export interface EvidenceResolution {
  /** The baseline registry level for the claim (null for an unregistered claim). */
  readonly baselineEvidence: EvidenceLevel | null;
  /** The level after scoped overlay — baseline unless a record matched in scope. */
  readonly effectiveEvidence: EvidenceLevel | null;
  /** The matched study id when in-scope, else null. */
  readonly matchedScopedStudy: string | null;
  /** Human-readable applicability verdict, for provenance / notes. */
  readonly applicabilityVerdict: string;
  /** The explicit resolution state. */
  readonly resolutionState: ResolutionState;
}

/**
 * The keys whose absence from the context makes applicability UNKNOWN rather than
 * merely out-of-scope. A record that pins any of these requires the context to
 * supply it; a missing one means we cannot even establish whether the artifact
 * is the validated method/CRS, so we fail closed to baseline.
 */
const SAFETY_CRITICAL: readonly (keyof ApplicabilityEnvelope)[] = [
  'methodDigest',
  'horizontalEpsg',
  'verticalEpsg',
  'geoidModel',
];

/**
 * The runtime scoped-evidence record set. INTENTIONALLY EMPTY: no real field
 * study exists yet, so nothing may raise a real artifact above its baseline. This
 * is the only record set `resolveEvidence` consults by default, and it is an
 * in-memory constant — no scoped JSON is read at import (keeping the bundle light
 * and guaranteeing no committed file can affect the running app). Tests pass
 * their own synthetic records explicitly.
 */
export const SCOPED_EVIDENCE_RECORDS: readonly ScopedEvidenceRecord[] = [];

/**
 * The parameter set each shipped product is built with, for claims whose
 * register scope names the parameter sets its studies covered. The live DTM
 * as a whole aggregates by median (LIVE_DTM_AGGREGATION) with void fill, which
 * no study covers; its measured cells are covered (see
 * {@link dtmMeasuredParameterSet}).
 */
export const LIVE_PARAMETER_SET: Readonly<Record<string, string>> = {
  DTM: 'PS-DTM-LIVE-MEDIAN-FILL',
};

/** The two kinds of cell in the live DTM. */
export type DtmCellClass = 'measured' | 'filled';

/**
 * How a DTM's grid was laid out: its cell size and where its origin sits.
 * `data-minimum` is the rule rasterizeDtm and the ground filter use: the
 * origin at the minimum x and y of the gridded input. Anything else is `other`.
 */
export interface DtmGridRule {
  readonly cellSizeM: number;
  readonly origin: 'data-minimum' | 'other';
}

/**
 * The median parameter sets studied with the data-minimum origin rule, by
 * cell size (validation/protocols/dtm-median-gridding-v2.md and -v3.md). The v1 1 m study
 * (PS-DTM-MEDIAN-CELL1-ORIGIN0) used an origin at (0, 0), which no live DTM
 * uses, so it is not listed here.
 */
export const STUDIED_DTM_MEDIAN_SETS: ReadonlyArray<{ readonly cellSizeM: number; readonly parameterSetId: string }> = [
  { cellSizeM: 0.25, parameterSetId: 'PS-DTM-MEDIAN-CELL0P25-ORIGINMIN' },
  { cellSizeM: 0.5, parameterSetId: 'PS-DTM-MEDIAN-CELL0P5-ORIGINMIN' },
  { cellSizeM: 1, parameterSetId: 'PS-DTM-MEDIAN-CELL1-ORIGINMIN' },
  { cellSizeM: 2, parameterSetId: 'PS-DTM-MEDIAN-CELL2-ORIGINMIN' },
  { cellSizeM: 5, parameterSetId: 'PS-DTM-MEDIAN-CELL5-ORIGINMIN' },
];

/** A measured-cell parameter set no study covers: any grid not in {@link STUDIED_DTM_MEDIAN_SETS}. */
export const DTM_MEDIAN_NOT_STUDIED = 'PS-DTM-MEDIAN-NOT-STUDIED';

/** Filled cells come from the void fill, which no study covers. */
export const LIVE_DTM_FILLED_PARAMETER_SET = 'PS-DTM-LIVE-MEDIAN-FILL';

/**
 * The parameter set a live DTM's measured cells were built with. Covered only
 * when the grid uses the data-minimum origin and its cell size matches a
 * studied size to within 1e-9; otherwise, or when the grid is not known, the
 * not-studied set, which resolves to not covered.
 */
export function dtmMeasuredParameterSet(grid?: DtmGridRule | null): string {
  if (grid == null || grid.origin !== 'data-minimum' || !Number.isFinite(grid.cellSizeM)) return DTM_MEDIAN_NOT_STUDIED;
  const hit = STUDIED_DTM_MEDIAN_SETS.find((s) => Math.abs(s.cellSizeM - grid.cellSizeM) <= 1e-9);
  return hit?.parameterSetId ?? DTM_MEDIAN_NOT_STUDIED;
}

/**
 * The grid rule of a DTM built by analyseContours. Its grid always comes from
 * the ground filter, which places the origin at the data minimum.
 */
export function liveDtmGridRule(dtm: { readonly cellSizeM: number } | null | undefined): DtmGridRule | undefined {
  return dtm == null ? undefined : { cellSizeM: dtm.cellSizeM, origin: 'data-minimum' };
}

/** The parameter set an artifact was built with: explicit, by DTM cell class, or the shipped product's. */
function artifactParameterSet(claimId: string, context?: EvidenceContext): string | undefined {
  if (context?.parameterSetId != null) return context.parameterSetId;
  if (claimId === 'DTM' && context?.cells === 'filled') return LIVE_DTM_FILLED_PARAMETER_SET;
  if (claimId === 'DTM' && context?.cells === 'measured') return dtmMeasuredParameterSet(context.dtmGrid);
  return LIVE_PARAMETER_SET[claimId];
}

interface MatchOutcome {
  readonly matched: boolean;
  /** A safety-critical envelope key was set but missing from the context. */
  readonly incomplete: boolean;
}

/** Does the artifact context fall inside this envelope? */
function matchEnvelope(env: ApplicabilityEnvelope, ctx: EvidenceContext): MatchOutcome {
  let incomplete = false;
  let mismatch = false;
  for (const key of Object.keys(env) as (keyof ApplicabilityEnvelope)[]) {
    if (env[key] === undefined) continue;
    if (key === 'slopeRange') {
      const [lo, hi] = env.slopeRange as readonly [number, number];
      const s = ctx.slopeDegrees;
      // A missing or out-of-band slope is a mismatch (not a match); slope is not
      // safety-critical, so it never yields "unknown", only "out-of-scope".
      if (s === undefined || s < lo || s > hi) mismatch = true;
      continue;
    }
    const ctxVal = (ctx as Record<string, unknown>)[key];
    if (ctxVal === undefined) {
      // A safety-critical key we cannot see ⇒ applicability unknown; any other
      // constrained key we cannot see ⇒ conservatively out-of-scope.
      if (SAFETY_CRITICAL.includes(key)) incomplete = true;
      else mismatch = true;
      continue;
    }
    if (ctxVal !== env[key]) mismatch = true;
  }
  return { matched: !mismatch && !incomplete, incomplete };
}

/** Map a baseline registry entry to its resolution state (no scoped overlay). */
function baselineState(entry: RegistryEntry | undefined): ResolutionState {
  if (!entry || !entry.exportAllowed) return 'refused';
  if (meetsRequired(entry.current, entry.required)
    && evidenceRank(entry.current) >= evidenceRank(INDEPENDENCE_FLOOR)) {
    return 'cross-implementation';
  }
  return 'exploratory';
}

/**
 * Resolve the effective evidence for a claim, given the artifact context and a
 * record set (default: the empty shipped set). Pure and deterministic.
 *
 * Resolution order (fail-closed at every branch):
 *   1. No scoped record for the claim ⇒ baseline (identical to today).
 *   2. Scoped record(s) exist but no context ⇒ baseline, `applicability-unknown`.
 *   3. A record's envelope matches ⇒ effective = max(scoped, baseline),
 *      `validated-in-scope` (the highest matching scoped level wins).
 *   4. No match, and the mismatch was a missing safety-critical key ⇒ baseline,
 *      `applicability-unknown`.
 *   5. No match with a complete context ⇒ no level (not covered), `external-evidence-out-of-scope`.
 */
export function resolveEvidence(
  claimId: string,
  context?: EvidenceContext,
  records: readonly ScopedEvidenceRecord[] = SCOPED_EVIDENCE_RECORDS,
): EvidenceResolution {
  const entry = EVIDENCE_REGISTRY[claimId];
  const baseline = entry?.current ?? null;
  const forClaim = records.filter((r) => r.claimId === claimId);

  // A claim whose studies name the parameter sets they covered: a product
  // built with another set is not covered and inherits no level. A claim that
  // declares none keeps the baseline below.
  const covered = entry?.scopedParameterSets;
  const paramSet = artifactParameterSet(claimId, context);
  if (forClaim.length === 0 && covered && covered.length > 0 && paramSet != null && !covered.includes(paramSet)) {
    return {
      baselineEvidence: baseline,
      effectiveEvidence: null,
      matchedScopedStudy: null,
      applicabilityVerdict:
        `Not covered by the registered studies: they cover ${covered.join(', ')}, and this `
        + `artifact was built with ${paramSet}, so no evidence level is inherited.`,
      resolutionState: 'external-evidence-out-of-scope',
    };
  }

  if (forClaim.length === 0) {
    return {
      baselineEvidence: baseline,
      effectiveEvidence: baseline,
      matchedScopedStudy: null,
      applicabilityVerdict: 'No scoped external evidence is registered for this claim.',
      resolutionState: baselineState(entry),
    };
  }

  if (context === undefined) {
    return {
      baselineEvidence: baseline,
      effectiveEvidence: baseline,
      matchedScopedStudy: null,
      applicabilityVerdict:
        'Scoped external evidence exists for this claim, but no artifact context was '
        + 'supplied; applicability cannot be established, so the baseline level stands.',
      resolutionState: 'applicability-unknown',
    };
  }

  let best: ScopedEvidenceRecord | null = null;
  let anyIncomplete = false;
  for (const r of forClaim) {
    const { matched, incomplete } = matchEnvelope(r.applicabilityEnvelope, context);
    if (incomplete) anyIncomplete = true;
    if (matched) {
      if (best === null || evidenceRank(r.evidenceLevel) > evidenceRank(best.evidenceLevel)) {
        best = r;
      }
    }
  }

  if (best !== null) {
    // The highest scoped level that matched, but never BELOW baseline.
    const effective =
      baseline !== null && evidenceRank(baseline) >= evidenceRank(best.evidenceLevel)
        ? baseline
        : best.evidenceLevel;
    return {
      baselineEvidence: baseline,
      effectiveEvidence: effective,
      matchedScopedStudy: best.studyId,
      applicabilityVerdict:
        `Artifact matches the registered envelope of study ${best.studyId}; `
        + 'external field evidence applies in scope.',
      resolutionState: 'validated-in-scope',
    };
  }

  if (anyIncomplete) {
    return {
      baselineEvidence: baseline,
      effectiveEvidence: baseline,
      matchedScopedStudy: null,
      applicabilityVerdict:
        'Scoped external evidence exists, but the artifact context is missing a '
        + 'safety-critical key (method digest / EPSG / geoid); applicability is '
        + 'unknown, so the baseline level stands.',
      resolutionState: 'applicability-unknown',
    };
  }

  return {
    baselineEvidence: baseline,
    // Not covered: the claim's level rests on studies this artifact is outside
    // of, so it inherits none (a claim with no scoped studies keeps baseline).
    effectiveEvidence: null,
    matchedScopedStudy: null,
    applicabilityVerdict:
      'Not covered by the registered studies: this artifact is outside every '
      + 'registered study envelope, so no evidence level is inherited.',
    resolutionState: 'external-evidence-out-of-scope',
  };
}

/**
 * The SINGLE authoritative export-evidence resolution for a DTM-family claim.
 * Composes the scoped overlay ({@link resolveEvidence}) with the EFFECTIVE
 * export gate (derived from the overlay's effective level, {@link baselineGate}
 * retained for the audit trail) and the user-facing note into ONE object, so
 * every DTM export path — provenance stamp, evidence note, analysis record —
 * derives its baseline level, effective level, applicability state, matched
 * study, gate verdict and note from the SAME call. No path can report E5 while
 * another reports E4, because there is now only one place the decision is made —
 * and the gate now tracks the effective level, so an in-scope E5 match exports
 * as validated instead of being stamped exploratory by the baseline E4.
 *
 * `note` is scope-aware: an in-scope match reads as validated FOR the registered
 * study envelope; an out-of-scope / applicability-unknown result says external
 * evidence exists but this dataset is outside the validated scope; and with no
 * scoped record (the shipped set is empty, so every real artifact) the note is
 * the caller-supplied `baselineNote` — the product's own baseline wording — so
 * production artifacts stay byte-identical.
 *
 * Fail-closed and conservative: no context, or an out-of-scope context, yields
 * baseline everywhere (never the scoped level). Pure and deterministic.
 */
export interface ExportEvidenceResolution {
  /** The DTM-family claim resolved. */
  readonly claimId: string;
  /** Baseline registry level (before any scoped overlay); null if unregistered. */
  readonly baselineEvidence: EvidenceLevel | null;
  /** Level after scoped overlay — equals baseline unless matched in scope. */
  readonly effectiveEvidence: EvidenceLevel | null;
  /** The explicit applicability / resolution state. */
  readonly applicabilityStatus: ResolutionState;
  /** Matched study id when in-scope, else null. */
  readonly matchedStudy: string | null;
  /** Human-readable applicability verdict (from the scoped resolver). */
  readonly applicabilityVerdict: string;
  /**
   * The EFFECTIVE export-gate verdict — derived from {@link effectiveEvidence}
   * (the scoped overlay), so an in-scope match that reaches the required level
   * exports as validated rather than exploratory. Equals {@link baselineGate}
   * for every artifact outside a scoped envelope; the shipped record set is
   * empty, so this is byte-identical to the prior behaviour for real exports.
   */
  readonly gate: ExportDecision;
  /**
   * The baseline registry gate ({@link exportGate}) — the pre-overlay decision
   * the global registry level yields, retained for the audit trail.
   */
  readonly baselineGate: ExportDecision;
  /** The single user-facing evidence note every path stamps. */
  readonly note: string;
}

/**
 * The export decision for the EFFECTIVE (scoped-overlay) evidence level rather
 * than the baseline registry level. Mirrors {@link exportGate} but substitutes
 * the resolved effective level for the registry's `current`, so an in-scope
 * match that raises the claim to its required level clears the exploratory mark.
 * An unregistered claim (no entry, or a null effective level) is refused exactly
 * as {@link exportGate} refuses it.
 */
function effectiveExportGate(
  claimId: string,
  effectiveEvidence: EvidenceLevel | null,
): ExportDecision {
  const entry = EVIDENCE_REGISTRY[claimId];
  if (entry && effectiveEvidence == null) {
    return {
      allowed: entry.exportAllowed,
      exploratoryOnly: true,
      reason: `"${claimId}" is not covered by its registered studies for this artifact; exportable only as exploratory.`,
    };
  }
  if (!entry || effectiveEvidence == null) {
    return {
      allowed: false,
      exploratoryOnly: true,
      reason: `No evidence-register entry for "${claimId}"; treated as unregistered (E0) and exportable only as exploratory.`,
    };
  }
  return exportDecision(effectiveEvidence, entry.required, entry.exportAllowed);
}

export function resolveExportEvidence(
  claimId: string,
  context?: EvidenceContext,
  records?: readonly ScopedEvidenceRecord[],
  baselineNote?: string,
): ExportEvidenceResolution {
  const r = resolveEvidence(claimId, context, records);
  const baselineGate = exportGate(claimId);
  const gate = effectiveExportGate(claimId, r.effectiveEvidence);
  let note: string;
  switch (r.resolutionState) {
    case 'validated-in-scope':
      note =
        'Evidence: externally field validated for the registered study envelope ('
        + r.matchedScopedStudy + '). Applies only within that scope.';
      break;
    case 'external-evidence-out-of-scope':
      // Outside the register's parameter-set scope (no scoped record): the
      // caller's gate note already names the uncovered configuration.
      note = !(records ?? SCOPED_EVIDENCE_RECORDS).some((x) => x.claimId === claimId) && baselineNote != null
        ? baselineNote
        : 'Evidence: not covered by the registered studies; this dataset is outside '
          + 'every study envelope, so no evidence level is inherited.';
      break;
    case 'applicability-unknown':
      note =
        'Evidence: external field evidence exists for this DTM method, but this '
        + 'dataset’s applicability could not be established, so it is treated '
        + 'as outside the validated study scope. Baseline level stands.';
      break;
    default:
      // No scoped record for the claim: the caller's baseline wording is
      // authoritative (the gate note the product already carried).
      note = baselineNote ?? '';
  }
  return {
    claimId,
    baselineEvidence: r.baselineEvidence,
    effectiveEvidence: r.effectiveEvidence,
    applicabilityStatus: r.resolutionState,
    matchedStudy: r.matchedScopedStudy,
    applicabilityVerdict: r.applicabilityVerdict,
    gate,
    baselineGate,
    note,
  };
}

/**
 * The live DTM's evidence by cell class, as one phrase every DTM surface
 * prints: the level its measured cells resolve to, and that filled cells are
 * not covered. Both halves come from {@link resolveEvidence}.
 */
export function dtmCellsEvidenceText(grid?: DtmGridRule | null): string {
  const measured = resolveEvidence('DTM', { cells: 'measured', ...(grid ? { dtmGrid: grid } : {}) }).effectiveEvidence;
  const filled = resolveEvidence('DTM', { cells: 'filled' }).effectiveEvidence;
  const measuredText = measured == null
    ? 'measured cells not covered'
    : `${measured.slice(0, 2)} (${evidenceLabel(measured)}) on measured cells`;
  const filledText = filled == null ? 'filled cells not covered' : `${filled.slice(0, 2)} on filled cells`;
  return `${measuredText}; ${filledText} by the registered studies`;
}
