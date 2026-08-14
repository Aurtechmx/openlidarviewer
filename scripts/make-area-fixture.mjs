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
  // Float-divergence stress. Coordinates far from the origin and/or irrational
  // make the shoelace products large and inexact, so the Newell (3-D) and OGR
  // (2-D) accumulations no longer coincide bit-for-bit — the comparison then
  // measures real double-precision agreement, not a trivial 0. The offset is
  // kept at ~5e4 (not the ~1e6 of a Krovak grid) so the ABSOLUTE 1e-6 m^2 gate
  // still holds: at 1e6 the cancellation error on a unit area exceeds it, which
  // is a documented scale limit of an absolute area tolerance.
  ['offset-rect-50k', '1 x 1000 rectangle at a large fractional offset (54321.75, 33333.25) — float cancellation', [[54321.75, 33333.25], [54322.75, 33333.25], [54322.75, 34333.25], [54321.75, 34333.25]], 1000],
  ['irrational-triangle', 'triangle with irrational vertices (root-2, pi scaled) — inexact coordinates', [[0, 0], [100 * Math.SQRT2, 7.5], [12.25, 100 * Math.PI]], irrationalTriArea()],
];

/** Exact shoelace area of the irrational triangle above (matches its ring). */
function irrationalTriArea() {
  const a = [0, 0], b = [100 * Math.SQRT2, 7.5], c = [12.25, 100 * Math.PI];
  return Math.abs(a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2;
}

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
