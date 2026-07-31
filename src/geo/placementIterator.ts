/**
 * placementIterator.ts
 *
 * ONE placement-aware way to walk a layer's points.
 *
 * Today every combined estimator concatenates raw source-local buffers and
 * hands them to a pure sampler: the profile walk, the cut/fill volume walk and
 * the terrain/DTM gather all push `cloud.positions` verbatim and copy them into
 * a single array (`src/render/Viewer.ts` — the profile sampler, the volume
 * sampler, and the terrain gather). None of them folds the layer's Float64
 * placement, so the moment more than one layer is genuinely mounted those
 * estimators average points that are not in the same frame. The mount is off
 * today, so the defect is latent rather than shipped — but "latent" is a
 * property of a flag, not of the code, and enabling the mount without this is
 * exactly how it stops being latent.
 *
 * `src/render/layerPlacement.ts` already folds the placement at the boundaries
 * that were wired: bounds, picking, ray origins. It deliberately stops short of
 * the per-point loop, offering only `accumulatorOffset` — the three scalars a
 * caller is trusted to add itself. This module is the loop each of those
 * callers would otherwise write again, with the two things a hand-written loop
 * keeps getting wrong: applying the offset exactly once, and being honest about
 * points it could not use.
 *
 * The placement is modelled EXACTLY as `LayerSpatialTransform` models it in
 * v0.6 — a pure Float64 translation. There is no rotation and no up-axis swap
 * in the placement, and none is invented here: the scene's up-axis
 * normalisation is a separate, later step over the assembled buffer (see the
 * `yUpToCanonicalZUp` call in the terrain gather), not a property a layer
 * carries. When reprojection lands and the transform becomes a Matrix4, this
 * signature is the one place the change has to be made.
 *
 * Allocation: the iteration reuses a SINGLE mutable out-object across every
 * point, because estimators run this over millions of points and a per-point
 * allocation is the difference between a walk and a pause. The consequence is
 * stated plainly in {@link PlacedPoint}: a caller that keeps the object keeps a
 * cursor, not a point.
 *
 * Pure — no DOM, no three.js, no renderer — Node-testable like the frame maths
 * it composes with.
 */

import type { LayerSpatialTransform } from './ProjectSpatialFrame';

/**
 * The part of a layer's placement a point walk actually needs.
 *
 * A structural subset of {@link LayerSpatialTransform}, so a real transform can
 * be passed straight in. Deliberately narrow: an estimator that walks points
 * has no business with the inverse or with the layer's source origin, and a
 * type that demanded them would push callers into inventing values.
 */
export type LayerPlacement = Pick<LayerSpatialTransform, 'sourceToProject'>;

/**
 * A point in the shared project frame.
 *
 * REUSED between iterations. The same object is handed to every callback and
 * yielded from every step, with its fields overwritten in place. Read what you
 * need, or copy it — storing the reference stores the cursor, and after the
 * walk every stored "point" is the last one.
 */
export interface PlacedPoint {
  /** Point index into the source buffer (the triplet index, not the element). */
  index: number;
  /** Project-frame X — source X plus the placement's X translation. */
  x: number;
  /** Project-frame Y. */
  y: number;
  /** Project-frame Z. */
  z: number;
}

/**
 * What a walk actually did.
 *
 * `skipped` exists so a caller can say "1 284 points were not finite and were
 * left out" instead of quietly averaging garbage, or quietly averaging nothing.
 * An estimator that reports a figure over `visited` without mentioning
 * `skipped` is reporting a figure about a cloud it did not read.
 */
export interface PlacementTally {
  /** Points the walk considered — `pointCount`, or the buffer's full triplet count. */
  readonly total: number;
  /** Points delivered to the caller (finite, placed). */
  readonly visited: number;
  /** Points dropped because X, Y or Z was NaN or infinite. */
  readonly skipped: number;
}

/** Interleaved XYZ, length 3·N. Read-only — a walk never writes to the source. */
export type XyzPointBuffer = Readonly<Float32Array> | Readonly<Float64Array>;

/** Options shared by both iteration forms. */
export interface PlacementIterationOptions {
  /**
   * How many points to walk, when the buffer is over-allocated relative to the
   * cloud's real point count. Defaults to `floor(points.length / 3)`. A
   * trailing partial triplet is never read.
   */
  readonly pointCount?: number;
}

/** The identity translation — shared, never mutated, never handed out. */
const IDENTITY_OFFSET: readonly [number, number, number] = [0, 0, 0];

/**
 * The validated translation for a placement. `null`/`undefined` reads as the
 * identity, matching how the rest of the codebase spells "this layer carries no
 * placement" (`isIdentityPlacement` in src/render/layerPlacement.ts).
 *
 * A non-finite translation throws rather than propagating: an offset of NaN
 * turns every point it touches into NaN, and the failure would surface as an
 * estimator that quietly skipped an entire layer as "not finite". The argument
 * is named in the message because the caller's next question is which of the
 * two arrays it passed was poison.
 */
function placementOffset(
  placement: LayerPlacement | null | undefined,
  argName: string,
): readonly [number, number, number] {
  if (!placement) return IDENTITY_OFFSET;
  const d = placement.sourceToProject;
  if (!Number.isFinite(d[0]) || !Number.isFinite(d[1]) || !Number.isFinite(d[2])) {
    throw new TypeError(
      `${argName}.sourceToProject must be three finite numbers — got ` +
        `[${String(d[0])}, ${String(d[1])}, ${String(d[2])}].`,
    );
  }
  return [d[0], d[1], d[2]];
}

/** How many points to walk: the requested count, clamped to what exists. */
function resolvePointCount(
  available: number,
  requested: number | undefined,
  argName: string,
): number {
  if (requested === undefined) return available;
  if (!Number.isFinite(requested) || requested < 0) {
    throw new TypeError(
      `${argName} must be a finite, non-negative point count — got ${String(requested)}.`,
    );
  }
  return Math.min(available, Math.floor(requested));
}

/**
 * Walk `points` in the project frame, calling `visit` for each finite point.
 *
 * This is the form estimators should use: it allocates one out-object for the
 * whole walk and returns the tally, so the caller can disclose skipped points
 * rather than discover them as a wrong number.
 *
 * The placement is applied EXACTLY ONCE, here. A caller that also adds
 * `accumulatorOffset(placement)` afterwards has placed the layer twice — the
 * same shape of defect the inspector's world-coordinate row carries today,
 * where a project-frame point is lifted to world by the layer's own source
 * origin instead of the project origin.
 */
export function forEachPlacedPoint(
  points: XyzPointBuffer,
  placement: LayerPlacement | null | undefined,
  visit: (point: Readonly<PlacedPoint>) => void,
  options: PlacementIterationOptions = {},
): PlacementTally {
  const offset = placementOffset(placement, 'placement');
  const dx = offset[0];
  const dy = offset[1];
  const dz = offset[2];
  const total = resolvePointCount(
    Math.floor(points.length / 3),
    options.pointCount,
    'options.pointCount',
  );
  const out: PlacedPoint = { index: 0, x: 0, y: 0, z: 0 };
  let visited = 0;
  let skipped = 0;
  for (let i = 0; i < total; i++) {
    const b = i * 3;
    const x = points[b];
    const y = points[b + 1];
    const z = points[b + 2];
    // One non-finite component poisons the whole point: a NaN Z with a good
    // X/Y is not a point at a known place, it is a point at an unknown height.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      skipped++;
      continue;
    }
    out.index = i;
    out.x = x + dx;
    out.y = y + dy;
    out.z = z + dz;
    visited++;
    visit(out);
  }
  return { total, visited, skipped };
}

/**
 * The same walk as a generator, for callers that read better as `for…of`.
 *
 * The tally is the generator's RETURN value, which `for…of` discards by
 * language rule — so a caller that needs `skipped` should either drive the
 * generator by hand (`const step = it.next(); … step.value` once `done`) or use
 * {@link forEachPlacedPoint}. That limitation is why the callback form, not
 * this one, is the primitive.
 *
 * Written out rather than layered over `forEachPlacedPoint` on purpose: driving
 * a generator allocates an iterator-result object per step, which is precisely
 * the per-point allocation this module exists to avoid on a ten-million-point
 * cloud. Two short loops that must agree, rather than one that must be slow.
 */
export function* iteratePlacedPoints(
  points: XyzPointBuffer,
  placement: LayerPlacement | null | undefined,
  options: PlacementIterationOptions = {},
): Generator<Readonly<PlacedPoint>, PlacementTally, undefined> {
  const offset = placementOffset(placement, 'placement');
  const dx = offset[0];
  const dy = offset[1];
  const dz = offset[2];
  const total = resolvePointCount(
    Math.floor(points.length / 3),
    options.pointCount,
    'options.pointCount',
  );
  const out: PlacedPoint = { index: 0, x: 0, y: 0, z: 0 };
  let visited = 0;
  let skipped = 0;
  for (let i = 0; i < total; i++) {
    const b = i * 3;
    const x = points[b];
    const y = points[b + 1];
    const z = points[b + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      skipped++;
      continue;
    }
    out.index = i;
    out.x = x + dx;
    out.y = y + dy;
    out.z = z + dz;
    visited++;
    yield out;
  }
  return { total, visited, skipped };
}
