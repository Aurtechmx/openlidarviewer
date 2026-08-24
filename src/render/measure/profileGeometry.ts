/**
 * profileGeometry.ts
 *
 * The section-line frame every profile surface projects against: the
 * sampler's corridor walk, the corridor auto-width, the station walk, the
 * scene station dots and the report station table.
 *
 * A profile is defined by two endpoints and the scene's up axis. Chainage is
 * the distance along the projection of a -> b onto the plane perpendicular to
 * `up`; height is the component along `up`. Reading chainage off X/Y and
 * height off Z is only equivalent when `up` is exactly [0, 0, 1].
 *
 * Pure, dependency-free (types only), no DOM, no three.js.
 */

import type { Vec3 } from '../navMath';

/** Scene up axis assumed when a caller supplies none. */
export const DEFAULT_PROFILE_UP: Vec3 = [0, 0, 1];

/**
 * Horizontal length at or below which a section has no plan extent, in render
 * units. Removing the `up` component of `b - a` leaves float residue whose size
 * scales with the coordinates, so an exact-zero test only catches the case
 * where `up` is an exact axis; a section 100 units long purely along a skew
 * `up` projects to ~5e-15 rather than 0. One threshold for the sampler's
 * degenerate branch and the station walk, so the two agree on when a section
 * has nothing to station.
 */
export const DEGENERATE_HORIZONTAL_LENGTH = 1e-9;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub(minuend: Vec3, subtrahend: Vec3): Vec3 {
  return [
    minuend[0] - subtrahend[0],
    minuend[1] - subtrahend[1],
    minuend[2] - subtrahend[2],
  ];
}
function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function normalize(v: Vec3): Vec3 {
  // One check covers every degenerate axis, because each divides to a
  // non-finite component: a zero length gives 0/0, an infinite one gives
  // Infinity/Infinity, and a NaN component stays NaN. The alternative is a
  // NaN unit vector, which every dot product downstream carries silently into
  // a height, a chainage and a corridor distance.
  const len = length(v);
  const out: Vec3 = [v[0] / len, v[1] / len, v[2] / len];
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2])
    ? out
    : [0, 0, 0];
}

/** The resolved geometry of one section line. All vectors are in render space. */
export interface ProfileFrame {
  /** Normalised scene up axis. `[0, 0, 0]` when the supplied up was degenerate. */
  readonly up: Vec3;
  /** Section start, as supplied. */
  readonly a: Vec3;
  /** Section end, as supplied. */
  readonly b: Vec3;
  /** `b - a` with its `up` component removed. */
  readonly horizontal: Vec3;
  /** Unit vector along `horizontal`. `[0, 0, 0]` when the section is horizontally degenerate. */
  readonly along: Vec3;
  /** Unit vector perpendicular to `along` in the horizontal plane (`up` x `along`). */
  readonly lateral: Vec3;
  /** `|horizontal|`: the chainage span of the section. */
  readonly horizontalLength: number;
  /** Signed height change from `a` to `b`, measured along `up`. */
  readonly verticalDelta: number;
  /** `a` with its `up` component removed: the origin chainage is measured from. */
  readonly horizontalAnchor: Vec3;
}

/** A point resolved against a section line. */
export interface ProfileProjection {
  /** Distance from `a` along `frame.along`, in the horizontal plane. */
  readonly chainage: number;
  /** Signed offset from the section line along `frame.lateral`. */
  readonly lateralOffset: number;
  /** Component along `frame.up`. */
  readonly height: number;
}

/**
 * Resolve the frame for the section `a -> b` under scene up axis `up`.
 *
 * `up` is normalised here; a zero or non-finite up normalises to `[0, 0, 0]`,
 * which leaves `horizontal` equal to `b - a` and `verticalDelta` at 0.
 */
export function buildProfileFrame(a: Vec3, b: Vec3, up: Vec3): ProfileFrame {
  const u = normalize(up);
  const ab = sub(b, a);
  const verticalDelta = dot(ab, u);
  const horizontal: Vec3 = [
    ab[0] - u[0] * verticalDelta,
    ab[1] - u[1] * verticalDelta,
    ab[2] - u[2] * verticalDelta,
  ];
  const horizontalLength = length(horizontal);
  const along: Vec3 =
    horizontalLength > 0 && Number.isFinite(horizontalLength)
      ? [
          horizontal[0] / horizontalLength,
          horizontal[1] / horizontalLength,
          horizontal[2] / horizontalLength,
        ]
      : [0, 0, 0];
  // u x along: unit length whenever both are unit and perpendicular, which
  // `horizontal` guarantees by construction.
  const lateral: Vec3 = [
    u[1] * along[2] - u[2] * along[1],
    u[2] * along[0] - u[0] * along[2],
    u[0] * along[1] - u[1] * along[0],
  ];
  const aUp = dot(a, u);
  const horizontalAnchor: Vec3 = [a[0] - u[0] * aUp, a[1] - u[1] * aUp, a[2] - u[2] * aUp];
  return {
    up: u,
    a,
    b,
    horizontal,
    along,
    lateral,
    horizontalLength,
    verticalDelta,
    horizontalAnchor,
  };
}

/**
 * Project one point onto the section: chainage along the line, signed lateral
 * offset from it, and height along `up`.
 *
 * The arithmetic matches `sampleProfile`'s per-point corridor walk term for
 * term, so a point binned by the sampler and a point projected here resolve to
 * the same chainage bit for bit.
 */
export function projectPointToProfile(frame: ProfileFrame, p: Vec3): ProfileProjection {
  const u = frame.up;
  const height = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
  const anchor = frame.horizontalAnchor;
  const dx = p[0] - u[0] * height - anchor[0];
  const dy = p[1] - u[1] * height - anchor[1];
  const dz = p[2] - u[2] * height - anchor[2];
  const along = frame.along;
  const lateral = frame.lateral;
  return {
    chainage: dx * along[0] + dy * along[1] + dz * along[2],
    lateralOffset: dx * lateral[0] + dy * lateral[1] + dz * lateral[2],
    height,
  };
}

/**
 * The 3D point on the segment `a -> b` whose chainage is `chainage`.
 *
 * `t = chainage / horizontalLength` and `position = a + t * (b - a)`. The
 * horizontal offset of `a + t * (b - a)` from `a` is `t * horizontal`, whose
 * length along the section is `t * horizontalLength`, so `t` recovers the
 * requested chainage; the point stays on the picked segment for any `up`.
 * Returns `a` when the section is horizontally degenerate.
 */
export function positionAtProfileChainage(frame: ProfileFrame, chainage: number): Vec3 {
  const h = frame.horizontalLength;
  if (!(h > 0) || !Number.isFinite(h)) return [frame.a[0], frame.a[1], frame.a[2]];
  const t = chainage / h;
  const a = frame.a;
  const b = frame.b;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}
