/**
 * volume.ts
 *
 * Cut / fill volume estimation over a polygon footprint and a horizontal
 * reference plane. Pure, unit-testable in Node — no three.js, no DOM.
 *
 * The surveyor's question this module answers: "If I drew this polygon
 * on the ground and set a reference height, how much earth above the
 * plane sits inside the polygon (fill), and how much earth below the
 * plane (cut)?"
 *
 * Algorithm — the "point sample" estimator, the standard browser-side
 * approximation used by every viewer that doesn't ship a triangulated
 * mesh extractor:
 *
 *   1. Compute the polygon's horizontal-plane (map) area.
 *   2. Walk the cloud's points. For each point whose (x, y) projection
 *      lies inside the polygon, bucket its Δz = z − referenceZ.
 *   3. Sum the positive Δz values (fill) and the absolute negative Δz
 *      values (cut). Multiply each by `polygonArea / pointsInPolygon`
 *      — the per-point footprint each sample represents at uniform
 *      density.
 *   4. Net = fill − cut.
 *
 * Limits — documented honestly so the report can show the right caveat:
 *
 *   • Assumes the cloud is reasonably uniform-density inside the
 *     polygon. A scan with a sparse corner will under-report volume in
 *     that corner.
 *   • The reference is a horizontal plane (constant z). A future
 *     iteration accepts a triangulated reference mesh.
 *   • The cloud's "up" is assumed to be Z. Hand `up` in for a different
 *     CRS convention; the projection helpers use it directly.
 *
 * Confidence — `sampleCount` and `pointsInPolygon` let the caller
 * compute a coverage ratio and show a soft "low confidence" badge when
 * fewer than ~100 points fell in the footprint.
 */

import type { Vec3 } from '../navMath';
import {
  type PolygonValidity,
  validatePolygon,
} from './polygonHygiene';

// ── tiny vector helpers (duplicated module-local for the leaf contract) ────

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len < 1e-12 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Project a point onto the horizontal plane perpendicular to `up` — i.e.
 * subtract the vertical component. The returned `Vec3` still has the
 * world coordinates, just with the height stripped to zero relative to
 * the reference point. Use `pointInPolygon2D` for the actual inside test.
 */
function horizontalProjection(p: Vec3, up: Vec3): { x: number; y: number } {
  // For Z-up world (the OpenLiDARViewer convention), this is just (px, py).
  // The general form below works for any `up` axis by picking the two
  // basis vectors that span the horizontal plane.
  const u = normalize(up);
  // If up is close to canonical +Z, fast-path the common case.
  if (Math.abs(u[2] - 1) < 1e-6 && Math.abs(u[0]) < 1e-6 && Math.abs(u[1]) < 1e-6) {
    return { x: p[0], y: p[1] };
  }
  // General case: pick a stable "east" perpendicular to up, then "north"
  // = up × east. Project the point onto (east, north).
  const east = normalize(cross(u, Math.abs(u[2]) < 0.99 ? [0, 0, 1] : [1, 0, 0]));
  const north = cross(u, east);
  return { x: dot(p, east), y: dot(p, north) };
}

/**
 * Point-in-polygon test in 2D (ray-casting / even-odd rule). The polygon
 * is described as an array of 2D vertices in placement order. The ray
 * cast is HALF-OPEN with respect to vertex y-coordinates: a point
 * whose y matches a vertex y exactly is treated consistently — never
 * counted twice — but the result is "edge-undefined" on the exact
 * boundary. For dense point clouds this is a non-issue (rim points
 * are negligible vs interior mass); the volume integration is
 * stable. Callers that need strict edge-inclusive semantics should
 * inflate the polygon by an epsilon before testing.
 */
export function pointInPolygon2D(
  x: number,
  y: number,
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    // Half-open ray cast — see the function docstring for the edge
    // semantics. The `|| 1e-18` divisor guard prevents a division by
    // zero when an edge is exactly horizontal.
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-18) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Map-plane (horizontal) area of a polygon by the shoelace formula.
 * Translation-invariant, sign-agnostic — returns absolute area in m².
 */
export function polygonHorizontalArea(
  polygon: ReadonlyArray<{ x: number; y: number }>,
): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += (polygon[j].x + polygon[i].x) * (polygon[j].y - polygon[i].y);
  }
  return Math.abs(sum) * 0.5;
}

/** Cut / fill estimation result. */
export interface VolumeResult {
  /** Volume above the reference plane, m³. Always ≥ 0. */
  fill: number;
  /** Volume below the reference plane, m³. Always ≥ 0. */
  cut: number;
  /** Net = fill − cut, m³. Negative when more was excavated than filled. */
  net: number;
  /** Polygon footprint area on the horizontal plane, m². */
  footprintArea: number;
  /** Number of cloud points whose XY projection landed inside the polygon. */
  pointsInPolygon: number;
  /** Total cloud points considered (positions.length / 3). */
  sampleCount: number;
  /** Sample density inside the polygon (points / m²). NaN when area = 0. */
  density: number;
  /**
   * Median absolute Δz inside the polygon, m — a useful "thickness"
   * scalar for the report card. NaN when no points landed inside.
   */
  medianAbsDelta: number;
  /**
   * Polygon-hygiene verdict from `validatePolygon`. Volume callers
   * branch on this to surface the empty-state ("polygon crosses
   * itself", "polygon collapses to a line") instead of silently
   * returning zeros.
   *
   * Optional for back-compat with consumers reading legacy session
   * files that pre-date the hygiene layer; treat `undefined` as `'ok'`.
   */
  validity?: PolygonValidity;
}

/**
 * Inputs to `volumeCutFill`. The polygon is given as an array of 3D
 * vertices (the same array a polygon measurement stores); the function
 * projects them onto the horizontal plane internally.
 */
export interface VolumeInput {
  /** Polygon vertices in placement order, local render-space. */
  polygon: ReadonlyArray<Vec3>;
  /** Reference Z value (local render-space), m. */
  referenceZ: number;
  /** World up vector. Defaults to `[0, 0, 1]`. */
  up?: Vec3;
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  positions: Float32Array;
}

/**
 * Compute the cut / fill volume of a polygon footprint above and below a
 * horizontal reference plane, by point-sample integration. Returns
 * conservative zeros (with `footprintArea` still populated) when the
 * polygon has fewer than 3 vertices or the sample count is zero.
 */
export function volumeCutFill(input: VolumeInput): VolumeResult {
  const up = input.up ?? ([0, 0, 1] as Vec3);
  const projectedPoly = input.polygon.map((p) => horizontalProjection(p, up));
  const sampleCount = input.positions.length / 3;

  // Polygon-hygiene gate — single source of truth for "is this polygon
  // usable as a volumetric footprint?". Self-intersecting / collinear /
  // NaN-containing polygons return zeros AND a tag so the inspector
  // empty state reads accurately instead of "no points selected".
  const validation = validatePolygon(projectedPoly);
  const footprintArea = validation.absoluteArea;
  if (validation.validity !== 'ok' || sampleCount === 0) {
    return {
      fill: 0,
      cut: 0,
      net: 0,
      footprintArea,
      pointsInPolygon: 0,
      sampleCount,
      density: 0,
      medianAbsDelta: Number.NaN,
      validity: validation.validity,
    };
  }

  // Walk every point and bucket its Δz when inside the polygon.
  const ups = up; // pre-normalise inline
  const isZUp =
    Math.abs(ups[2] - 1) < 1e-6 && Math.abs(ups[0]) < 1e-6 && Math.abs(ups[1]) < 1e-6;
  const refZ = input.referenceZ;

  let fillSum = 0;
  let cutSum = 0;
  let inCount = 0;
  // We collect inside Δz magnitudes for the median; cap the buffer at 10 000 to
  // bound allocation on a 100 M-point chunk. Filling it with the FIRST 10 000
  // inside points biases the median when the cloud is ordered by scanline,
  // tile, or strip (the first 10 000 cover only one corner of the polygon).
  // Reservoir sampling (Algorithm R) keeps a uniform sample across ALL inside
  // points instead, so the median describes the whole footprint. A fixed-seed
  // xorshift keeps it deterministic — same input, same median.
  const MAX_DELTAS = 10_000;
  const deltas = new Float64Array(MAX_DELTAS);
  let rngState = 0x9e3779b9 | 0; // fixed seed → reproducible sample
  const nextUnit = (): number => {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return (rngState >>> 0) / 4294967296;
  };

  for (let i = 0; i < sampleCount; i++) {
    const px = input.positions[i * 3];
    const py = input.positions[i * 3 + 1];
    const pz = input.positions[i * 3 + 2];
    let hx: number;
    let hy: number;
    let height: number;
    if (isZUp) {
      hx = px;
      hy = py;
      height = pz;
    } else {
      const h = horizontalProjection([px, py, pz], ups);
      hx = h.x;
      hy = h.y;
      height = dot([px, py, pz], normalize(ups));
    }
    if (!pointInPolygon2D(hx, hy, projectedPoly)) continue;
    const dz = height - refZ;
    if (dz >= 0) fillSum += dz;
    else cutSum += -dz;
    // Reservoir sampling for the median buffer: fill directly until full, then
    // replace a uniformly-chosen slot so every inside point has an equal chance
    // of being in the final sample. (The fill/cut SUMS above already use every
    // point — only the median needs de-biasing.)
    const absDz = Math.abs(dz);
    if (inCount < MAX_DELTAS) {
      deltas[inCount] = absDz;
    } else {
      const j = Math.floor(nextUnit() * (inCount + 1));
      if (j < MAX_DELTAS) deltas[j] = absDz;
    }
    inCount++;
  }

  if (inCount === 0) {
    return {
      fill: 0,
      cut: 0,
      net: 0,
      footprintArea,
      pointsInPolygon: 0,
      sampleCount,
      density: 0,
      medianAbsDelta: Number.NaN,
      validity: 'ok',
    };
  }

  const areaPerPoint = footprintArea / inCount;
  const fill = fillSum * areaPerPoint;
  const cut = cutSum * areaPerPoint;
  const net = fill - cut;

  // Median of the collected |Δz| samples (cap-aware).
  const used = Math.min(inCount, MAX_DELTAS);
  const sub = deltas.subarray(0, used).slice();
  sub.sort();
  const median = used % 2 === 1 ? sub[(used - 1) >> 1] : (sub[used / 2 - 1] + sub[used / 2]) * 0.5;

  return {
    fill,
    cut,
    net,
    footprintArea,
    pointsInPolygon: inCount,
    sampleCount,
    density: inCount / footprintArea,
    medianAbsDelta: median,
    validity: 'ok',
  };
}

/**
 * Suggest a sensible reference Z for a polygon when the user hasn't
 * picked one: the median height of the polygon's own vertices. This is
 * the "auto-flat" reference — the analyst can override it with an
 * explicit number from the measurement card.
 */
export function autoReferenceZ(polygon: ReadonlyArray<Vec3>, up?: Vec3): number {
  if (polygon.length === 0) return 0;
  const u = normalize(up ?? ([0, 0, 1] as Vec3));
  const isZUp =
    Math.abs(u[2] - 1) < 1e-6 && Math.abs(u[0]) < 1e-6 && Math.abs(u[1]) < 1e-6;
  const heights: number[] = new Array(polygon.length);
  for (let i = 0; i < polygon.length; i++) {
    heights[i] = isZUp ? polygon[i][2] : dot(polygon[i], u);
  }
  heights.sort((a, b) => a - b);
  const n = heights.length;
  return n % 2 === 1 ? heights[(n - 1) >> 1] : (heights[n / 2 - 1] + heights[n / 2]) * 0.5;
}
