/**
 * projectElevationRange.ts
 *
 * One elevation colour range for a project, or an honest refusal.
 *
 * Each layer ranges its own heights today: the colorbar reads the FIRST loaded
 * cloud and every cloud is recoloured against its own percentile window (see
 * `activeColorbar` and the per-cloud `rampRangeForMode` call in
 * `src/render/Viewer.ts`). With one layer that is exactly right. With several
 * mounted layers it means two scans of the same site are painted with two
 * different ramps, so a colour cannot be compared across the seam — the legend
 * describes one layer and the picture shows two.
 *
 * The fix is a shared range, and the interesting part is when NOT to produce
 * one. Elevation ranges are numbers with a unit attached, and the unit is not
 * always known: `CrsLinearUnit` includes `'unknown'` precisely because a source
 * can decline to say. Merging 12–48 metres with 40–160 feet gives 12–160 of
 * nothing. Merging two ranges when one unit is undeclared gives a number that
 * LOOKS like the same kind of claim and is not. So this reducer returns a range
 * only when every input is finite and every input declares the SAME vertical
 * unit, and otherwise returns a refusal carrying the reason — which the caller
 * can show instead of a legend.
 *
 * It deliberately does NOT convert feet to metres to force agreement. The
 * conversion factor belongs to the CRS, the caller holds it, and a combiner
 * that quietly converted would be asserting a vertical relationship it cannot
 * see. Convert first, then combine, if that is what you mean.
 *
 * Pure — no DOM, no three.js — Node-testable.
 */

import type { CrsLinearUnit } from '../io/crs';

/** A vertical unit a range can actually be compared in — `'unknown'` is not one. */
export type DeclaredVerticalUnit = Exclude<CrsLinearUnit, 'unknown'>;

/** One layer's elevation range, with the unit it is expressed in. */
export interface LayerElevationRange {
  /** Lowest elevation, in {@link verticalUnit}. */
  readonly min: number;
  /** Highest elevation, in {@link verticalUnit}. */
  readonly max: number;
  /**
   * The unit these heights are in — EXPLICIT, never inferred from a sibling.
   * A layer that declares nothing passes `'unknown'`, and that is a refusal,
   * not a reason to borrow the neighbour's unit.
   */
  readonly verticalUnit: CrsLinearUnit;
  /** Optional layer identifier, used to name the offending layer in a refusal. */
  readonly layerId?: string;
}

/** The shared range, when the inputs support one. */
export interface SharedElevationRange {
  readonly mixed: false;
  /** Lowest elevation across every layer, in {@link verticalUnit}. */
  readonly min: number;
  /** Highest elevation across every layer, in {@link verticalUnit}. */
  readonly max: number;
  /** The unit every input agreed on. */
  readonly verticalUnit: DeclaredVerticalUnit;
}

/** The refusal, when merging would produce a number that means nothing. */
export interface MixedElevationRange {
  readonly mixed: true;
  /** Why no shared range exists — safe to show a user as-is. */
  readonly reason: string;
}

/** A shared project elevation range, or a refusal explaining its absence. */
export type ProjectElevationRange = SharedElevationRange | MixedElevationRange;

/** How a range is named in a refusal: its id when it has one, else its position. */
function rangeLabel(range: LayerElevationRange, index: number): string {
  return range.layerId ?? `Layer ${index + 1}`;
}

/**
 * Combine per-layer elevation ranges into one project range.
 *
 * Returns `{ mixed: false, min, max, verticalUnit }` when every input range is
 * finite, correctly ordered, and declares the same vertical unit. Returns
 * `{ mixed: true, reason }` otherwise — including for an empty input, because a
 * project with no ranges has no range, and `[Infinity, -Infinity]` is not an
 * answer to that question.
 *
 * A single range is a valid project range: there is nothing to disagree with,
 * so the answer is that layer's own window, which is what the single-layer path
 * already shows.
 */
export function combineElevationRanges(
  ranges: readonly LayerElevationRange[],
): ProjectElevationRange {
  if (ranges.length === 0) {
    return {
      mixed: true,
      reason: 'No layer elevation ranges were supplied, so the project has no shared range.',
    };
  }

  // The unit is taken from the first range and every later range must match it.
  // Seeding it here (rather than tracking a nullable through the loop) is what
  // lets the agreed unit be a DeclaredVerticalUnit by construction, with no
  // cast at the end asserting something the code did not prove.
  const first = ranges[0];
  if (first.verticalUnit === 'unknown') {
    return {
      mixed: true,
      reason:
        `${rangeLabel(first, 0)} declares no vertical unit, so its elevations cannot be ` +
        'compared with any other layer’s.',
    };
  }
  const verticalUnit: DeclaredVerticalUnit = first.verticalUnit;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const who = rangeLabel(range, i);
    if (range.verticalUnit === 'unknown') {
      return {
        mixed: true,
        reason:
          `${who} declares no vertical unit, so its elevations cannot be compared with ` +
          'any other layer’s.',
      };
    }
    if (range.verticalUnit !== verticalUnit) {
      return {
        mixed: true,
        reason:
          `Vertical units disagree: ${verticalUnit} and ${range.verticalUnit} (${who}). ` +
          'Heights in different units are not merged — convert them first.',
      };
    }
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      return {
        mixed: true,
        reason:
          `${who} has a non-finite elevation range (min ${String(range.min)}, ` +
          `max ${String(range.max)}).`,
      };
    }
    // An inverted range is finite and unit-consistent, and merging it would
    // silently widen the project range in the wrong direction. It is a broken
    // input, and saying so beats absorbing it.
    if (range.min > range.max) {
      return {
        mixed: true,
        reason: `${who} has an inverted elevation range (min ${range.min} is above max ${range.max}).`,
      };
    }
    if (range.min < min) min = range.min;
    if (range.max > max) max = range.max;
  }

  return { mixed: false, min, max, verticalUnit };
}
