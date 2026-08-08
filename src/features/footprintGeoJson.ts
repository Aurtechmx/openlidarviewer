/**
 * footprintGeoJson.ts — export building footprints as RFC 7946 GeoJSON.
 *
 * Each footprint's traced ring becomes a Polygon feature carrying its area,
 * centroid and — honestly — its DERIVED status: these are candidates extracted
 * from classified points, not surveyed building outlines, and the property set
 * says so. Coordinates are written in the source projected frame (the same
 * frame the points were gridded in); the CRS is recorded in a `metadata` member
 * rather than reprojected here, matching how the contour export keeps the survey
 * grid rather than forcing lon/lat. Pure, no IO.
 */

import type { Pt2 } from './footprintTrace';

export interface FootprintFeatureInput {
  /** Closed outer ring in projected coordinates (first vertex not repeated). */
  readonly ring: readonly Pt2[];
  readonly areaM2: number;
  readonly centroidX: number;
  readonly centroidY: number;
  /** Optional stable id for the footprint. */
  readonly id?: string | number;
}

export interface FootprintGeoJsonOptions {
  /** Source CRS label (e.g. "EPSG:3301"), recorded as provenance. */
  readonly crs?: string | null;
  /** Method/version stamp for the extraction. */
  readonly method?: string;
}

/**
 * Build a GeoJSON FeatureCollection from footprints. A ring with fewer than
 * three vertices is skipped (not a polygon). Rings are closed on output (RFC
 * 7946 requires the first and last position to coincide).
 */
export function footprintsToGeoJson(
  footprints: readonly FootprintFeatureInput[],
  options: FootprintGeoJsonOptions = {},
): {
  type: 'FeatureCollection';
  metadata: { crs: string | null; product: string; note: string };
  features: Array<Record<string, unknown>>;
} {
  const features = footprints
    .filter((f) => f.ring.length >= 3)
    .map((f, i) => {
      const coords = f.ring.map((p) => [p.x, p.y]);
      // Close the ring per RFC 7946 §3.1.6.
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);
      return {
        type: 'Feature',
        id: f.id ?? i,
        geometry: { type: 'Polygon', coordinates: [coords] },
        properties: {
          areaM2: round(f.areaM2, 3),
          centroidX: round(f.centroidX, 3),
          centroidY: round(f.centroidY, 3),
          // Honesty: what this feature actually is.
          source: 'derived',
          featureType: 'building-footprint-candidate',
          method: options.method ?? 'occupancy-connected-components',
        },
      };
    });
  return {
    type: 'FeatureCollection',
    metadata: {
      crs: options.crs ?? null,
      product: 'building-footprint-candidates',
      note: 'Derived footprint candidates from classified building points; not surveyed outlines. Coordinates are in the source projected frame.',
    },
    features,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
