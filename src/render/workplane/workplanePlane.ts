/**
 * workplanePlane.ts
 *
 * The geometry of the reference plane in Float64: the three principal
 * orientations, the plane through three picked points, and the in-plane basis
 * the grid lines are laid along.
 *
 * FRAME. Every coordinate here is in the scan's own source axes (the frame the
 * readouts and the measurement tools report). Elevation is the up axis: Z for
 * the survey formats, Y for the mesh formats the scene draws Y-up. For a Y-up
 * scan, north is -Z, the same rotation the contour overlay uses
 * (`contourOverlayPlacement.ts`), so a horizontal grid on a Y-up scan is not a
 * mirror image of the same grid on a Z-up scan.
 *
 * THREE POINTS. Three picks define a plane only when they are not in a line.
 * The test is relative to the spread of the points, not an absolute distance:
 * the smallest altitude of the triangle (twice its area over its longest edge)
 * must be at least {@link COLLINEAR_TOLERANCE} of the longest edge. At 1e-3 a
 * triangle 100 m long must be at least 10 cm wide. A flatter triangle sets the
 * plane's tilt from a sliver that pick error alone can swing, so it is refused
 * rather than drawn. The plane passes through the three points exactly: it is
 * not fitted to the points around them, so pick noise goes straight into its
 * tilt.
 *
 * Pure: no DOM, no three.js.
 */

import type { WorkplaneOrientationSetting } from '../../model/workplaneSettings';

export type Vec3 = readonly [number, number, number];

/** Which source axis is elevation. */
export type WorkplaneUpAxis = 'z' | 'y';

/** The orientations the user can choose. */
export type WorkplaneOrientation = WorkplaneOrientationSetting;

/** A plane with an orthonormal in-plane basis, in source coordinates. */
export interface WorkplaneBasis {
  /** The point grid lines are counted from (the origin the user set). */
  readonly origin: Vec3;
  /** Unit normal. */
  readonly normal: Vec3;
  /** First in-plane direction (unit). */
  readonly u: Vec3;
  /** Second in-plane direction (unit), `normal × u`. */
  readonly v: Vec3;
}

/** Smallest altitude over longest edge below which three picks are refused. */
export const COLLINEAR_TOLERANCE = 1e-3;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => scale(a, 1 / length(a));

/** The unit up vector. */
export function upVector(axis: WorkplaneUpAxis): Vec3 {
  return axis === 'z' ? [0, 0, 1] : [0, 1, 0];
}

/** The unit east (source X) vector, the same for both conventions. */
export const EAST: Vec3 = [1, 0, 0];

/** The unit north vector: +Y on a Z-up scan, -Z on a Y-up scan. */
export function northVector(axis: WorkplaneUpAxis): Vec3 {
  return axis === 'z' ? [0, 1, 0] : [0, 0, -1];
}

/** Index of the up axis in a source triple. */
export function upIndex(axis: WorkplaneUpAxis): 1 | 2 {
  return axis === 'z' ? 2 : 1;
}

/** Indices of the two horizontal axes, east first. */
export function horizontalIndices(axis: WorkplaneUpAxis): readonly [0, 1] | readonly [0, 2] {
  return axis === 'z' ? [0, 1] : [0, 2];
}

/** Elevation of a source point. */
export function elevationOf(p: Vec3, axis: WorkplaneUpAxis): number {
  return p[upIndex(axis)];
}

/** Build a basis from an origin, a normal and a preferred first direction. */
function basisFrom(origin: Vec3, normal: Vec3, u: Vec3): WorkplaneBasis {
  const n = normalize(normal);
  const uu = normalize(u);
  return { origin, normal: n, u: uu, v: cross(n, uu) };
}

/**
 * A principal plane through `origin`.
 * - horizontal: perpendicular to up, lines along east and north;
 * - vertical-x: contains the east axis and up;
 * - vertical-north: contains the north axis and up.
 */
export function principalPlane(
  orientation: Exclude<WorkplaneOrientation, 'three-point'>,
  origin: Vec3,
  axis: WorkplaneUpAxis,
): WorkplaneBasis {
  const up = upVector(axis);
  const north = northVector(axis);
  if (orientation === 'horizontal') return basisFrom(origin, up, EAST);
  if (orientation === 'vertical-x') return basisFrom(origin, cross(EAST, up), EAST);
  return basisFrom(origin, cross(north, up), north);
}

/** The outcome of a three-point plane request. */
export type ThreePointResult =
  | {
      readonly ok: true;
      readonly basis: WorkplaneBasis;
      /** Angle between the plane and horizontal, degrees (0 = level, 90 = vertical). */
      readonly dipDeg: number;
      /** Smallest altitude over longest edge, the quantity the tolerance tests. */
      readonly flatness: number;
    }
  | { readonly ok: false; readonly reason: string; readonly flatness: number };

/**
 * The plane through three picked points, with origin at the first point.
 *
 * Orientation sign: the normal points up (positive up component). A vertical
 * plane has no up component, so its normal is made to point toward positive
 * east, or toward positive north when it has no east component either. The
 * same three points in any order give the same normal.
 */
export function planeFromThreePoints(
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  axis: WorkplaneUpAxis,
): ThreePointResult {
  for (const p of [p1, p2, p3]) {
    if (!p.every(Number.isFinite)) return { ok: false, reason: 'A picked point has no finite coordinates.', flatness: 0 };
  }
  // Work relative to the first point so a UTM-sized coordinate does not cost
  // the cross product its precision.
  const e1 = sub(p2, p1);
  const e2 = sub(p3, p1);
  const e3 = sub(p3, p2);
  const longest = Math.max(length(e1), length(e2), length(e3));
  if (!(longest > 0)) {
    return { ok: false, reason: 'The three points are the same point. Pick three points spread across the area.', flatness: 0 };
  }
  const n = cross(e1, e2);
  // |e1 × e2| is twice the triangle area; over the longest edge it is the
  // smallest altitude. Dividing by the longest edge again makes it scale-free.
  const flatness = length(n) / (longest * longest);
  // Written so a NaN flatness (an overflowed cross product) is refused too.
  if (!(flatness >= COLLINEAR_TOLERANCE)) {
    return {
      ok: false,
      reason:
        'The three points are in a line, or nearly. Pick a third point well away from the line through the other two.',
      flatness,
    };
  }
  const up = upVector(axis);
  let normal = normalize(n);
  const upComp = dot(normal, up);
  const north = northVector(axis);
  const EPS = 1e-12;
  const flip =
    upComp < -EPS ||
    (Math.abs(upComp) <= EPS &&
      (dot(normal, EAST) < -EPS || (Math.abs(dot(normal, EAST)) <= EPS && dot(normal, north) < 0)));
  if (flip) normal = scale(normal, -1);
  // First in-plane direction: the strike (horizontal line in the plane). A level
  // plane has no strike, so it takes east, as the horizontal grid does.
  const strike = cross(up, normal);
  const u = length(strike) > 1e-9 ? strike : EAST;
  const basis = basisFrom(p1, normal, u);
  const dipDeg = (Math.acos(Math.min(1, Math.abs(dot(basis.normal, up)))) * 180) / Math.PI;
  return { ok: true, basis, dipDeg, flatness };
}

/**
 * Move `p` onto the plane: along up when the plane is not close to vertical,
 * so the horizontal coordinates the user typed are kept and only the
 * elevation follows the plane; along the normal otherwise.
 */
export function placeOnPlane(p: Vec3, plane: WorkplaneBasis, axis: WorkplaneUpAxis): Vec3 {
  const up = upVector(axis);
  const d = dot(sub(p, plane.origin), plane.normal);
  const nu = dot(plane.normal, up);
  if (Math.abs(nu) > 0.05) return sub(p, scale(up, d / nu));
  return sub(p, scale(plane.normal, d));
}

/** Plane coordinates (along u, along v) of a source point. */
export function toPlaneCoords(p: Vec3, plane: WorkplaneBasis): [number, number] {
  const d = sub(p, plane.origin);
  return [dot(d, plane.u), dot(d, plane.v)];
}

/**
 * Where the ray from `from` toward `to` meets the plane, or null when it runs
 * parallel or meets it behind `from`.
 */
export function rayPlaneHit(from: Vec3, to: Vec3, plane: WorkplaneBasis): Vec3 | null {
  const dir = sub(to, from);
  const denom = dot(dir, plane.normal);
  if (Math.abs(denom) < 1e-12 * (length(dir) || 1)) return null;
  const t = dot(sub(plane.origin, from), plane.normal) / denom;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return add(from, scale(dir, t));
}

/** The foot of the perpendicular from `p` onto the plane. */
export function projectOntoPlane(p: Vec3, plane: WorkplaneBasis): Vec3 {
  return sub(p, scale(plane.normal, dot(sub(p, plane.origin), plane.normal)));
}
