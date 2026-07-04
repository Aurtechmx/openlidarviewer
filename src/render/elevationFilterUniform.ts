/**
 * elevationFilterUniform.ts
 *
 * Pure maths for the GPU elevation filter (v0.5.6 — the first of the staged
 * point-filter cores wired to the live path). Mirrors `classMaskUniform.ts`:
 * this module owns the CPU-side policy, the Viewer render loop owns the stateful
 * "upload it" side (holding the uniform node and multiplying `sizeNode`, exactly
 * as the class mask does).
 *
 * Coordinate model: the viewer stores each cloud's points in an origin-shifted
 * local space (a large origin is subtracted so the float attribute keeps
 * precision). A user picks an elevation window in world/source units; the shader
 * compares against the instanced position attribute, which is in attribute
 * space. So the window is converted once, on the CPU, by subtracting the same
 * origin shift along the up-axis: `attr = world - originShift`.
 *
 * The up-axis is per-cloud: LAS/LAZ/E57 surveys are Z-up (component 2); phone
 * scans are Y-up (component 1). The uniform carries which component to read so
 * one shader graph serves both.
 *
 * Pure — no DOM, no three.js — fully unit-tested in Node.
 */

import { normalizeRange } from './pointFilter';

/** Which position component carries elevation: 1 = y (Y-up), 2 = z (Z-up). */
export type UpAxis = 1 | 2;

/**
 * The shader-facing elevation-filter payload. `enabled` gates the whole test so
 * the disabled state is a cheap identity (multiply by 1); `min`/`max` are the
 * inclusive window in ATTRIBUTE space (origin-shifted, matching the instanced
 * position attribute the shader reads).
 */
export interface ElevationFilterUniform {
  /** 1 = filter active; 0 = pass every point (identity). */
  readonly enabled: 0 | 1;
  /** Position component to read as elevation (1 = y, 2 = z). */
  readonly axis: UpAxis;
  /** Inclusive lower bound, attribute space. Meaningless when `enabled` is 0. */
  readonly min: number;
  /** Inclusive upper bound, attribute space. Meaningless when `enabled` is 0. */
  readonly max: number;
}

/** The identity payload — passes every point. `min`/`max` are 0 (never read). */
export const ELEVATION_FILTER_OFF: Readonly<ElevationFilterUniform> = Object.freeze({
  enabled: 0,
  axis: 2,
  min: 0,
  max: 0,
});

/**
 * Build the shader uniform from a world-space elevation window.
 *
 * @param range        Inclusive `[min, max]` in world/source units, or `undefined`.
 * @param axis         The cloud's up-axis (1 = Y-up, 2 = Z-up).
 * @param originShift  The value subtracted from source coordinates along the
 *                     up-axis when the instanced positions were built.
 * @returns The identity payload (`enabled: 0`) when the range is absent or
 *          unusable; otherwise the active window converted to attribute space.
 */
export function elevationFilterUniform(
  range: readonly [number, number] | undefined,
  axis: UpAxis,
  originShift: number,
): ElevationFilterUniform {
  const norm = normalizeRange(range);
  if (norm === null) return { enabled: 0, axis, min: 0, max: 0 };
  const shift = Number.isFinite(originShift) ? originShift : 0;
  return { enabled: 1, axis, min: norm[0] - shift, max: norm[1] - shift };
}

/**
 * CPU mirror of the shader test: does a point at `attrElevation` (attribute
 * space) survive the filter? Inclusive at both ends, and disabled passes
 * everything — the exact contract the `sizeNode` multiply implements on the GPU,
 * so a unit test can pin parity without a device.
 */
export function elevationPasses(u: ElevationFilterUniform, attrElevation: number): boolean {
  if (u.enabled !== 1) return true;
  if (!Number.isFinite(attrElevation)) return false;
  return attrElevation >= u.min && attrElevation <= u.max;
}
