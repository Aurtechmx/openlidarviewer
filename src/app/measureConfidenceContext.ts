/**
 * Assemble the measurement-confidence context from the live app state —
 * the one place the wiring facts are gathered, so main.ts carries a single
 * call and the fail-closed choices are documented here, next to the types
 * they feed (src/render/measure/measureConfidence.ts).
 */
import { verticalReferenceFromDatum } from '../geo/height';
import type { MeasureSceneContext } from '../render/measure/measureConfidence';

export function buildMeasureConfidenceContext(
  viewer: {
    /** The measure controller; datumResolved = the shared datum held. */
    measure: { readonly datumResolved: boolean };
    /** Loaded static clouds. */
    clouds(): ReadonlyArray<unknown>;
  },
  resolvedCrs:
    | {
        readonly verticalEpsg?: number | null;
        readonly verticalDatum?: string | null;
      }
    | null
    | undefined,
): MeasureSceneContext {
  // Roadmap P1 #6: a height/volume measurement is only "datum resolved" when
  // the vertical reference is actually KNOWN — not merely when a datum STRING
  // is present. `verticalReferenceFromDatum` fails closed on a datum that is
  // undeclared OR present-but-unrecognised (both → 'unknown'), and admits a
  // recognised ellipsoidal / orthometric / depth reference. The old
  // `verticalDatum != null` check upgraded an unclassifiable datum string to
  // "known", so a height measured over a reference we cannot name still read
  // "verified · datum resolved" — the same over-claim #229 removed from the
  // Inspector's Z label. This reuses that module's classifier, so the measure
  // tool and the Inspector never disagree about what a datum is.
  const reference = verticalReferenceFromDatum({
    verticalEpsg: resolvedCrs?.verticalEpsg ?? undefined,
    verticalDatum: resolvedCrs?.verticalDatum ?? undefined,
  });
  return {
    datumResolved: viewer.measure.datumResolved,
    // Fail-closed: a multi-layer scene reads as an unproven combined context
    // until the compatibility ladder upgrades it (layerContextOf).
    layers: viewer.clouds().length <= 1 ? 'single' : 'mixed',
    verticalReferenceKnown: reference !== 'unknown',
  };
}
