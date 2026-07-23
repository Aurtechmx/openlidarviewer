/**
 * layerPlacement.ts — the fold operations for a layer's Float64 placement.
 *
 * Step 3 of the flip sequence (docs/architecture/float64-transform.md): the
 * cross-layer consumers — picking, terrain gather, lasso, profiles, volumes,
 * camera bounds — learn a layer's `sourceToProject` translation WITHOUT the
 * data ever moving. Each consumer folds the translation at its own boundary
 * using one of these helpers, so the fold is written once and the identity
 * case (a lone layer anchoring its own frame, and every layer while mounting
 * stays disabled) is checked once.
 *
 * Pure functions, no three.js, no DOM — Node-testable like the frame maths
 * they compose with.
 */
import type { LayerSpatialTransform } from '../geo/ProjectSpatialFrame';

type Vec3 = readonly [number, number, number];
export interface Aabb {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

/**
 * Whether a transform moves anything. `null`/`undefined` reads as identity so
 * call sites can hold "no placement yet" without a sentinel object.
 */
export function isIdentityPlacement(
  t: LayerSpatialTransform | null | undefined,
): boolean {
  return (
    !t ||
    (t.sourceToProject[0] === 0 &&
      t.sourceToProject[1] === 0 &&
      t.sourceToProject[2] === 0)
  );
}

/**
 * A layer's cached source-local AABB, placed into the project frame. The
 * identity returns the SAME object (no allocation, bit-identical) — that is
 * what makes wiring this into the bounds path a provable no-op today.
 */
export function placeAabb(aabb: Aabb, t: LayerSpatialTransform | null | undefined): Aabb {
  if (isIdentityPlacement(t)) return aabb;
  const d = t!.sourceToProject;
  return {
    min: [aabb.min[0] + d[0], aabb.min[1] + d[1], aabb.min[2] + d[2]],
    max: [aabb.max[0] + d[0], aabb.max[1] + d[1], aabb.max[2] + d[2]],
  };
}

/**
 * A project-frame ray expressed in a layer's source-local frame, so picking
 * can run over the raw positions unchanged: transform the RAY down, pick,
 * then lift the hit back with {@link placePoint}. Directions are unaffected
 * by a translation, so only the ray origin moves. Identity returns the same
 * origin object.
 */
export function rayOriginToLayer(
  rayOrigin: Vec3,
  t: LayerSpatialTransform | null | undefined,
): Vec3 {
  if (isIdentityPlacement(t)) return rayOrigin;
  const d = t!.projectToSource;
  return [rayOrigin[0] + d[0], rayOrigin[1] + d[1], rayOrigin[2] + d[2]];
}

/** A source-local point lifted into the project frame. Identity: same object. */
export function placePoint(
  p: Vec3,
  t: LayerSpatialTransform | null | undefined,
): Vec3 {
  if (isIdentityPlacement(t)) return p;
  const d = t!.sourceToProject;
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
}

/**
 * The per-layer offset a shared accumulator (terrain grid, lasso walk,
 * profile sampler, volume estimator) adds while iterating one layer's
 * points. Always a concrete tuple — hot loops read three scalars from it —
 * and [0,0,0] for the identity, so `x + off[0]` costs an add of zero rather
 * than a branch per point.
 */
const ZERO: Vec3 = [0, 0, 0];
export function accumulatorOffset(
  t: LayerSpatialTransform | null | undefined,
): Vec3 {
  return isIdentityPlacement(t) ? ZERO : t!.sourceToProject;
}
