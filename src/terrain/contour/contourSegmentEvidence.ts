/**
 * contourSegmentEvidence.ts — typed source EVIDENCE for a contour segment,
 * kept strictly separate from the display grade (`ContourDisplayGrade`).
 *
 * WHY THIS EXISTS. `solid | dashed | gap` is a presentation choice derived from
 * confidence; it is NOT scientific provenance. Reconstructing "measured vs
 * interpolated" from stroke style (the old `contourEvidence(grade)`) invents a
 * provenance the geometry never carried. This module carries the REAL thing:
 * which DTM cell states a segment was traced through, aggregated as a set union
 * from the source, so an export states provenance from evidence or says
 * `unavailable` — never from how firmly the line is drawn.
 *
 * REPRESENTATION. Provenance is a set over {M (measured), I (interpolated)}.
 * Through the hot geometry path it travels as a 2-bit integer (M=1, I=2, mixed=3,
 * 0=unknown) so emission and stitching add no per-vertex heap allocation; the
 * typed `ReadonlySet` shape is materialised only at serialization.
 *
 * CHANNELS ARE SEMANTICALLY DISTINCT (WI-3). `measured-support`,
 * `interpolation-support` and `presentation-confidence` are separate typed
 * channels. They are never averaged, minimised or compared across channels: a
 * measured-support number and a presentation-confidence number describe
 * different things, and combining them would fabricate a comparison no model
 * declares. Same-meaning support may be aggregated within its own channel
 * (WI-4: the weakest applicable value over a source interval).
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** A single source state a segment can be traced through. */
export type ContourProvenance = 'M' | 'I';

/** Provenance bitmask through the hot path. */
export const PROV_UNKNOWN = 0;
export const PROV_M = 1; // measured
export const PROV_I = 2; // interpolated
// 3 === PROV_M | PROV_I === mixed ancestry.

/**
 * The provenance a cell contributes, from the coverage states of its four
 * corners (`CellCoverage`: 0 none, 1 interpolated, 2 measured). A gap corner
 * (0) never reaches here — the extractor already refuses a cell touching one —
 * so a returned bit set of 0 means "no coverage info", not "gap".
 */
export function provBitsFromCoverage(c0: number, c1: number, c2: number, c3: number): number {
  let bits = PROV_UNKNOWN;
  if (c0 === 2 || c1 === 2 || c2 === 2 || c3 === 2) bits |= PROV_M;
  if (c0 === 1 || c1 === 1 || c2 === 1 || c3 === 1) bits |= PROV_I;
  return bits;
}

/** Union of two provenance bitmasks (provenance aggregates as a set union). */
export function unionProvBits(a: number, b: number): number {
  return (a | b) & (PROV_M | PROV_I);
}

/**
 * Typed support channels. Each is optional and, when present, is the weakest
 * applicable value over the source interval a segment represents (WI-4). A
 * missing channel is ABSENT (unavailable), never silently defaulted.
 */
export interface ContourSupportChannels {
  /** Measured-support: how well measured ground backs the segment. */
  readonly 'measured-support'?: number;
  /** Interpolation-support: how well interpolation backs the segment. */
  readonly 'interpolation-support'?: number;
  /** Presentation-confidence: the 0..100 confidence the display grade derives from. */
  readonly 'presentation-confidence'?: number;
}

/** Source-interval identity — reconstructs the full interval without duplicating geometry. */
export interface ContourEvidenceLineage {
  /** Id of the source polyline the interval belongs to. */
  readonly sourceId: string;
  /** Inclusive source-vertex index range [a, b] the evidence was aggregated over. */
  readonly a: number;
  readonly b: number;
}

/** Typed evidence for a single emitted contour segment (WI-2). */
export interface ContourSegmentEvidence {
  /** {M}=measured only, {I}=interpolated only, {M,I}=mixed. Empty ⇒ unavailable. */
  readonly provenance: ReadonlySet<ContourProvenance>;
  readonly support?: ContourSupportChannels;
  readonly applicability?: Record<string, unknown>;
  readonly lineage?: ContourEvidenceLineage;
}

/** Materialise the typed provenance set from the hot-path bitmask. */
export function provenanceSetFromBits(bits: number): ReadonlySet<ContourProvenance> {
  const set = new Set<ContourProvenance>();
  if (bits & PROV_M) set.add('M');
  if (bits & PROV_I) set.add('I');
  return set;
}

/**
 * The serialized provenance value for an export: the sorted set as a string, or
 * the explicit sentinel when no evidence is available. Never derived from the
 * display grade. `{M}` → "measured", `{I}` → "interpolated", `{M,I}` → "mixed".
 */
export type SerializedProvenance = 'measured' | 'interpolated' | 'mixed' | 'unavailable';

export function serializeProvenance(
  evidence: ContourSegmentEvidence | undefined,
): SerializedProvenance {
  if (!evidence) return 'unavailable';
  const hasM = evidence.provenance.has('M');
  const hasI = evidence.provenance.has('I');
  if (hasM && hasI) return 'mixed';
  if (hasM) return 'measured';
  if (hasI) return 'interpolated';
  return 'unavailable';
}
