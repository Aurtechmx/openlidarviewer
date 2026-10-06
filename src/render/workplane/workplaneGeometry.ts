/**
 * workplaneGeometry.ts
 *
 * The reference grid's line buffers, built in Float64 and narrowed to Float32
 * once, relative to an anchor, and the per-vertex fade that keeps the grid
 * readable from any angle.
 *
 * WHY AN ANCHOR. A projected scan sits at coordinates in the millions. A
 * Float32 holds about seven significant digits, so a vertex written as an
 * absolute northing near 4,100,000 m is only good to a few decimetres, and
 * lines drawn that way crawl as the camera moves. Here every position is
 * computed in Float64 in source coordinates, the anchor is subtracted while
 * still in Float64, and only the remainder (at most the patch half size)
 * becomes a Float32 vertex. The anchor goes to the object's position, which
 * the renderer composes with the camera in Float64 on the CPU
 * (`renderer.highPrecision`).
 *
 * WHY THE GRID DOES NOT SWIM. Every line sits at an integer multiple of the
 * spacing from the user's origin. Moving the camera changes which lines are
 * drawn and how strongly, never where a line is.
 *
 * THE PATCH. Lines cover the scan's extent on the plane plus a margin of one
 * scan size on every side (`patchFor`), capped to {@link MAX_HALF_MAJORS}
 * major lines either side of the view's focus. Each line is split into short
 * segments so the fade can vary along it.
 *
 * THE FADE (`fadeAlphas`). A line is drawn at full strength while it sits at
 * least {@link FADE_FULL_PX} CSS px from its neighbour on screen, fades to
 * nothing at {@link FADE_ZERO_PX}, and fades out over the outer part of the
 * patch, so neither the horizon of a perspective view nor the edge of the
 * patch ends in a hard cut. The on-screen distance between two neighbouring
 * lines is the spacing times the pixels per unit at that depth times the
 * share of the spacing direction that is not along the line of sight:
 * `spacing · ppu(d) · sqrt(1 − (dir · p)²)`, where `p` is the in-plane
 * direction across the lines and `dir` the unit view direction.
 *
 * Pure: no DOM, no three.js.
 */

import { add, dot, scale, sub, type Vec3, type WorkplaneBasis } from './workplanePlane';

/** Most major lines drawn either side of the focus, whatever the scan size. */
export const MAX_HALF_MAJORS = 100;
/** Most segments one line is split into. */
export const MAX_SEGMENTS_PER_LINE = 32;
/**
 * Largest lattice index the patch may use. A double counts integers exactly
 * only up to 2^53, and past that `i++` no longer changes `i`, so a loop over
 * such indices never ends. 2^50 leaves room for the minor subdivision (at most
 * five per major) and the loop's last increment.
 */
export const MAX_SAFE_INDEX = 2 ** 50;
/**
 * Most minor lines per major interval. Five, so the largest minor index,
 * 5 x 2^50, stays below 2^53 and every minor loop counts exactly. The minor
 * step is a quarter or a fifth of the major (`minorStepFor`); a finer one is
 * not subdivided at all rather than drawn at a spacing the readout does not state.
 */
export const MAX_MINOR_RATIO = 5;
/** Most minor lines per direction; beyond this the minors are left out. */
export const MAX_MINOR_LINES = 600;
/** Lines closer than this on screen are not drawn. */
export const FADE_ZERO_PX = 6;
/** Lines at least this far apart on screen are drawn at full strength. */
export const FADE_FULL_PX = 14;
/** Share of the patch half size, at its outer edge, over which lines fade out. */
export const EDGE_FADE_SHARE = 0.3;

/** A patch of the lattice, as integer major-line indices from the origin. */
export interface WorkplanePatch {
  readonly iMin: number;
  readonly iMax: number;
  readonly jMin: number;
  readonly jMax: number;
}

/**
 * The patch to draw: the scan's box projected on the plane, widened by one
 * scan size on every side, snapped outward to the major lattice, and capped to
 * {@link MAX_HALF_MAJORS} major lines either side of the focus. When the focus
 * is far outside that range, the patch is the same cap around the box centre
 * instead. `boxPlane` is the scan box's extent in plane coordinates
 * `[sMin, sMax, tMin, tMax]`; `scanSize` its largest dimension.
 *
 * Returns null when the lattice indices would not be exact integers (the
 * origin is too far from the scan for this spacing, or the spacing is too
 * fine for the distance), so the caller draws nothing instead of looping.
 */
export function patchFor(
  boxPlane: readonly [number, number, number, number],
  scanSize: number,
  focus: readonly [number, number],
  major: number,
): WorkplanePatch | null {
  if (!(major > 0) || !Number.isFinite(major) || !Number.isFinite(scanSize)) return null;
  if (!boxPlane.every(Number.isFinite) || !focus.every(Number.isFinite)) return null;
  const margin = Math.max(scanSize, 4 * major);
  const range = (lo: number, hi: number, f: number): [number, number] | null => {
    const min = Math.floor((lo - margin) / major);
    const max = Math.ceil((hi + margin) / major);
    const centre = Math.round((lo + hi) / 2 / major);
    const fi = Math.round(f / major);
    for (const v of [min, max, centre, fi]) if (!Number.isSafeInteger(v) || Math.abs(v) > MAX_SAFE_INDEX) return null;
    let a = Math.max(min, fi - MAX_HALF_MAJORS);
    let b = Math.min(max, fi + MAX_HALF_MAJORS);
    // The focus is off the patch: centre the same cap on the scan instead.
    if (a > b) {
      a = Math.max(min, centre - MAX_HALF_MAJORS);
      b = Math.min(max, centre + MAX_HALF_MAJORS);
    }
    return [a, b];
  };
  const i = range(boxPlane[0], boxPlane[1], focus[0]);
  const j = range(boxPlane[2], boxPlane[3], focus[1]);
  if (!i || !j) return null;
  return { iMin: i[0], iMax: i[1], jMin: j[0], jMax: j[1] };
}

/** Whether a patch can be iterated safely: exact integer indices and a bounded span. */
export function patchIsSafe(p: WorkplanePatch): boolean {
  const idx = [p.iMin, p.iMax, p.jMin, p.jMax];
  if (!idx.every((v) => Number.isSafeInteger(v) && Math.abs(v) <= MAX_SAFE_INDEX)) return false;
  return p.iMax >= p.iMin && p.jMax >= p.jMin && p.iMax - p.iMin <= 2 * MAX_HALF_MAJORS && p.jMax - p.jMin <= 2 * MAX_HALF_MAJORS;
}

export interface WorkplaneGeometryInput {
  readonly plane: WorkplaneBasis;
  readonly patch: WorkplanePatch;
  readonly major: number;
  readonly minor: number;
  /** Draw the minor lines (false when they would crowd, or the view grazes the plane). */
  readonly showMinor: boolean;
  /** Source coordinate of the scene origin: scene = source - sceneOrigin. */
  readonly sceneOrigin: Vec3;
}

/** One line set: segment pairs and which in-plane direction runs across them. */
export interface WorkplaneLineSet {
  /** Segment endpoint pairs, anchor-relative, xyz per vertex. */
  readonly vertices: Float32Array;
  /** Per vertex: 0 when the lines are spaced along u, 1 along v. */
  readonly across: Uint8Array;
  /** Distance between neighbouring lines of this set, source units. */
  readonly spacing: number;
}

export interface WorkplaneGeometry {
  /** Scene-frame position of the anchor, Float64. Becomes the object position. */
  readonly anchorScene: Vec3;
  /** Source coordinate of the anchor, Float64. */
  readonly anchorSource: Vec3;
  readonly major: WorkplaneLineSet;
  readonly minor: WorkplaneLineSet;
  /** The two axis lines through the origin and the origin marker. */
  readonly axes: WorkplaneLineSet;
  /** The patch, anchor-relative plane coordinates `[sLo, sHi, tLo, tHi]`. */
  readonly rect: readonly [number, number, number, number];
  /** Whether the user's origin lies inside the patch. */
  readonly originInView: boolean;
}

/** Accumulates segments given in anchor-relative plane coordinates. */
class SetBuilder {
  private readonly pos: number[] = [];
  private readonly acr: number[] = [];
  private readonly plane: WorkplaneBasis;
  readonly spacing: number;
  constructor(plane: WorkplaneBasis, spacing: number) {
    this.plane = plane;
    this.spacing = spacing;
  }

  /** A straight line from (s0,t0) to (s1,t1), split into `n` segments. */
  line(s0: number, t0: number, s1: number, t1: number, n: number, across: 0 | 1): void {
    const { u, v } = this.plane;
    for (let k = 0; k < n; k++) {
      for (const f of [k / n, (k + 1) / n]) {
        const s = s0 + (s1 - s0) * f;
        const t = t0 + (t1 - t0) * f;
        this.pos.push(u[0] * s + v[0] * t, u[1] * s + v[1] * t, u[2] * s + v[2] * t);
        this.acr.push(across);
      }
    }
  }

  build(): WorkplaneLineSet {
    // The Float32Array constructor is the single narrowing of each coordinate.
    return { vertices: new Float32Array(this.pos), across: new Uint8Array(this.acr), spacing: this.spacing };
  }
}

/** Build the grid buffers for a patch. */
export function buildWorkplaneGeometry(input: WorkplaneGeometryInput): WorkplaneGeometry {
  const { plane, major, minor } = input;
  // An unsafe patch is never iterated: it draws nothing.
  const patch = patchIsSafe(input.patch) ? input.patch : { iMin: 1, iMax: 0, jMin: 1, jMax: 0 };
  // The anchor is the lattice crossing nearest the patch centre.
  const ia = Math.round((patch.iMin + patch.iMax) / 2);
  const ja = Math.round((patch.jMin + patch.jMax) / 2);
  const anchorSource = add(plane.origin, add(scale(plane.u, ia * major), scale(plane.v, ja * major)));
  const anchorScene = sub(anchorSource, input.sceneOrigin);
  const sLo = (patch.iMin - ia) * major;
  const sHi = (patch.iMax - ia) * major;
  const tLo = (patch.jMin - ja) * major;
  const tHi = (patch.jMax - ja) * major;
  const segs = (span: number): number => Math.max(1, Math.min(MAX_SEGMENTS_PER_LINE, Math.round(span / major)));
  const nAlongV = segs(tHi - tLo);
  const nAlongU = segs(sHi - sLo);

  // Lines of constant s run along v and are spaced along u (across = 0).
  const majorSet = new SetBuilder(plane, major);
  for (let i = patch.iMin; i <= patch.iMax; i++) {
    if (i !== 0) majorSet.line((i - ia) * major, tLo, (i - ia) * major, tHi, nAlongV, 0);
  }
  for (let j = patch.jMin; j <= patch.jMax; j++) {
    if (j !== 0) majorSet.line(sLo, (j - ja) * major, sHi, (j - ja) * major, nAlongU, 1);
  }

  const minorSet = new SetBuilder(plane, minor);
  const ratio = minor > 0 && minor < major ? Math.round(major / minor) : 0;
  const r = ratio <= MAX_MINOR_RATIO ? ratio : 0;
  const minorCount = r * Math.max(patch.iMax - patch.iMin, patch.jMax - patch.jMin);
  // Minor lines are faint and fade first, so half the segments carry their fade:
  // they are most of the vertices, and this halves the per-move fade cost.
  const minorAlongV = Math.max(1, Math.ceil(nAlongV / 2));
  const minorAlongU = Math.max(1, Math.ceil(nAlongU / 2));
  if (input.showMinor && r > 1 && minorCount <= MAX_MINOR_LINES) {
    for (let m = patch.iMin * r; m <= patch.iMax * r; m++) {
      if (m % r !== 0) minorSet.line((m / r - ia) * major, tLo, (m / r - ia) * major, tHi, minorAlongV, 0);
    }
    for (let m = patch.jMin * r; m <= patch.jMax * r; m++) {
      if (m % r !== 0) minorSet.line(sLo, (m / r - ja) * major, sHi, (m / r - ja) * major, minorAlongU, 1);
    }
  }

  // Axis lines through the origin, inside the patch, and the origin marker.
  const axesSet = new SetBuilder(plane, major);
  const oS = -ia * major;
  const oT = -ja * major;
  const inS = oS >= sLo && oS <= sHi;
  const inT = oT >= tLo && oT <= tHi;
  if (inS) axesSet.line(oS, tLo, oS, tHi, nAlongV, 0);
  if (inT) axesSet.line(sLo, oT, sHi, oT, nAlongU, 1);
  const originInView = inS && inT;
  if (originInView) {
    const m = major * 0.3;
    axesSet.line(oS - m, oT, oS, oT + m, 1, 0);
    axesSet.line(oS, oT + m, oS + m, oT, 1, 0);
    axesSet.line(oS + m, oT, oS, oT - m, 1, 0);
    axesSet.line(oS, oT - m, oS - m, oT, 1, 0);
  }

  return {
    anchorScene,
    anchorSource,
    major: majorSet.build(),
    minor: minorSet.build(),
    axes: axesSet.build(),
    rect: [sLo, sHi, tLo, tHi],
    originInView,
  };
}

/** What the fade reads from the camera, in scene coordinates. */
export interface WorkplaneFadeCamera {
  readonly position: Vec3;
  /** Unit view direction. */
  readonly forward: Vec3;
  readonly orthographic: boolean;
  /** Vertical field of view, degrees. */
  readonly fovDeg: number;
  /** Camera to orbit target distance; the orthographic camera's scale. */
  readonly orbitDistance: number;
  /** Canvas height, CSS px. */
  readonly canvasCssHeight: number;
}

const smooth = (x: number): number => {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};

/**
 * Write the per-vertex alpha for one line set into `out` (one float per
 * vertex): 0 where neighbouring lines sit closer than {@link FADE_ZERO_PX} on
 * screen, 1 from {@link FADE_FULL_PX}, times the fade over the outer
 * {@link EDGE_FADE_SHARE} of the patch. Allocates nothing, so it can run on
 * every camera move; `out` is reused by the caller.
 */
export function writeFade(
  set: WorkplaneLineSet,
  geom: Pick<WorkplaneGeometry, 'anchorScene' | 'rect'>,
  plane: Pick<WorkplaneBasis, 'u' | 'v'>,
  cam: WorkplaneFadeCamera,
  out: Float32Array,
): void {
  const verts = set.vertices;
  const n = Math.min(out.length, verts.length / 3);
  // World units per CSS px per unit of depth.
  const k = (2 * Math.tan((cam.fovDeg * Math.PI) / 360)) / cam.canvasCssHeight;
  const [sLo, sHi, tLo, tHi] = geom.rect;
  const sMid = (sLo + sHi) / 2;
  const tMid = (tLo + tHi) / 2;
  const sHalf = Math.max((sHi - sLo) / 2, 1e-12);
  const tHalf = Math.max((tHi - tLo) / 2, 1e-12);
  const [ux, uy, uz] = plane.u;
  const [wx, wy, wz] = plane.v;
  const [fx, fy, fz] = cam.forward;
  const ax = geom.anchorScene[0] - cam.position[0];
  const ay = geom.anchorScene[1] - cam.position[1];
  const az = geom.anchorScene[2] - cam.position[2];
  const ortho = cam.orthographic;
  const fade = (FADE_FULL_PX - FADE_ZERO_PX) * k;
  for (let i = 0; i < n; i++) {
    const vx = verts[i * 3];
    const vy = verts[i * 3 + 1];
    const vz = verts[i * 3 + 2];
    let dx = fx;
    let dy = fy;
    let dz = fz;
    let depth = cam.orbitDistance;
    if (!ortho) {
      dx = ax + vx;
      dy = ay + vy;
      dz = az + vz;
      depth = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
      // Behind the camera nothing is seen.
      if (dx * fx + dy * fy + dz * fz <= 0) {
        out[i] = 0;
        continue;
      }
      dx /= depth;
      dy /= depth;
      dz /= depth;
    }
    const c = set.across[i] === 0 ? dx * ux + dy * uy + dz * uz : dx * wx + dy * wy + dz * wz;
    // Screen spacing in px, compared without a division per vertex.
    const spacingWorld = set.spacing * Math.sqrt(Math.max(0, 1 - c * c));
    const density = smooth((spacingWorld - FADE_ZERO_PX * k * depth) / (fade * depth));
    const s = vx * ux + vy * uy + vz * uz;
    const t = vx * wx + vy * wy + vz * wz;
    const edgeS = (1 - Math.abs(s - sMid) / sHalf) / EDGE_FADE_SHARE;
    const edgeT = (1 - Math.abs(t - tMid) / tHalf) / EDGE_FADE_SHARE;
    out[i] = density * smooth(edgeS < edgeT ? edgeS : edgeT);
  }
}

/** {@link writeFade} into a new array, for tests and one-off use. */
export function fadeAlphas(
  set: WorkplaneLineSet,
  geom: Pick<WorkplaneGeometry, 'anchorScene' | 'rect'>,
  plane: Pick<WorkplaneBasis, 'u' | 'v'>,
  cam: WorkplaneFadeCamera,
): Float32Array {
  const out = new Float32Array(set.vertices.length / 3);
  writeFade(set, geom, plane, cam, out);
  return out;
}

/** Plane coordinates of a source point relative to the plane origin. */
export function planeCoordsOf(p: Vec3, plane: WorkplaneBasis): [number, number] {
  const d = sub(p, plane.origin);
  return [dot(d, plane.u), dot(d, plane.v)];
}
