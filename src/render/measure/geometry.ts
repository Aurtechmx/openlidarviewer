/**
 * geometry.ts
 *
 * Pure measurement mathematics — segment lengths, polyline totals, polygon
 * area (own-plane and horizontal/map projection), 3-point angles, slope, and
 * vertical delta. No three.js, no DOM: unit-tested in Node.
 *
 * Every function takes plain `Vec3` tuples in one consistent coordinate space.
 * Distances, areas, angles and slopes are translation-invariant, so working in
 * the cloud's local space gives correct results; only absolute-coordinate
 * *display* needs the cloud origin added back, which the caller handles.
 */

import type { Vec3 } from '../navMath';

const EPSILON = 1e-9;

// ── small vector helpers ────────────────────────────────────────────────────

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len < EPSILON ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}

/** Straight-line distance between two points. */
export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

// ── polyline ────────────────────────────────────────────────────────────────

/** Length of each consecutive segment of a polyline. */
export function segmentLengths(points: Vec3[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    out.push(distance(points[i - 1], points[i]));
  }
  return out;
}

/**
 * Polyline measurement: per-segment lengths, the running cumulative total
 * after each segment, and the grand total.
 */
export function polylineLength(points: Vec3[]): {
  segments: number[];
  cumulative: number[];
  total: number;
} {
  const segments = segmentLengths(points);
  const cumulative: number[] = [];
  let running = 0;
  for (const s of segments) {
    running += s;
    cumulative.push(running);
  }
  return { segments, cumulative, total: running };
}

// ── polygon area ────────────────────────────────────────────────────────────

/**
 * Newell normal of a polygon — a vector perpendicular to the polygon's
 * best-fit plane whose magnitude is twice the polygon's area. Robust for the
 * slightly non-planar vertex rings that real picked polygons always produce.
 */
export function newellNormal(points: Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/**
 * Area of the polygon on its own best-fit plane (the true surface area).
 * Returns 0 for fewer than three vertices.
 */
export function polygonAreaPlanar(points: Vec3[]): number {
  if (points.length < 3) return 0;
  return length(newellNormal(points)) / 2;
}

/**
 * Horizontal (map / footprint) area — the polygon projected onto the plane
 * perpendicular to `up`. Derived exactly from the Newell normal: the projected
 * area is the normal's component along `up`, halved.
 */
export function polygonAreaHorizontal(points: Vec3[], up: Vec3): number {
  if (points.length < 3) return 0;
  return Math.abs(dot(newellNormal(points), normalize(up))) / 2;
}

/** Perimeter of a closed polygon ring (last vertex joins back to the first). */
export function polygonPerimeter(points: Vec3[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += distance(points[i], points[(i + 1) % points.length]);
  }
  return total;
}

// ── angle ───────────────────────────────────────────────────────────────────

/**
 * Interior angle at `vertex`, formed by the rays toward `a` and `c`, in
 * degrees (0–180). Returns 0 when either ray is degenerate (a coincident
 * point), so a half-placed angle measurement reads cleanly.
 */
export function angleAtVertex(a: Vec3, vertex: Vec3, c: Vec3): number {
  const va = normalize(sub(a, vertex));
  const vc = normalize(sub(c, vertex));
  if (length(va) < EPSILON || length(vc) < EPSILON) return 0;
  const cosine = Math.min(1, Math.max(-1, dot(va, vc)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

// ── slope ───────────────────────────────────────────────────────────────────

/** The result of {@link slopeBetween}. */
export interface Slope {
  /** Signed vertical change from `a` to `b`, measured along `up`. */
  rise: number;
  /** Horizontal distance — the component perpendicular to `up`. */
  run: number;
  /** Grade as a percentage (100 · rise / run); `Infinity` for a vertical pair. */
  gradePercent: number;
  /** Inclination from horizontal, in degrees (−90 … +90). */
  angleDeg: number;
}

/** Slope from `a` to `b` relative to the world-up axis. */
export function slopeBetween(a: Vec3, b: Vec3, up: Vec3): Slope {
  const u = normalize(up);
  const d = sub(b, a);
  const rise = dot(d, u);
  const run = length(sub(d, [u[0] * rise, u[1] * rise, u[2] * rise]));
  const gradePercent =
    run < EPSILON ? (rise === 0 ? 0 : Infinity) : (100 * rise) / run;
  const angleDeg = (Math.atan2(rise, run) * 180) / Math.PI;
  return { rise, run, gradePercent, angleDeg };
}

// ── vertical delta (height tool) ────────────────────────────────────────────

/**
 * Vertical and horizontal offsets between two points relative to `up`.
 * `vertical` is the signed delta along `up` — the height tool's headline
 * value; `horizontal` is the distance perpendicular to `up`.
 */
export function verticalDelta(a: Vec3, b: Vec3, up: Vec3): {
  vertical: number;
  horizontal: number;
} {
  const u = normalize(up);
  const d = sub(b, a);
  const vertical = dot(d, u);
  const horizontal = length(
    sub(d, [u[0] * vertical, u[1] * vertical, u[2] * vertical]),
  );
  return { vertical, horizontal };
}
