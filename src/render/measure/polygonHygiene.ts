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
import { NeumaierSum } from '../../process/numerics';

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
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(polygon[i].x) || !Number.isFinite(polygon[i].y)) return 0;
  }
  return anchoredShoelace(n, (i) => polygon[i].x, (i) => polygon[i].y);
}

/**
 * Signed shoelace area of a ring given as accessors. The first vertex is
 * subtracted from every vertex before the cross products, so a ring far from
 * the origin no longer loses its area to cancellation between two huge
 * products, and the terms are added with Neumaier compensation. Translation
 * invariant to rounding; for a ring already near the origin the result is the
 * ordinary shoelace value.
 */
export function anchoredShoelace(
  n: number,
  xAt: (i: number) => number,
  yAt: (i: number) => number,
): number {
  if (n < 3) return 0;
  const ax = xAt(0);
  const ay = yAt(0);
  const acc = new NeumaierSum();
  let xj = xAt(n - 1) - ax;
  let yj = yAt(n - 1) - ay;
  for (let i = 0; i < n; i++) {
    const xi = xAt(i) - ax;
    const yi = yAt(i) - ay;
    acc.add(xj * yi - xi * yj);
    xj = xi;
    yj = yi;
  }
  return acc.total * 0.5;
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

/** Relative tolerance for treating three points as collinear. */
const COLLINEAR_REL = 1e-12;

/**
 * Orientation of c relative to the directed line a to b: 1, -1, or 0 when the
 * three points are collinear within a tolerance scaled to the two vectors.
 */
function orient(a: Vec2Like, b: Vec2Like, c: Vec2Like): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const cross = abx * acy - aby * acx;
  const tol = COLLINEAR_REL * (Math.hypot(abx, aby) * Math.hypot(acx, acy));
  if (Math.abs(cross) <= tol) return 0;
  return cross > 0 ? 1 : -1;
}

/** `true` when c, known collinear with a-b, lies within the segment's span. */
function withinSpan(a: Vec2Like, b: Vec2Like, c: Vec2Like): boolean {
  return (
    c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x) &&
    c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y)
  );
}

/**
 * `true` when two ring edges conflict. Non-adjacent edges conflict when they
 * share any point: a proper crossing, a vertex resting on the other edge, or a
 * collinear overlap. Adjacent edges share their common vertex by construction
 * and conflict only when the second edge doubles back along the first.
 * NaN-safe: any non-finite component returns `false`, leaving the finite-vertex
 * check to flag the bad point.
 */
function edgesConflict(
  a0: Vec2Like,
  a1: Vec2Like,
  b0: Vec2Like,
  b1: Vec2Like,
  adjacent: boolean,
): boolean {
  if (
    !Number.isFinite(a0.x) || !Number.isFinite(a0.y) ||
    !Number.isFinite(a1.x) || !Number.isFinite(a1.y) ||
    !Number.isFinite(b0.x) || !Number.isFinite(b0.y) ||
    !Number.isFinite(b1.x) || !Number.isFinite(b1.y)
  ) {
    return false;
  }
  const o1 = orient(a0, a1, b0);
  const o2 = orient(a0, a1, b1);
  const o3 = orient(b0, b1, a0);
  const o4 = orient(b0, b1, a1);
  if (adjacent) {
    // Shared vertex s, far ends p (edge a) and q (edge b). A fold-back is a
    // collinear pair pointing the same way from s.
    const aFirst = a1.x === b0.x && a1.y === b0.y;
    const s = aFirst ? a1 : a0;
    const p = aFirst ? a0 : a1;
    const q = aFirst ? b1 : b0;
    const collinear = (aFirst ? o2 : o1) === 0 && (aFirst ? o4 : o3) === 0;
    if (!collinear) return false;
    return (p.x - s.x) * (q.x - s.x) + (p.y - s.y) * (q.y - s.y) > 0;
  }
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  if (o1 === 0 && withinSpan(a0, a1, b0)) return true;
  if (o2 === 0 && withinSpan(a0, a1, b1)) return true;
  if (o3 === 0 && withinSpan(b0, b1, a0)) return true;
  if (o4 === 0 && withinSpan(b0, b1, a1)) return true;
  return false;
}

/**
 * `true` when any two edges of the polygon cross, touch, or overlap. O(n²)
 * brute-force pair walk; volume polygons are small enough that this
 * costs microseconds.
 */
export function isPolygonSelfIntersecting(input: ReadonlyArray<Vec2Like>): boolean {
  // A repeated pick (consecutive identical vertices, or a closing copy of the
  // first) adds a zero-length edge and no geometry, so it is set aside.
  const polygon: Vec2Like[] = [];
  for (const p of input) {
    const last = polygon[polygon.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) polygon.push(p);
  }
  if (polygon.length > 1 && polygon[0].x === polygon.at(-1)!.x && polygon[0].y === polygon.at(-1)!.y) {
    polygon.pop();
  }
  const n = polygon.length;
  if (n < 4) return false; // 3 vertices = triangle, always simple
  for (let i = 0; i < n; i++) {
    const a0 = polygon[i];
    const a1 = polygon[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === (i + 1) % n || (i === 0 && j === n - 1);
      const b0 = polygon[j];
      const b1 = polygon[(j + 1) % n];
      if (edgesConflict(a0, a1, b0, b1, adjacent)) return true;
    }
  }
  return false;
}

/**
 * Smallest area, relative to the bounding box, that still counts as an area.
 * Collinear vertices leave only rounding residue of order 1e-16 of the box.
 */
const MIN_AREA_FRACTION = 1e-12;

/** `true` when every vertex lies on one line (or all coincide). */
function isCollinearRing(polygon: ReadonlyArray<Vec2Like>): boolean {
  const o = polygon[0];
  let far = o;
  let best = 0;
  for (const p of polygon) {
    const d = Math.hypot(p.x - o.x, p.y - o.y);
    if (d > best) {
      best = d;
      far = p;
    }
  }
  if (best === 0) return true;
  return polygon.every((p) => orient(o, far, p) === 0);
}

/** Convenience predicate for "polygon has too few unique vertices to enclose area". */
export function isPolygonDegenerate(polygon: ReadonlyArray<Vec2Like>): boolean {
  if (polygon.length < 3) return true;
  const signed = signedArea2D(polygon);
  const { width, height } = bbox2D(polygon);
  if (!Number.isFinite(signed) || Math.abs(signed) <= MIN_AREA_FRACTION * width * height) return true;
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
  if (!isCollinearRing(polygon) && isPolygonSelfIntersecting(polygon)) {
    return {
      validity: 'self-intersecting',
      signedArea: signed,
      absoluteArea: absolute,
      bboxWidth: width,
      bboxHeight: height,
    };
  }
  if (absolute <= MIN_AREA_FRACTION * width * height) {
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
