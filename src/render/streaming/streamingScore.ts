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

/** Inputs for a node's streaming priority score. */
export interface NodeScoreInput {
  bounds: Box6;
  depth: number;
  cameraPos: readonly [number, number, number];
  /** The maximum depth to load this tick — deeper nodes score 0. */
  depthCap: number;
}

/**
 * A node's streaming priority — higher loads sooner. A shallower node always
 * outranks a deeper one (the depth term dwarfs the size term); within a depth,
 * the larger projected size wins. A node past the depth cap scores 0.
 */
export function nodeScore(input: NodeScoreInput): number {
  if (input.depth > input.depthCap) return 0;
  const ps = projectedSize(input.bounds, input.cameraPos);
  const sizeTerm = Math.min(Math.round(ps * 1000), 999);
  return (input.depthCap - input.depth + 1) * 1000 + sizeTerm;
}

/**
 * The octree depth the scheduler descends to this tick. A fast-moving camera
 * gets a shallower cap, so streaming chases the broad view rather than fine
 * detail that will be stale by the next frame.
 */
export function depthCapForVelocity(baseCap: number, velocity: number): number {
  if (velocity > 50) return Math.max(2, baseCap - 6);
  if (velocity > 10) return Math.max(3, baseCap - 3);
  return baseCap;
}
