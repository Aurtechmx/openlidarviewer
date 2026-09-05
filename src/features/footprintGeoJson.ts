/**
 * footprintGeoJson.ts — export building footprints as RFC 7946 GeoJSON.
 *
 * Each footprint's traced ring becomes a Polygon feature carrying its area,
 * centroid and, honestly, its DERIVED status: these are candidates extracted
 * from classified points, not surveyed building outlines, and the property set
 * says so.
 *
 * Coordinates are WGS 84 longitude/latitude, which is what RFC 7946 means, and
 * there is no `crs` member because the RFC removed it. This used to write the
 * ring's RENDER-LOCAL coordinates while a `metadata.crs` declared them to be in
 * the source projected frame. They were neither: extraction runs on the
 * recentred buffer, so a UTM scan exported a building at coordinates near the
 * grid origin labelled as easting/northing, and a reader placed it hundreds of
 * kilometres from the site. The caller reprojects, and refuses when it cannot —
 * the same rule the contour writer and the scan-footprint KML already follow.
 * Pure, no IO.
 */

import type { Pt2 } from './footprintTrace';

export interface FootprintFeatureInput {
  /**
   * Closed outer ring in WGS 84 lon/lat (first vertex not repeated). The caller
   * converts; passing render-local or projected points here writes a file whose
   * coordinates do not mean what the format says they mean.
   */
  readonly ring: readonly Pt2[];
  /** Cell-count area in the source frame's own unit squared. Always present. */
  readonly areaSource: number;
  /**
   * The same area in m², or null when the source's linear unit is not known.
   *
   * Callers used to collapse these two with `areaM2 ?? areaSource`, which wrote
   * a foot-unit magnitude into a property named for metres, in a file that
   * leaves the application. A reader cannot tell that apart from a real m²
   * value, so the metric property is omitted entirely when it is not known.
   */
  readonly areaM2: number | null;
  readonly centroidX: number;
  readonly centroidY: number;
  /** Optional stable id for the footprint. */
  readonly id?: string | number;
}

export interface FootprintGeoJsonOptions {
  /**
   * Source CRS label (e.g. "EPSG:3301"), recorded as provenance ONLY — the
   * coordinates are lon/lat. RFC 7946 removed the `crs` member precisely so a
   * reader never has to ask which frame a position is in, so this must never
   * be written back as one.
   */
  readonly sourceCrsLabel?: string | null;
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
  metadata: { extractedFromCrs?: string; product: string; note: string };
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
          areaSource: round(f.areaSource, 3),
          // Present only when the linear unit is known. See FootprintFeatureInput.
          ...(f.areaM2 == null ? {} : { areaM2: round(f.areaM2, 3) }),
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
      // Provenance, not a coordinate declaration: which frame the footprints
      // were EXTRACTED in, before reprojection.
      ...(options.sourceCrsLabel ? { extractedFromCrs: options.sourceCrsLabel } : {}),
      product: 'building-footprint-candidates',
      note: 'Derived footprint candidates from classified building points; not surveyed outlines. Coordinates are WGS 84 longitude/latitude per RFC 7946.',
    },
    features,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
