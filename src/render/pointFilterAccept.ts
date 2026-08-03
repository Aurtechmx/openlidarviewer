/**
 * pointFilterAccept.ts
 *
 * A pure per-point visibility predicate that mirrors, on the CPU, exactly what
 * the GPU size-node folds do on screen (see `Viewer._applySizeMode` and the
 * `_elevMaskMultiplier` / `_classMaskMultiplier` / `_intenMaskMultiplier`
 * nodes). Interaction paths — picking, measuring, snapping, probing,
 * annotating, focus — use this so "you can't select a point you can't see":
 * a point hidden by the class, elevation, or intensity filter is rejected as a
 * hit candidate, keeping pick and render in lockstep point-for-point.
 *
 * Pure data in / function out: no three.js, no DOM, unit-tested in Node.
 */

import { classVisibleAt } from './class/classMaskUniform';
import { elevWindowFor } from './elevationWindowResolver';
import type { UpAxis } from './elevationFilterUniform';

/**
 * A snapshot of the active filter windows, in the SAME spaces the GPU uniforms
 * use, so the CPU test matches the shader bit-for-bit:
 *   - `elevMin`/`elevMax` are in ATTRIBUTE space (origin-shifted along the up
 *     axis), the same space the mesh's local `positions` live in;
 *   - `intenMin`/`intenMax` are raw intensity units (no shift);
 *   - `classMask` is the shared 256-entry visibility mask.
 * Each channel is applied only when its `*Active` flag is set (mirroring the
 * gated folds), and only when the buffer actually carries that attribute.
 */
export interface PointFilterWindow {
  classActive: boolean;
  classMask: ArrayLike<number> | null;
  elevActive: boolean;
  /** Index into an interleaved xyz triple for the up axis: 2 = Z-up, 1 = Y-up. */
  elevAxisIdx: 1 | 2;
  elevMin: number;
  elevMax: number;
  intenActive: boolean;
  intenMin: number;
  intenMax: number;
}

/**
 * Build a `(index) => boolean` accept predicate for one point buffer, or
 * `undefined` when no filter applies to it (the all-visible hot path — callers
 * then pass no predicate and the search runs exactly as it did pre-feature).
 *
 * A channel contributes a test only when it is BOTH active AND backed by the
 * needed data (class needs `classMask` + `classification`; intensity needs
 * `intensity`; elevation always has positions). Windows are inclusive on both
 * ends, matching the shader's `step(min,x) * step(x,max)` fold.
 */
export function buildPointFilterAccept(
  positions: ArrayLike<number>,
  classification: ArrayLike<number> | null | undefined,
  intensity: ArrayLike<number> | null | undefined,
  w: PointFilterWindow,
): ((index: number) => boolean) | undefined {
  const useClass = w.classActive && w.classMask != null && classification != null;
  const useElev = w.elevActive;
  const useInten = w.intenActive && intensity != null;
  if (!useClass && !useElev && !useInten) return undefined;

  const mask = w.classMask;
  const axis = w.elevAxisIdx;
  return (index: number): boolean => {
    if (useClass && !classVisibleAt(mask as ArrayLike<number>, classification![index])) {
      return false;
    }
    if (useElev) {
      const e = positions[index * 3 + axis];
      if (e < w.elevMin || e > w.elevMax) return false;
    }
    if (useInten) {
      const v = intensity![index];
      if (v < w.intenMin || v > w.intenMax) return false;
    }
    return true;
  };
}

/** The elevation portion of a {@link PointFilterWindow}, in one cloud's attribute space. */
export interface ElevWindowFields {
  /** Index into an interleaved xyz triple for the up axis: 2 = Z-up, 1 = Y-up. */
  readonly elevAxisIdx: 1 | 2;
  readonly elevMin: number;
  readonly elevMax: number;
}

/**
 * Convert a world-space elevation window into ONE cloud's attribute space using
 * THAT cloud's origin and up-axis — the exact per-cloud conversion the GPU takes
 * (`elevationWindowResolver.elevWindowFor`), so a CPU pick / lasso edit and the
 * shader clip the same true height on EVERY layer, not just the primary one.
 * Positions are stored origin-shifted, so a window converted with cloud A's
 * origin tests cloud B (recentred elsewhere) at the wrong height — this is the
 * seam that stops that. Reuses the resolver; it never forks a second convention.
 * Off (`world === undefined`) still returns finite bounds (never consulted, since
 * the caller gates on `elevActive`), matching the resolver and the shader.
 */
export function elevWindowFieldsFor(
  world: readonly [number, number] | undefined,
  originAlongAxis: number,
  axis: UpAxis,
): ElevWindowFields {
  const w = elevWindowFor(world, originAlongAxis, axis);
  return { elevAxisIdx: w.axisIsZ === 1 ? 2 : 1, elevMin: w.min, elevMax: w.max };
}
