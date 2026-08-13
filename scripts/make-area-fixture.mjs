#!/usr/bin/env node
/**
 * make-area-fixture.mjs — emit the planar polygon fixture for the MEAS-AREA
 * cross-implementation study (OpenLiDARViewer shoelace/Newell area vs GDAL/OGR
 * OGR_GEOM_AREA).
 *
 *   node scripts/make-area-fixture.mjs > validation/cross-implementation/meas-area/input-polygons.geojson
 *
 * Every polygon is planar (z is 0 by construction; the GeoJSON carries 2-D
 * coordinates and the candidate lifts them to z=0), so the Newell-normal area
 * the candidate computes equals the closed-form shoelace area and OGR's planar
 * OGR_GEOM_AREA. Each feature carries a stable `id` and its closed-form
 * `analyticArea`, so the comparison runs as a triangle: candidate vs analytic,
 * OGR vs analytic, candidate vs OGR. Coordinates are kept O(1e3) or below so an
 * absolute area tolerance is a faithful gate rather than a float-scale artefact.
 *
 * Deterministic: no Date, no RNG. Coordinates are exact terminating decimals so
 * the JSON round-trips byte-identically.
 */

/** [id, description, ring (closed or open; closed here), analyticArea]. */
const POLYGONS = [
  ['unit-square', 'axis-aligned unit square', [[0, 0], [1, 0], [1, 1], [0, 1]], 1],
  ['rect-2x3', 'axis-aligned 2x3 rectangle', [[0, 0], [2, 0], [2, 3], [0, 3]], 6],
  ['right-triangle-3-4', 'right triangle, legs 4 and 3', [[0, 0], [4, 0], [0, 3]], 6],
  ['l-shape', 'non-convex L (concave vertex)', [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]], 12],
  ['big-square-100', '100x100 square (larger scale)', [[0, 0], [100, 0], [100, 100], [0, 100]], 10000],
  ['rotated-square', 'unit-diagonal square rotated 45 degrees', [[1, 0], [2, 1], [1, 2], [0, 1]], 2],
  ['fractional', 'fractional-coordinate rectangle 3 x 1.75', [[0.5, 0.5], [3.5, 0.5], [3.5, 2.25], [0.5, 2.25]], 5.25],
  ['offset-unit-square', 'unit square translated to (1000,1000) — offset invariance', [[1000, 1000], [1001, 1000], [1001, 1001], [1000, 1001]], 1],
];

function feature([id, description, ring, analyticArea]) {
  const closed = [...ring, ring[0]]; // GeoJSON rings are explicitly closed
  return {
    type: 'Feature',
    properties: { id, description, analyticArea },
    geometry: { type: 'Polygon', coordinates: [closed] },
  };
}

const fc = {
  type: 'FeatureCollection',
  name: 'input-polygons',
  features: POLYGONS.map(feature),
};

process.stdout.write(JSON.stringify(fc, null, 2) + '\n');
