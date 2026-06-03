/**
 * polygonHygiene.ts
 *
 * Pure-data guard layer for the volumetric polygon paths. The volume
 * tool, the lasso volume tool, and any future polygon-driven analytic
 * all need the same five questions answered before they spend cycles on
 * a point-sample integration:
 *
 *   1. Does this polygon have at least 3 finite vertices?
 *   2. Is its signed area non-zero? (collinear / coincident vertices
 *      collapse to area 0 and produce NaN volumes downstream.)
 *   3. Does any edge cross another? (a self-intersecting polygon is
 *      ambiguous — the "inside" is undefined and the shoelace area
 *      lies about the true coverage.)
 *   4. Is every vertex finite? (NaN / Infinity sneak in through bad
 *      picks against streaming clouds whose nodes haven't loaded.)
 *   5. Is the bounding box non-degenerate? (a zero-width or zero-
 *      height box is geometrically a line — same NaN cliff.)
 *
 * The functions below are deterministic, allocation-light, and
 * importable in Node tests with no three.js / DOM stubbing. The
 * `validatePolygon` entry point returns a typed result the controller
 * can branch on without re-parsing free-text reasons.
 *
 * Self-intersection test — O(n²) brute-force segment crossings.
 * Volume polygons are small (typically 3–24 vertices for area / volume,
 * up to ~200 for a hand-drawn lasso convex hull) so the quadratic cost
 * is well under a millisecond and the simpler implementation is easier
 * to audit than a Bentley–Ottmann sweep-line.
 */

import type { Vec3 } from '../navMath';

/** A 2D polygon vertex. */
export interface Vec2Like {
  readonly x: number;
  readonly y: number;
}

/** The polygon's overall validity verdict. */
export type PolygonValidity =
  | 'ok'
  | 'too-few-vertices'
  | 'non-finite-vertex'
  | 'zero-area'
  | 'degenerate-bbox'
  | 'self-intersecting';

/** Structured outcome of `validatePolygon`. */
export interface PolygonValidationResult {
  /** `'ok'` if every check passed; one of the failure tags otherwise. */
  readonly validity: PolygonValidity;
  /** Signed (CCW-positive) shoelace area of the polygon, m². NaN-safe. */
  readonly signedArea: number;
  /** Absolute footprint area, m². Always finite. */
  readonly absoluteArea: number;
  /** Bounding box span on x. Always finite (NaN-safe). */
  readonly bboxWidth: number;
  /** Bounding box span on y. Always finite (NaN-safe). */
  readonly bboxHeight: number;
}

/**
 * Signed shoelace area of a 2D polygon. Positive when the vertices wind
 * counter-clockwise, negative when clockwise. NaN-safe — non-finite
 * vertices yield 0 instead of NaN, leaving the caller to surface the
 * shape problem via `validatePolygon` rather than discovering it as a
 * mysterious NaN downstream.
 */
export function signedArea2D(polygon: ReadonlyArray<Vec2Like>): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      return 0;
    }
    sum += xj * yi - xi * yj;
  }
  return sum * 0.5;
}

/**
 * Pure 2D bounding box. Returns NaN-safe spans — non-finite vertices
 * collapse to {width: 0, height: 0} so the caller can flag a degenerate
 * footprint without a try/catch ladder.
 */
export function bbox2D(polygon: ReadonlyArray<Vec2Like>): {
  readonly width: number;
  readonly height: number;
} {
  if (polygon.length === 0) return { width: 0, height: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { width: 0, height: 0 };
    }
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { width: maxX - minX, height: maxY - minY };
}

/**
 * `true` when two closed segments (a₀,a₁) and (b₀,b₁) share at least
 * one interior point. Touching at a shared vertex doesn't count — that
 * would flag every legal polygon as self-intersecting. NaN-safe: any
 * non-finite component returns `false`, leaving downstream finite-
 * vertex checks to flag the bad point.
 */
function segmentsCrossInterior(
  a0: Vec2Like,
  a1: Vec2Like,
  b0: Vec2Like,
  b1: Vec2Like,
): boolean {
  if (
    !Number.isFinite(a0.x) || !Number.isFinite(a0.y) ||
    !Number.isFinite(a1.x) || !Number.isFinite(a1.y) ||
    !Number.isFinite(b0.x) || !Number.isFinite(b0.y) ||
    !Number.isFinite(b1.x) || !Number.isFinite(b1.y)
  ) {
    return false;
  }
  const d1x = a1.x - a0.x;
  const d1y = a1.y - a0.y;
  const d2x = b1.x - b0.x;
  const d2y = b1.y - b0.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return false;
  const dx = b0.x - a0.x;
  const dy = b0.y - a0.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const u = (dx * d1y - dy * d1x) / denom;
  // Open interval — touching at an endpoint (t∈{0,1} or u∈{0,1}) is
  // allowed so adjacent edges sharing a vertex don't trigger the check.
  const EPS = 1e-9;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS;
}

/**
 * `true` when any two non-adjacent edges of the polygon cross. O(n²)
 * brute-force pair walk; volume polygons are small enough that this
 * costs microseconds.
 */
export function isPolygonSelfIntersecting(polygon: ReadonlyArray<Vec2Like>): boolean {
  const n = polygon.length;
  if (n < 4) return false; // 3 vertices = triangle, always simple
  for (let i = 0; i < n; i++) {
    const a0 = polygon[i];
    const a1 = polygon[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip the edge that shares vertex `(i+1)` with edge `i`.
      if (j === (i + 1) % n) continue;
      // Skip the edge that shares vertex `i` with the last edge.
      if (i === 0 && j === n - 1) continue;
      const b0 = polygon[j];
      const b1 = polygon[(j + 1) % n];
      if (segmentsCrossInterior(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}

/** Convenience predicate for "polygon has too few unique vertices to enclose area". */
export function isPolygonDegenerate(polygon: ReadonlyArray<Vec2Like>): boolean {
  if (polygon.length < 3) return true;
  const signed = signedArea2D(polygon);
  if (!Number.isFinite(signed) || Math.abs(signed) < 1e-9) return true;
  const { width, height } = bbox2D(polygon);
  return !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0;
}

/**
 * Run every guard against the polygon and return a structured verdict.
 * The controller branches on `validity` to render the right empty-state
 * — a self-intersecting polygon should read "shape crosses itself"
 * rather than "no points selected".
 *
 * Vertices are taken in placement order; the validator does NOT
 * reorder or close the polygon. Callers MUST repeat the first vertex
 * IF the shape needs to be tested as closed (the volume polygon
 * already does this implicitly — its first and last vertex are
 * adjacent in the shoelace walk).
 */
export function validatePolygon(
  polygon: ReadonlyArray<Vec2Like>,
): PolygonValidationResult {
  const n = polygon.length;
  if (n < 3) {
    return {
      validity: 'too-few-vertices',
      signedArea: 0,
      absoluteArea: 0,
      bboxWidth: 0,
      bboxHeight: 0,
    };
  }
  for (const v of polygon) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) {
      return {
        validity: 'non-finite-vertex',
        signedArea: 0,
        absoluteArea: 0,
        bboxWidth: 0,
        bboxHeight: 0,
      };
    }
  }
  const signed = signedArea2D(polygon);
  const absolute = Math.abs(signed);
  const { width, height } = bbox2D(polygon);
  // Self-intersection check FIRST — a bow-tie polygon has zero
  // signed area (the lobes cancel via shoelace) but the geometric
  // problem is the crossing, not the area. Reporting "zero-area" on
  // a bow-tie would mislead the user into thinking they just need to
  // spread the vertices apart.
  if (isPolygonSelfIntersecting(polygon)) {
    return {
      validity: 'self-intersecting',
      signedArea: signed,
      absoluteArea: absolute,
      bboxWidth: width,
      bboxHeight: height,
    };
  }
  if (absolute < 1e-9) {
    return {
      validity: 'zero-area',
      signedArea: signed,
      absoluteArea: absolute,
      bboxWidth: width,
      bboxHeight: height,
    };
  }
  if (width <= 0 || height <= 0) {
    return {
      validity: 'degenerate-bbox',
      signedArea: signed,
      absoluteArea: absolute,
      bboxWidth: width,
      bboxHeight: height,
    };
  }
  return {
    validity: 'ok',
    signedArea: signed,
    absoluteArea: absolute,
    bboxWidth: width,
    bboxHeight: height,
  };
}

/**
 * Project a 3D polygon onto the horizontal plane (x, y), strip the z
 * axis. Used by the volume path to feed `validatePolygon`. NaN-safe —
 * non-finite components are preserved so `validatePolygon` can flag
 * them as `'non-finite-vertex'`.
 */
export function polygonXY(polygon: ReadonlyArray<Vec3>): Vec2Like[] {
  return polygon.map((p) => ({ x: p[0], y: p[1] }));
}

/**
 * Human-friendly reason string for each validity tag. Drives the
 * inspector empty-state copy so the UI doesn't have to maintain its
 * own switch table.
 */
export function describeValidity(v: PolygonValidity): string {
  switch (v) {
    case 'ok':
      return 'Polygon valid.';
    case 'too-few-vertices':
      return 'Polygon needs at least 3 vertices.';
    case 'non-finite-vertex':
      return 'Polygon has a missing or invalid vertex.';
    case 'zero-area':
      return 'Polygon collapses to a line — pick non-collinear points.';
    case 'degenerate-bbox':
      return 'Polygon footprint has zero width or height.';
    case 'self-intersecting':
      return 'Polygon crosses itself — redraw without overlapping edges.';
  }
}
