/**
 * src/io/catalog/types.ts
 *
 * Pure geographic type contracts for the public-LiDAR catalog. Kept
 * free of three.js / pdf-lib / DOM concerns so the catalog data files
 * (e.g. the curated locations list) stay trivially unit-testable in
 * Node.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Geographic primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A geographic bounding box: `[west, south, east, north]` in WGS-84
 * decimal degrees. The tuple form matches GeoJSON BBOX convention and
 * keeps the surface allocation-cheap.
 */
export type LatLonBbox = readonly [number, number, number, number];
