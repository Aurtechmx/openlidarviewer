/**
 * profileCorridorOutline.ts
 *
 * The corridor a profile section sampled, as drawable geometry.
 *
 * While a section is active the scene should show which returns were
 * eligible. `profileCorridor.ts` owns the membership test; this module owns
 * its OUTLINE, so the shape on screen and the shape the sampler walked come
 * from one description of the corridor rather than two.
 *
 * The corridor is a capsule, not a rectangle. Membership is the distance to
 * the FINITE segment `a -> b` measured in the plane perpendicular to `up`, so
 * past either endpoint the boundary is a half-disc of radius `halfWidth`
 * centred on that endpoint. A rectangle drawn to the same half width would
 * claim the four corner regions, each reaching `halfWidth * sqrt(2)` from an
 * endpoint, which the sampler rejected. Those corners are the difference
 * between showing the support and overstating it, so the caps are arcs here.
 *
 * The outline sits at the heights of the picked endpoints: `lateral` is
 * perpendicular to `up`, so offsetting by it moves a vertex sideways without
 * moving it up, and the walls follow the section's own vertical run. Nothing
 * reads or writes an axis by index: every direction comes from the frame, or
 * for a horizontally degenerate section from a basis derived from `up`.
 *
 * Pure geometry. Arrays of 3D vertices, no three.js, no DOM, no scene objects.
 */

import type { Vec3 } from '../navMath';
import type { ProfileFrame } from './profileGeometry';
import { DEGENERATE_HORIZONTAL_LENGTH } from './profileGeometry';

/**
 * Segments per half-turn of cap arc.
 *
 * A chord across an arc of half-angle `d` sits `r * (1 - cos d)` inside the
 * true boundary, so an arc drawn with `n` segments over a half turn deviates
 * by at most `r * (1 - cos(pi / (2n)))`. Holding that under one part in a
 * thousand of the half width needs `pi / (2n) <= acos(0.999)`, i.e.
 * `n >= 35.2`; 36 is the first integer that clears it, and it divides the half
 * turn into whole five-degree steps. At a corridor drawn 200 px wide the worst
 * chord is under a fifth of a pixel, so the drawn cap and the sampled cap are
 * the same shape at any zoom a viewer will use.
 *
 * The deviation is inward. Where the polyline departs from the true boundary
 * it under-claims the corridor, never over-claims it.
 */
export const DEFAULT_CORRIDOR_ARC_SEGMENTS = 36;

/** The chord fraction {@link DEFAULT_CORRIDOR_ARC_SEGMENTS} was solved for. */
export const CORRIDOR_ARC_CHORD_FRACTION = 1e-3;

/** Fewest segments a cap can be drawn with: one chord per half turn. */
export const MIN_CORRIDOR_ARC_SEGMENTS = 1;

/**
 * Most segments a cap can be drawn with. Far past any display need (under a
 * twentieth of a degree per step); it is here so a caller's bad number cannot
 * ask for an unbounded allocation.
 */
export const MAX_CORRIDOR_ARC_SEGMENTS = 4096;

/** What the outline shows, for a corridor with width. */
export const PROFILE_CORRIDOR_OUTLINE_LABEL =
  'Corridor sampled by this section: sampling support, not an uncertainty band';

/** What the outline shows when the corridor has no width. */
export const PROFILE_CORRIDOR_OUTLINE_LABEL_NO_BAND =
  'Section line only: this corridor has no width to outline';

/** What the outline shows when there is no corridor to draw at all. */
export const PROFILE_CORRIDOR_OUTLINE_LABEL_NONE =
  'No corridor outline: this section frame is degenerate';

/**
 * Which shape the corridor took.
 *
 * `capsule` is the ordinary case. `disc` is a section with no plan extent,
 * whose corridor is a cylinder about the vertical through the endpoints, so
 * the caps come back as closed rings and there are no lateral walls. `line`
 * is a corridor of zero half width. `none` is a frame with no usable up axis
 * or a non-finite endpoint, where drawing anything would be inventing it.
 */
export type ProfileCorridorOutlineKind = 'capsule' | 'disc' | 'line' | 'none';

/** The corridor outline as vertex arrays a renderer can draw directly. */
export interface ProfileCorridorOutline {
  /** The transect itself: the two section endpoints, `[a, b]`. */
  readonly centre: Vec3[];
  /** The `+lateral` wall, start to end. Empty unless the kind is `capsule`. */
  readonly leftBoundary: Vec3[];
  /** The `-lateral` wall, end to start. Empty unless the kind is `capsule`. */
  readonly rightBoundary: Vec3[];
  /**
   * The cap at `a`. For a `capsule`, an open arc running from `a - halfWidth *
   * lateral` through `a - halfWidth * along` to `a + halfWidth * lateral`. For
   * a `disc`, a closed ring about `a` whose last vertex repeats its first.
   */
  readonly startCap: Vec3[];
  /** The cap at `b`, mirrored: `b + halfWidth * lateral` round to `b - halfWidth * lateral`. */
  readonly endCap: Vec3[];
  /**
   * The whole capsule boundary as one closed polyline, last vertex repeating
   * the first. Empty unless the kind is `capsule`; a `disc` has two separate
   * rings rather than one loop.
   */
  readonly loop: Vec3[];
  /** The half width the outline was drawn at, after clamping. */
  readonly halfWidth: number;
  /** Segments per half turn actually used, after clamping. */
  readonly arcSegments: number;
  /** Which of the four shapes this outline is. */
  readonly kind: ProfileCorridorOutlineKind;
  /** Short description of what the outline is, for a scene caption or legend. */
  readonly label: string;
}

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function isZeroVec(v: Vec3): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * An orthonormal basis of the plane perpendicular to the unit vector `u`.
 *
 * The seed axis is whichever world axis `u` leans on least, chosen by
 * comparing its own components rather than assumed: the cross product is then
 * at least `sqrt(2/3)` long and can always be normalised. Rotating the scene
 * can change which axis wins, which rotates the phase of a drawn ring and
 * leaves the ring itself the same circle.
 */
function perpendicularBasis(u: Vec3): [Vec3, Vec3] {
  const ax = Math.abs(u[0]);
  const ay = Math.abs(u[1]);
  const az = Math.abs(u[2]);
  const seed: Vec3 =
    ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const raw = cross(u, seed);
  const len = Math.hypot(raw[0], raw[1], raw[2]);
  const e0: Vec3 = [raw[0] / len, raw[1] / len, raw[2] / len];
  return [e0, cross(u, e0)];
}

/**
 * Vertices of the half turn that leaves `centre + r * e0`, passes through
 * `centre + r * e1` and arrives at `centre - r * e0`. `segs + 1` vertices.
 *
 * The two ends are placed from `e0` directly instead of from `cos`/`sin` of
 * 0 and pi, because `Math.sin(Math.PI)` is 1.2e-16 rather than 0. That makes
 * each cap end land bit for bit on the wall vertex it meets, so the assembled
 * loop closes exactly rather than nearly.
 */
function halfTurn(centre: Vec3, e0: Vec3, e1: Vec3, r: number, segs: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segs; i++) {
    const theta = (Math.PI * i) / segs;
    const c = i === 0 ? 1 : i === segs ? -1 : Math.cos(theta);
    const s = i === 0 || i === segs ? 0 : Math.sin(theta);
    out.push([
      centre[0] + r * (c * e0[0] + s * e1[0]),
      centre[1] + r * (c * e0[1] + s * e1[1]),
      centre[2] + r * (c * e0[2] + s * e1[2]),
    ]);
  }
  return out;
}

/** A closed ring about `centre` in the plane spanned by `e0`, `e1`. */
function fullTurn(centre: Vec3, e0: Vec3, e1: Vec3, r: number, segs: number): Vec3[] {
  const half = halfTurn(centre, e0, e1, r, segs);
  const back = halfTurn(centre, [-e0[0], -e0[1], -e0[2]], [-e1[0], -e1[1], -e1[2]], r, segs);
  return [...half, ...back.slice(1)];
}

function offset(p: Vec3, dir: Vec3, scale: number): Vec3 {
  return [p[0] + dir[0] * scale, p[1] + dir[1] * scale, p[2] + dir[2] * scale];
}

function emptyOutline(halfWidth: number, arcSegments: number): ProfileCorridorOutline {
  return {
    centre: [],
    leftBoundary: [],
    rightBoundary: [],
    startCap: [],
    endCap: [],
    loop: [],
    halfWidth,
    arcSegments,
    kind: 'none',
    label: PROFILE_CORRIDOR_OUTLINE_LABEL_NONE,
  };
}

/**
 * Build the outline of the corridor `frame` sampled at `halfWidth`.
 *
 * `halfWidth` is the same number the sampler used, as returned by
 * `resolveCorridorHalfWidth`. `arcSegments` is segments per half turn of cap;
 * it is floored, clamped into
 * `[MIN_CORRIDOR_ARC_SEGMENTS, MAX_CORRIDOR_ARC_SEGMENTS]`, and a non-finite
 * value falls back to {@link DEFAULT_CORRIDOR_ARC_SEGMENTS}.
 *
 * Never throws and never emits a non-finite vertex: a degenerate frame comes
 * back as a smaller shape, down to no vertices at all, with `kind` and `label`
 * saying which.
 */
export function buildProfileCorridorOutline(
  frame: ProfileFrame,
  halfWidth: number,
  arcSegments: number = DEFAULT_CORRIDOR_ARC_SEGMENTS,
): ProfileCorridorOutline {
  const segs = Number.isFinite(arcSegments)
    ? Math.min(MAX_CORRIDOR_ARC_SEGMENTS, Math.max(MIN_CORRIDOR_ARC_SEGMENTS, Math.floor(arcSegments)))
    : DEFAULT_CORRIDOR_ARC_SEGMENTS;

  const up = frame.up;
  const a = frame.a;
  const b = frame.b;
  // A zero `up` is how buildProfileFrame reports an unusable axis. Without it
  // there is no plane to measure the corridor in, so there is no outline.
  if (!isFiniteVec(up) || isZeroVec(up) || !isFiniteVec(a) || !isFiniteVec(b)) {
    return emptyOutline(Number.isFinite(halfWidth) ? Math.max(0, halfWidth) : 0, segs);
  }

  const centre: Vec3[] = [
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
  ];

  const r = Number.isFinite(halfWidth) ? halfWidth : 0;
  if (!(r > 0)) {
    return {
      centre,
      leftBoundary: [],
      rightBoundary: [],
      startCap: [],
      endCap: [],
      loop: [],
      halfWidth: Math.max(0, r),
      arcSegments: segs,
      kind: 'line',
      label: PROFILE_CORRIDOR_OUTLINE_LABEL_NO_BAND,
    };
  }

  const len = frame.horizontalLength;
  const along = frame.along;
  const lateral = frame.lateral;
  // The same threshold the sampler and the station walk use for "no plan
  // extent", so the three agree on when a section stops being a transect.
  const horizontal = Number.isFinite(len) && len > DEGENERATE_HORIZONTAL_LENGTH && !isZeroVec(along);

  if (!horizontal) {
    // No direction along the section, so the corridor is the cylinder of
    // radius r about the vertical through the endpoints. Drawing walls would
    // mean picking a lateral direction the corridor does not have; a ring at
    // each endpoint height is the whole of it.
    const [e0, e1] = perpendicularBasis(up);
    return {
      centre,
      leftBoundary: [],
      rightBoundary: [],
      startCap: fullTurn(a, e0, e1, r, segs),
      endCap: fullTurn(b, e0, e1, r, segs),
      loop: [],
      halfWidth: r,
      arcSegments: segs,
      kind: 'disc',
      label: PROFILE_CORRIDOR_OUTLINE_LABEL,
    };
  }

  const leftBoundary: Vec3[] = [offset(a, lateral, r), offset(b, lateral, r)];
  const rightBoundary: Vec3[] = [offset(b, lateral, -r), offset(a, lateral, -r)];
  // Swept so each cap starts where the wall before it ended: the end cap
  // leaves the +lateral wall, bulges past `b` along `along`, and lands on the
  // -lateral wall; the start cap does the mirror at `a`.
  const endCap = halfTurn(b, lateral, along, r, segs);
  const startCap = halfTurn(
    a,
    [-lateral[0], -lateral[1], -lateral[2]],
    [-along[0], -along[1], -along[2]],
    r,
    segs,
  );
  const loop: Vec3[] = [
    ...leftBoundary,
    ...endCap.slice(1),
    rightBoundary[1],
    ...startCap.slice(1),
  ];

  return {
    centre,
    leftBoundary,
    rightBoundary,
    startCap,
    endCap,
    loop,
    halfWidth: r,
    arcSegments: segs,
    kind: 'capsule',
    label: PROFILE_CORRIDOR_OUTLINE_LABEL,
  };
}

/**
 * Every boundary vertex the outline emits, in no particular order.
 *
 * The centre transect is deliberately absent: it is the corridor's axis, not
 * its edge. Handy for a renderer sizing one buffer, and for a check that wants
 * to hold all of them against the membership test.
 */
export function profileCorridorBoundaryVertices(outline: ProfileCorridorOutline): Vec3[] {
  return [
    ...outline.leftBoundary,
    ...outline.rightBoundary,
    ...outline.startCap,
    ...outline.endCap,
  ];
}
