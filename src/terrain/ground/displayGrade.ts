/**
 * displayGrade.ts: the contour display grade and its confidence cutoffs.
 *
 * Split out of cellConfidence.ts so the colour modes (coverage and confidence
 * heatmaps) can grade a confidence value without loading the ground-filter
 * and gap-fill modules that build the DTM itself. cellConfidence.ts re-exports
 * everything here, so existing imports keep working.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/**
 * Contour DISPLAY grade derived from confidence — the shared visual grammar.
 * `solid | dashed | gap` is a PRESENTATION choice (how firmly the line is drawn),
 * derived from support/confidence. It is NOT scientific provenance: a solid line
 * does not mean "measured" and a dashed line does not mean "interpolated". Source
 * provenance is carried separately (see `ContourSegmentEvidence`) and must never
 * be reconstructed from this grade.
 */
export type ContourDisplayGrade = 'solid' | 'dashed' | 'gap';

/** Confidence cutoffs for the display grades (single source of truth). */
export const EVIDENCE_THRESHOLDS = {
  /** >= solid → drawn as a confident, continuous line. */
  solid: 66,
  /** >= dashed (and < solid) → drawn dashed: "interpolated, uncertain". */
  dashed: 33,
  // < dashed → `gap`: not drawn / drawn as an explicit break.
} as const;

/** Map a 0..100 confidence to its display grade. */
export function gradeForConfidence(confidence: number): ContourDisplayGrade {
  if (!Number.isFinite(confidence) || confidence < EVIDENCE_THRESHOLDS.dashed) return 'gap';
  if (confidence < EVIDENCE_THRESHOLDS.solid) return 'dashed';
  return 'solid';
}
