/**
 * terrainAwareTolerance.ts
 *
 * The single terrain-aware generalization policy (v0.5.9 spec §16.1/§16.2):
 * scale a base simplification tolerance from what a contour feature IS —
 *
 *  - smooth LESS (smaller tolerance) where fidelity matters: interpolated or
 *    low-confidence support, and small closed summits/depressions whose shape a
 *    coarse tolerance would erase;
 *  - smooth MORE (larger tolerance) where it is safe and helps legibility:
 *    strongly-measured, long contours.
 *
 * Kept in the contour geometry layer so BOTH readers share one policy and it can
 * never drift between them: the live honesty-gated shape styler
 * (`contourShapeStyle.ts`) and the staged source-unit product pipeline
 * (`contourStudio/contourAdaptiveGeneralize.ts`). This function only decides a
 * multiplier; it never drops a vertex, so the honesty gates in each caller stay
 * in force regardless of the value returned.
 */

/**
 * How the 'generalized' style distributes its simplification strength across
 * features: 'uniform' (the same epsilon everywhere) or 'terrain-aware' (scaled
 * DOWN per feature from what it is). The single named type both the geometry
 * styler and the Contour Studio state/provenance share.
 */
export type ContourGeneralizeMode = 'uniform' | 'terrain-aware';

/** The per-feature signals the terrain-aware tolerance policy reads. */
export interface TerrainAwareFeatureShape {
  /** Evidence grade of the feature as a whole (its weakest span wins). */
  readonly grade: 'solid' | 'dashed' | 'gap';
  /** Mean support confidence [0..100]; non-finite is treated as unknown. */
  readonly meanConfidence: number;
  readonly closed: boolean;
  /** Planimetric length in the source (horizontal) unit. */
  readonly length: number;
}

/**
 * The terrain-aware tolerance multiplier. Deterministic, and always within a
 * bounded band [0.25×, 2×] of the base so a single feature can never be wildly
 * over- or under-generalized.
 */
export function terrainAwareToleranceFactor(
  shape: TerrainAwareFeatureShape,
  opts: { longFeatureLen: number; smallRingLen: number },
): number {
  let factor = 1;

  // Support: smooth interpolated less, unsupported least (fidelity over polish).
  if (shape.grade === 'dashed') factor *= 0.6;
  else if (shape.grade === 'gap') factor *= 0.4;

  // Low confidence → keep more of the original shape.
  if (Number.isFinite(shape.meanConfidence) && shape.meanConfidence < 50) factor *= 0.7;

  // Small closed summit/depression → preserve its (few) vertices.
  if (shape.closed && shape.length <= opts.smallRingLen) factor *= 0.4;

  // Long, strongly-measured contour → safe to generalize a little harder.
  if (shape.grade === 'solid' && shape.length >= opts.longFeatureLen) factor *= 1.5;

  // Bound the band.
  return Math.max(0.25, Math.min(2, factor));
}
