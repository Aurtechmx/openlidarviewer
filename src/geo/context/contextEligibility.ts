/**
 * contextEligibility.ts
 *
 * The pure eligibility decision for Context View: may this layer be placed on
 * a world basemap at all? A point cloud with a local site grid, an unknown
 * datum, or no route to WGS84 has no honest position on Earth, and drawing it
 * on a map anyway would invent geography the data does not carry.
 *
 * Downgrade-only, like every other permit in this codebase: any missing fact
 * refuses, nothing is ever guessed or defaulted upward. The refusal reasons
 * come ONLY from {@link CONTEXT_STATUS}, so the UI can never show a refusal
 * this vocabulary does not name, and their order is fixed (CRS → datum →
 * local → transform → bounds) so the same facts always read the same way.
 *
 * Pure and deterministic: no I/O, no DOM, no proj4.
 */

import { CONTEXT_STATUS, type ContextStatusText } from './statusVocabulary';

/** The facts about a layer the eligibility decision consumes. Every field is a
 * positive assertion; `false` (or absence upstream, resolved to `false` by the
 * caller) always refuses. */
export interface ContextLayerFacts {
  /** A coordinate reference system is declared and identified. */
  readonly crsKnown: boolean;
  /** The CRS is geographic (degrees). */
  readonly geographic: boolean;
  /** The CRS is projected (linear units on a known projection). */
  readonly projected: boolean;
  /** The horizontal datum is identified (e.g. WGS84, NAD83). */
  readonly horizontalDatumKnown: boolean;
  /** A transform to WGS84 longitude/latitude is available. */
  readonly toWgs84Available: boolean;
  /** The layer's XY bounds are finite numbers. */
  readonly boundsFinite: boolean;
}

/** The layer may be placed on the world basemap. */
export interface ContextEligible {
  readonly eligible: true;
}

/** The layer must NOT be placed; `reasons` are vocabulary strings, in a fixed order. */
export interface ContextIneligible {
  readonly eligible: false;
  readonly reasons: readonly ContextStatusText[];
}

export type ContextEligibilityDecision = ContextEligible | ContextIneligible;

/**
 * Decide whether a layer may appear on the world basemap. Refuses on ANY
 * missing fact — this function can only downgrade, never promote. A layer that
 * is neither geographic nor projected is treated as local/unreferenced.
 */
export function decideContextEligibility(facts: ContextLayerFacts): ContextEligibilityDecision {
  const reasons: ContextStatusText[] = [];

  if (!facts.crsKnown) {
    reasons.push(CONTEXT_STATUS.crsUnknown);
  }
  if (facts.crsKnown && !facts.horizontalDatumKnown) {
    // Only meaningful once a CRS exists; without one, crsUnknown already covers it.
    reasons.push(CONTEXT_STATUS.datumUnknown);
  }
  if (facts.crsKnown && !facts.geographic && !facts.projected) {
    // A declared CRS that is neither geographic nor projected is a local /
    // engineering frame with no place on Earth.
    reasons.push(CONTEXT_STATUS.localCoordinates);
  }
  if (!facts.toWgs84Available) {
    reasons.push(CONTEXT_STATUS.transformUnavailable);
  }
  if (!facts.boundsFinite) {
    reasons.push(CONTEXT_STATUS.boundsNotFinite);
  }

  if (reasons.length > 0) {
    return { eligible: false, reasons };
  }
  return { eligible: true };
}
