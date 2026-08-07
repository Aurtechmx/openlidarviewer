/**
 * scanFootprint.ts: the scanned area as a polygon, and the gate that decides
 * whether it may be published at all.
 *
 * A footprint is a stronger claim than any other product in this panel. A
 * measurement CSV in source units is still true when the CRS is unknown; a
 * polygon in lon/lat says "the scan is HERE, on Earth", and there is no honest
 * version of that sentence without a known coordinate system. So the CRS gate
 * lives here as a pure predicate ({@link footprintCrsRefusal}) and returns the
 * user-facing reason, rather than a boolean the caller has to write copy for.
 * Two more predicates guard the same claim from the other end — the frame the
 * extent was measured in ({@link footprintUpAxisRefusal}) and the ring's own
 * geometry once it is in degrees ({@link footprintAntimeridianRefusal}) — and
 * all three return prose for the same reason.
 *
 * Pure: no DOM, no three.js, no proj4. The reprojection arrives as an injected
 * {@link LocalToLonLatSourceZ}, exactly as `kmlExport.ts` takes its transform,
 * so the whole module is unit-testable in Node. `lonLatMapper.ts` builds that
 * transform from the resolved CRS and declines (returns null) for any frame it
 * cannot convert; a null mapper here is a refusal, never a fallback.
 *
 * Version 1 emits the axis-aligned bounding rectangle of the scan in its own
 * CRS. That is the extent the loader already knows exactly, for both static and
 * streaming sources, so it needs no point scan and cannot be stale. A tighter
 * outline (convex hull) would need the resident positions and would mean
 * something different, so it is deliberately not offered rather than silently
 * substituted.
 */

import type { LocalToLonLatSourceZ } from './lonLatMapper';
import { LonLatConversionError } from './lonLatMapper';
import type { SpatialUpAxis } from '../geo/SpatialContext';

/**
 * The scan's axis-aligned XY extent, in LOCAL (origin-relative) render space.
 *
 * X and Y are the HORIZONTAL pair only in a Z-up frame. A Y-up source stores
 * its horizontal plane on X/Z, so the same two fields would then describe one
 * horizontal axis and the elevation axis — a rectangle with a height for a
 * side. Nothing in this shape can tell the two cases apart, which is why the
 * caller must state the up-axis and {@link footprintUpAxisRefusal} gates it.
 */
export interface FootprintExtent {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A closed ring of `[x, y]` pairs: first vertex repeated as the last. */
export type FootprintRing = readonly (readonly [number, number])[];

/**
 * Raised when a footprint cannot be produced honestly: a degenerate extent, an
 * unusable coordinate system, or a corner that leaves the projection's domain.
 * The caller surfaces `message` to the user and writes no file.
 */
export class ScanFootprintError extends Error {}

/**
 * The structural CRS facts the gate reads. Kept minimal (and structural) so a
 * `ResolvedCrs` passes without a cast and the module never imports the CRS
 * service.
 */
export interface FootprintCrs {
  readonly kind: 'local' | 'projected' | 'geographic' | 'unknown';
  readonly confidence: 'high' | 'medium' | 'low' | 'none';
  readonly userConfirmed: boolean;
}

/** Where the caller read the extent, stated inside the file. */
export type FootprintExtentBasis = 'the resident points' | 'the declared header extent';

/**
 * Why this scan may NOT be published as a footprint, or null when it may.
 *
 * Fail-closed in three steps, each with its own reason so the user knows what
 * to do next:
 *
 *   1. No CRS, or a local / unknown frame. There is nothing to reproject from.
 *   2. `confidence: 'none'`, which is the resolver's way of saying it found no
 *      metadata and fell back to a default assumption.
 *   3. A low-confidence detection the user has not confirmed. The Inspector
 *      already says "Low-confidence detection. Confirm before using converted
 *      coordinates." about exactly this state; a published polygon is the
 *      strongest form of using converted coordinates, so it waits for the
 *      confirmation instead of shipping a guess.
 *
 * A medium- or high-confidence projected / geographic CRS passes, which is the
 * same bar the site KML export applies.
 */
export function footprintCrsRefusal(crs: FootprintCrs | null | undefined): string | null {
  if (!crs || crs.kind === 'local' || crs.kind === 'unknown') {
    return 'The scan has no known coordinate system, so its outline cannot be placed on a map. '
      + 'Set the coordinate system in the Inspector, then export again.';
  }
  if (crs.confidence === 'none') {
    return 'The coordinate system was assumed, not read from the file, so the outline would be a '
      + 'guess. Set the coordinate system in the Inspector, then export again.';
  }
  if (crs.confidence === 'low' && !crs.userConfirmed) {
    return 'The coordinate system was detected with low confidence. Confirm it in the Inspector '
      + 'before exporting an outline that places this scan on a map.';
  }
  return null;
}

/**
 * Why this scan's up-axis makes a footprint impossible, or null when it does not.
 *
 * The extent is read off local X/Y, and every downstream step — the ring, the
 * reprojection, the `lon,lat` pairs — inherits that choice. X/Y is the ground
 * plane in a Z-up frame and nowhere else: a Y-up source (a phone scan, a glTF /
 * OBJ-derived cloud) keeps its horizontal plane on X/Z, so the exported outline
 * would pair one horizontal axis with the elevation axis and draw a vertical
 * slice through the site as if it were the area covered. It would still be a
 * plausible rectangle on the map, which is the whole problem.
 *
 * This GATES rather than adapts, and deliberately so. Swapping the accessors
 * (as `terrain/ground/axisGetters.ts` does for the analysis pipeline) would fix
 * the extent and leave the rest wrong: `lonLatMapper` reads the local point as
 * `[easting, northing, height]` when it hands X and Y to the projection, so a
 * Y-up scan has no correct reprojection to swap axes INTO. Publishing a
 * footprint for one would need the whole local→CRS placement re-derived, and
 * this module refuses rather than shipping half of that.
 *
 * `'unknown'` refuses too. An undetected axis is not evidence of Z-up, and the
 * failure it hides is silent — the same reason `SpatialUpAxis` carries the
 * third state instead of defaulting to `'z'`.
 */
export function footprintUpAxisRefusal(upAxis: SpatialUpAxis | null | undefined): string | null {
  if (upAxis === 'z') return null;
  if (upAxis === 'y') {
    return 'This scan is stored Y-up, so its horizontal plane is not the X/Y pair a scan outline '
      + 'is measured from. Exporting one would draw a vertical slice of the site as if it were '
      + 'the area covered, so no outline is written for Y-up sources.';
  }
  return 'The scan\'s up-axis was not determined, so there is no way to tell which two axes are '
    + 'horizontal. An outline drawn from the wrong pair would still look like a plausible '
    + 'rectangle on the map, so it is not written.';
}

/**
 * The axis-aligned bounding rectangle as a closed, counter-clockwise ring.
 *
 * Winding matters: KML reads an outer boundary by the right-hand rule, and some
 * readers treat a clockwise outer ring as a hole, which renders the footprint
 * as a void punched out of the map. Starting at the minimum corner and walking
 * east, north, west gives counter-clockwise for the usual x-east / y-north
 * projected axes.
 *
 * A degenerate extent is refused rather than collapsed: a zero-width rectangle
 * is a line, and a line published as a polygon is a false statement about the
 * area covered.
 */
export function footprintRectangleRing(extent: FootprintExtent): FootprintRing {
  const { minX, minY, maxX, maxY } = extent;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new ScanFootprintError(
      'The scan extent contains a value that is not a number, so no outline can be drawn from it.',
    );
  }
  if (maxX <= minX || maxY <= minY) {
    throw new ScanFootprintError(
      'The scan covers no area on the horizontal plane, so it has no outline to export.',
    );
  }
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

/**
 * Why a reprojected ring cannot be published as one polygon, or null when it can.
 *
 * Longitude is cyclic and a KML `<LinearRing>` is not: a reader joins two
 * consecutive vertices along the SHORTER arc between their longitudes. A scan
 * straddling ±180° therefore comes out inside-out — corners at 179.8° and
 * -179.8° are 0.4° apart on the ground and 359.6° apart as numbers, so the
 * polygon drawn between them wraps the long way and outlines nearly the whole
 * planet. Every corner is individually a valid longitude, which is why the
 * per-coordinate domain check in `kmlExport.ts` cannot see this: the defect is
 * in the RING, not in any of its vertices.
 *
 * The test is the ring's longitude span. Above 180° the short way round must
 * cross the antimeridian, because no two points on Earth are more than 180°
 * apart in longitude by the short arc.
 *
 * We REFUSE rather than split at ±180°. A correct split is not just two boxes:
 * it changes what the file contains (one footprint becomes two polygons, or a
 * MultiGeometry), it has to decide which side each corner belongs to, and for a
 * projected source the two halves are no longer the reprojection of anything
 * the scan actually declared. This module's whole contract is that a footprint
 * is either the scan's own bounding rectangle placed on Earth or nothing at
 * all, and a silently invented pair of polygons is a worse trade than a refusal
 * the user can act on. A wide but non-crossing scan is unaffected — 150° of
 * honest longitude passes.
 */
export function footprintAntimeridianRefusal(ring: FootprintRing): string | null {
  if (ring.length === 0) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lon] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const span = maxLon - minLon;
  if (span <= 180) return null;
  return `The scan crosses the ±180° antimeridian: its corners run from ${minLon}° to ${maxLon}° `
    + 'longitude, so a single rectangle drawn between them wraps the long way round the Earth and '
    + 'outlines almost the whole world instead of the scan. No outline is written. Split the scan '
    + 'at the antimeridian and export each side, or reproject it to a coordinate system that does '
    + 'not straddle ±180°.';
}

/**
 * Reproject a local ring to WGS84 lon/lat degrees, or refuse.
 *
 * `toLonLat` is null whenever no honest transform exists, so the null branch is
 * a refusal with an actionable message. A per-corner failure (a coordinate that
 * leaves the projection's grid) is re-raised the same way: the mapper's own
 * guard exists because the alternative was writing easting 500000 into a KML
 * file as longitude 500000, and a partially placed footprint is not a degraded
 * result, it is a wrong one.
 *
 * The third ordinate is dropped. A horizontal reprojection establishes nothing
 * about the vertical axis, and a footprint claims a location, not a height.
 *
 * The finished ring is checked as a WHOLE by {@link footprintAntimeridianRefusal}
 * before it is returned. Corner-by-corner validation cannot catch a ring that
 * wraps ±180°, because each of its corners is a perfectly ordinary longitude;
 * the check belongs here, where the ring first exists in degrees, so no caller
 * can obtain a wrapped ring and skip it.
 */
export function footprintLonLatRing(
  ring: FootprintRing,
  toLonLat: LocalToLonLatSourceZ | null,
): FootprintRing {
  if (!toLonLat) {
    throw new ScanFootprintError(
      'This scan cannot be converted to longitude and latitude, so its outline cannot be written '
      + 'as KML. UTM and geographic coordinate systems are supported.',
    );
  }
  const lonLatRing = ring.map(([x, y]) => {
    let lonLat: [number, number, number];
    try {
      lonLat = toLonLat([x, y, 0]);
    } catch (err) {
      if (err instanceof LonLatConversionError) {
        throw new ScanFootprintError(
          `A corner of the scan could not be placed in longitude and latitude. ${err.message}`,
        );
      }
      throw err;
    }
    return [lonLat[0], lonLat[1]] as const;
  });
  const wrapped = footprintAntimeridianRefusal(lonLatRing);
  if (wrapped) throw new ScanFootprintError(wrapped);
  return lonLatRing;
}
