/**
 * Assemble the measurement-confidence context from the live app state —
 * the one place the wiring facts are gathered, so main.ts carries a single
 * call and the fail-closed choices are documented here, next to the types
 * they feed (src/render/measure/measureConfidence.ts).
 */
import type { MeasureSceneContext } from '../render/measure/measureConfidence';

export function buildMeasureConfidenceContext(
  viewer: {
    /** The measure controller; datumResolved = the shared datum held. */
    measure: { readonly datumResolved: boolean };
    /** Loaded static clouds. */
    clouds(): ReadonlyArray<unknown>;
  },
  resolvedCrs: { readonly verticalDatum?: string | null } | null | undefined,
): MeasureSceneContext {
  return {
    datumResolved: viewer.measure.datumResolved,
    // Fail-closed: a multi-layer scene reads as an unproven combined context
    // until the compatibility ladder upgrades it (layerContextOf).
    layers: viewer.clouds().length <= 1 ? 'single' : 'mixed',
    verticalReferenceKnown: (resolvedCrs?.verticalDatum ?? null) !== null,
  };
}
