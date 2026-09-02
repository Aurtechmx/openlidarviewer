/**
 * streamingScore.ts
 *
 * The pure view-dependent maths behind the streaming scheduler: extracting
 * frustum planes from a view-projection matrix, box/frustum culling, projected
 * size, and a node's priority score.
 *
 * Coarse-first by construction: a shallower node always outranks a deeper one,
 * and within a depth the larger on-screen node wins. A node deeper than the
 * tick's depth cap scores 0 — never loaded this tick.
 *
 * Pure — no DOM, no three.js — fully unit-tested in Node.
 */

import { centerWeight } from '../refinementPhase';
import type { Box6 } from '../../io/copc/copcTypes';

/** A plane `[a, b, c, d]`; a point is inside when `a·x + b·y + c·z + d ≥ 0`. */
export type Plane = readonly [number, number, number, number];
/** A view frustum as its six bounding planes. */
export type FrustumPlanes = readonly Plane[];

/**
 * Extract the six frustum planes from a column-major view-projection matrix
 * (e.g. three.js `Matrix4.elements`), via the Gribb–Hartmann method. The
 * planes are not normalised — only the sign matters for inside/outside tests.
 */
export function frustumPlanesFromViewProjection(m: ArrayLike<number>): FrustumPlanes {
  // Row i of a column-major 4×4 is [m[i], m[i+4], m[i+8], m[i+12]].
  const row = (i: number): Plane => [m[i], m[i + 4], m[i + 8], m[i + 12]];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);
  const add = (a: Plane, b: Plane): Plane => [
    a[0] + b[0],
    a[1] + b[1],
    a[2] + b[2],
    a[3] + b[3],
  ];
  const sub = (a: Plane, b: Plane): Plane => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
    a[3] - b[3],
  ];
  return [
    add(r3, r0), // left
    sub(r3, r0), // right
    add(r3, r1), // bottom
    sub(r3, r1), // top
    add(r3, r2), // near
    sub(r3, r2), // far
  ];
}

/**
 * Whether an axis-aligned box is at least partially inside the frustum. Uses
 * the p-vertex test — the box corner farthest along each plane normal.
 */
export function boxInFrustum(box: Box6, planes: FrustumPlanes): boolean {
  for (const [a, b, c, d] of planes) {
    const px = a >= 0 ? box[3] : box[0];
    const py = b >= 0 ? box[4] : box[1];
    const pz = c >= 0 ? box[5] : box[2];
    if (a * px + b * py + c * pz + d < 0) return false; // wholly outside
  }
  return true;
}

/** Distance from a camera position to a box's centre. */
export function distanceToBox(box: Box6, cam: readonly [number, number, number]): number {
  const dx = (box[0] + box[3]) / 2 - cam[0];
  const dy = (box[1] + box[4]) / 2 - cam[1];
  const dz = (box[2] + box[5]) / 2 - cam[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A box's diagonal length — a proxy for its world size. */
export function boxDiagonal(box: Box6): number {
  const dx = box[3] - box[0];
  const dy = box[4] - box[1];
  const dz = box[5] - box[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Rough on-screen size of a box — its world size over its distance. */
export function projectedSize(box: Box6, cam: readonly [number, number, number]): number {
  return boxDiagonal(box) / Math.max(distanceToBox(box, cam), 1e-3);
}

/**
 * How close a box lands to the centre of the view, in `[0, 1]` — 1 when the
 * box covers the centre, falling to 0 at the viewport edge.
 *
 * The 8 local-space AABB corners are projected through the column-major
 * view-projection; the NDC axis-aligned rectangle of the VALID corners is then
 * reduced to the point nearest the origin, which is what `centerWeight` scores.
 * Taking the nearest point of the RECTANGLE rather than the box's projected
 * centre is what makes a large node crossing the middle of the screen rank as
 * central even when its geometric centre is off to one side.
 *
 * Fails conservatively: a box straddling the camera plane, a non-finite matrix,
 * a short matrix, or a degenerate viewport all return 1 — the neutral maximum.
 * Near-camera geometry is exactly the case that produces a negative clip `w`,
 * so a "no opinion" answer here must never be the low-priority one.
 */
export function projectedBoxCenterWeight(
  box: Box6,
  viewProjection: ArrayLike<number>,
  widthPx: number,
  heightPx: number,
): number {
  const m = viewProjection;
  if (m.length < 16) return 1;
  if (
    !Number.isFinite(widthPx) ||
    !Number.isFinite(heightPx) ||
    widthPx <= 0 ||
    heightPx <= 0
  ) {
    return 1;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let c = 0; c < 8; c++) {
    const x = box[c & 1 ? 3 : 0];
    const y = box[c & 2 ? 4 : 1];
    const z = box[c & 4 ? 5 : 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    // A corner at or behind the camera plane makes the divide meaningless —
    // and a box with any such corner is close enough to matter, so give up and
    // return the neutral maximum rather than a half-projected rectangle.
    if (!(w > 1e-9) || !Number.isFinite(w)) return 1;
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return 1;
    if (nx < minX) minX = nx;
    if (nx > maxX) maxX = nx;
    if (ny < minY) minY = ny;
    if (ny > maxY) maxY = ny;
  }
  // Nearest point of the NDC rectangle to the screen centre.
  const px = Math.min(Math.max(0, minX), maxX);
  const py = Math.min(Math.max(0, minY), maxY);
  const aspect = widthPx / heightPx;
  if (!Number.isFinite(aspect) || aspect <= 0) return 1;
  const aspectWx = aspect >= 1 ? aspect : 1;
  const aspectWy = aspect >= 1 ? 1 : 1 / aspect;
  return centerWeight(px, py, aspectWx, aspectWy);
}

/** Inputs for a node's streaming priority score. */
export interface NodeScoreInput {
  bounds: Box6;
  depth: number;
  cameraPos: readonly [number, number, number];
  /** The maximum depth to load this tick — deeper nodes score 0. */
  depthCap: number;
  /**
   * Centre-bias strength in `[0, 1)` — see `PHASE_FOCUS_STRENGTH`. Omitted or
   * 0 (every phase but `center-refine`, and every caller that predates the
   * phase wiring) scores exactly as before.
   */
  focusStrength?: number;
  /** Column-major view-projection, required for the centre weighting. */
  viewProjection?: ArrayLike<number>;
  /** Viewport size in CSS pixels — only the aspect is used. */
  viewportWidthPx?: number;
  viewportHeightPx?: number;
}

/**
 * Weight per level of depth in the priority score. The shallower a node, the
 * larger `(depthCap - depth + 1) * DEPTH_WEIGHT` becomes — this is the
 * dominant term. Treated as a positional-notation base: depth occupies the
 * upper digit slot, the size sub-score fills the lower one.
 */
export const DEPTH_WEIGHT = 1000;

/**
 * Exclusive upper bound on the size sub-score. By construction equal to
 * `DEPTH_WEIGHT - 1`, so two nodes a level apart can never tie: the strictly
 * shallower node beats the strictly deeper one regardless of how much bigger
 * the deeper one projects. This is what keeps the scheduler coarse-first.
 */
export const SIZE_TERM_MAX = DEPTH_WEIGHT - 1;

/**
 * Multiplier that turns a unitless projected-size ratio into an integer
 * bucket in `[0, SIZE_TERM_MAX]`. A projected size near 1 (node fills the
 * viewport) saturates; tiny far-away nodes get a small bucket. The scale is
 * numerically equal to `DEPTH_WEIGHT` here but is conceptually independent —
 * it sets how finely projected-size differences are resolved within a depth.
 */
export const SIZE_TERM_SCALE = 1000;

/**
 * The projected size after the phase's centre bias. Any missing or unusable
 * input (no strength, no matrix, no viewport) returns the raw size, so the
 * legacy scoring path is bit-identical.
 */
function focusedProjectedSize(ps: number, input: NodeScoreInput): number {
  const strength = input.focusStrength;
  if (typeof strength !== 'number' || !(strength > 0) || !input.viewProjection) return ps;
  const cw = projectedBoxCenterWeight(
    input.bounds,
    input.viewProjection,
    input.viewportWidthPx ?? Number.NaN,
    input.viewportHeightPx ?? Number.NaN,
  );
  const factor = 1 - Math.min(strength, 1) * (1 - cw);
  if (!Number.isFinite(factor) || factor <= 0) return ps;
  return ps * factor;
}

/**
 * A node's streaming priority — higher loads sooner.
 *
 * The score is `depthContribution + sizeTerm`, where:
 *   • `depthContribution = (depthCap - depth + 1) * DEPTH_WEIGHT` and
 *   • `sizeTerm        ∈ [0, SIZE_TERM_MAX]`.
 *
 * Because `SIZE_TERM_MAX < DEPTH_WEIGHT`, the depth contribution strictly
 * dominates: a shallower node always outranks a deeper one (coarse-first).
 * Within a depth, the larger projected size wins. A node past `depthCap`
 * scores 0 — it is not a candidate this tick.
 */
export function nodeScore(input: NodeScoreInput): number {
  if (input.depth > input.depthCap) return 0;
  const ps = projectedSize(input.bounds, input.cameraPos);
  // A degenerate / zero-extent / non-finite node box makes `ps` NaN; `NaN <= 0`
  // is false, so a `score > 0` budget selector would admit the garbage node.
  // Reject it explicitly.
  if (!Number.isFinite(ps)) return 0;
  // Focus-aware ordering WITHIN a level. `focusFactor ∈ (0, 1]` because
  // `focusStrength ∈ [0, 1)` and `centerWeight ∈ [0, 1]`, so the focused
  // projected size is never larger than the raw one and never negative — the
  // size term stays inside `[0, SIZE_TERM_MAX]` and coarse-first is untouched.
  const focused = focusedProjectedSize(ps, input);
  const sizeTerm = Math.min(Math.round(focused * SIZE_TERM_SCALE), SIZE_TERM_MAX);
  const depthContribution =
    (input.depthCap - input.depth + 1) * DEPTH_WEIGHT;
  return depthContribution + sizeTerm;
}

/**
 * Velocity (world units/second) above which the scheduler treats the camera
 * as "moving" and lowers the depth cap by `MODERATE_DEPTH_REDUCTION` levels.
 * Pairs with `VELOCITY_FAST_THRESHOLD` in the scheduler, which uses the same
 * number to halve the concurrent-decode budget — separate constants so the
 * size/concurrency dimensions can be re-tuned independently.
 */
const VELOCITY_MODERATE_THRESHOLD = 10;
/** Velocity above which the scheduler treats the camera as "flying". */
const VELOCITY_VERY_FAST_THRESHOLD = 50;
/** Levels to subtract from `baseCap` at moderate motion. */
const MODERATE_DEPTH_REDUCTION = 3;
/** Levels to subtract from `baseCap` at very-fast motion. */
const VERY_FAST_DEPTH_REDUCTION = 6;
/** The floor for the reduced cap so the root-ish levels still load. */
const MODERATE_MIN_CAP = 3;
const VERY_FAST_MIN_CAP = 2;

/**
 * The octree depth the scheduler descends to this tick. A fast-moving camera
 * gets a shallower cap, so streaming chases the broad view rather than fine
 * detail that will be stale by the next frame.
 */
export function depthCapForVelocity(baseCap: number, velocity: number): number {
  if (velocity > VELOCITY_VERY_FAST_THRESHOLD) {
    return Math.max(VERY_FAST_MIN_CAP, baseCap - VERY_FAST_DEPTH_REDUCTION);
  }
  if (velocity > VELOCITY_MODERATE_THRESHOLD) {
    return Math.max(MODERATE_MIN_CAP, baseCap - MODERATE_DEPTH_REDUCTION);
  }
  return baseCap;
}
