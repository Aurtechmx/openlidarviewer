/**
 * fromCrs.ts — the bridge between the real CRS machinery and the context core.
 *
 * The context core (`contextEligibility`, `footprintModel`, `cameraModel`)
 * deliberately knows nothing about `CrsService`, proj4, or converters: it takes
 * a small facts record and an injected `(x, y) → [lon, lat] | null` transform.
 * This module is the one place those inputs are derived from the viewer's
 * actual CRS types, so the derivation is written — and tested — once.
 *
 * Honesty rules carried over from both sides of the bridge:
 *   - `toWgs84Available` is PROBED, not assumed: the converter is asked to
 *     transform a real representative point, and only an `ok` result with
 *     finite output counts. A converter that would fail at render time fails
 *     the eligibility check up front instead.
 *   - The transform returns `null` for any failed or non-finite conversion,
 *     which the footprint model reports as a refusal — never a guessed
 *     position.
 *   - Nothing here fetches anything or touches the DOM; this stays a pure
 *     science-layer module.
 */

import type { CoordinateConverter } from '../CoordinateConverter';
import type { ResolvedCrs } from '../CoordinateTypes';
import type { ContextLayerFacts } from './contextEligibility';
import type { LonLatTransform } from './footprintModel';

/**
 * Build the context transform from the viewer's converter and a layer's
 * resolved CRS. Every call routes through `converter.toGeographic`, so the
 * converter's own validity range and failure codes decide — this module adds
 * no geodesy of its own. Failed or non-finite conversions become `null`.
 */
export function lonLatTransformFrom(
  converter: CoordinateConverter,
  crs: ResolvedCrs,
): LonLatTransform {
  return (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const result = converter.toGeographic({ x, y, z: 0 }, crs);
    if (!result.ok) return null;
    const { lon, lat } = result.value;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat] as const;
  };
}

/**
 * Derive the eligibility facts for one layer from its resolved CRS, its
 * bounds, and a live probe of the converter at a representative point
 * (callers pass the bounds centre). `crs` may be null for a layer that
 * carries none; every absence maps to an honest `false`, never a guess.
 */
export function contextFactsFrom(
  crs: ResolvedCrs | null,
  converter: CoordinateConverter,
  probePoint: { readonly x: number; readonly y: number },
  boundsFinite: boolean,
): ContextLayerFacts {
  const kind = crs?.kind ?? 'unknown';
  const geographic = kind === 'geographic';
  const projected = kind === 'projected';
  const crsKnown = crs !== null && (geographic || projected);
  // Probe with the real transform rather than trusting a capability flag:
  // an `ok` + finite answer at the layer's own centre is the only evidence
  // that footprint corners will convert too. Skipped (false) when the CRS is
  // already unusable, so a local layer never reports a spurious capability.
  const toWgs84Available =
    crsKnown && boundsFinite
      ? lonLatTransformFrom(converter, crs as ResolvedCrs)(probePoint.x, probePoint.y) !== null
      : false;
  return {
    crsKnown,
    geographic,
    projected,
    horizontalDatumKnown: crs?.horizontalDatum !== undefined,
    toWgs84Available,
    boundsFinite,
  };
}
