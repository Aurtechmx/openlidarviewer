/**
 * footprintModel.ts
 *
 * The pure footprint builder for Context View: turns a layer's finite XY
 * bounds into a lon/lat ring the 2D map can draw. Reprojection is INJECTED —
 * the caller supplies an (x, y) → [lonDeg, latDeg] transform (or null when the
 * point cannot be transformed), so this module never imports proj4 and stays
 * Node-testable with a trivial fake.
 *
 * The ring samples the 4 corners plus the 4 edge midpoints (8 points, in
 * order, NOT closed by repeating the first) so a projected rectangle whose
 * edges curve in lon/lat is not drawn as a false straight-edged box. If the
 * transform refuses (null) or returns non-finite degrees for ANY sample, the
 * whole footprint is refused with a vocabulary reason — a partially-placed
 * footprint would be a lie about where the scan is.
 *
 * Non-finite input bounds are a caller bug, not a data condition, and throw a
 * TypeError naming the argument (house style for poison values).
 */

import { CONTEXT_STATUS, type ContextStatusText } from './statusVocabulary';

/** Finite XY bounds in the layer's native frame. */
export interface FootprintBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * The injected reprojection: native (x, y) → [lonDeg, latDeg], or null when
 * the point cannot be transformed. Supplied by the caller; never proj4 here.
 */
export type LonLatTransform = (x: number, y: number) => readonly [number, number] | null;

/** A successfully built footprint ring. */
export interface ContextFootprint {
  readonly layerId: string;
  readonly name: string;
  /** 8 lon/lat pairs: corners + edge midpoints, counter-clockwise from (minX, minY); not closed. */
  readonly ringLonLat: readonly (readonly [number, number])[];
}

/** The footprint could not be built; `reason` is a vocabulary string. */
export interface FootprintRefusal {
  readonly failed: true;
  readonly reason: ContextStatusText;
}

export type FootprintResult = ContextFootprint | FootprintRefusal;

/**
 * Build a footprint ring for a layer. Throws TypeError on non-finite bounds
 * (naming `bounds`); returns a refusal when the injected transform declines
 * or produces non-finite degrees for any of the 8 samples.
 */
export function buildContextFootprint(
  layerId: string,
  name: string,
  bounds: FootprintBounds,
  toLonLat: LonLatTransform,
): FootprintResult {
  const { minX, minY, maxX, maxY } = bounds;
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    throw new TypeError('buildContextFootprint: "bounds" must contain finite minX/minY/maxX/maxY');
  }

  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Counter-clockwise from the south-west corner, corner → edge midpoint →
  // corner …, so consecutive points are always adjacent on the rectangle.
  const samples: readonly (readonly [number, number])[] = [
    [minX, minY],
    [midX, minY],
    [maxX, minY],
    [maxX, midY],
    [maxX, maxY],
    [midX, maxY],
    [minX, maxY],
    [minX, midY],
  ];

  const ring: (readonly [number, number])[] = [];
  for (const [x, y] of samples) {
    const ll = toLonLat(x, y);
    if (ll === null || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) {
      return { failed: true, reason: CONTEXT_STATUS.transformUnavailable };
    }
    ring.push([ll[0], ll[1]]);
  }

  return { layerId, name, ringLonLat: ring };
}
