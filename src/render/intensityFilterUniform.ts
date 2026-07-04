/**
 * intensityFilterUniform.ts
 *
 * Pure maths for the GPU intensity filter (v0.5.6 — the second point-filter
 * core wired to the live path, after the elevation filter). Mirrors
 * `elevationFilterUniform.ts` but simpler: intensity is a raw per-point scalar
 * (the LAS Intensity field, an unsigned integer), so there is no up-axis and no
 * origin shift — the shader compares the `aIntensity` attribute directly against
 * the window. The module owns the CPU-side policy; the Viewer render loop owns
 * the stateful "upload it" side (holding the uniform node and multiplying
 * `sizeNode`, exactly as the class and elevation masks do).
 *
 * The window is in the SAME raw units the attribute carries (whatever the file
 * declared — typically 0–65535, though many sensors populate only the low byte),
 * so the Inspector seeds the control from the cloud's own intensity min/max.
 *
 * Pure — no DOM, no three.js — fully unit-tested in Node.
 */

import { normalizeRange } from './pointFilter';

/**
 * The shader-facing intensity-filter payload. `enabled` gates the whole test so
 * the disabled state is a cheap identity (multiply by 1); `min`/`max` are the
 * inclusive window in raw intensity units.
 */
export interface IntensityFilterUniform {
  /** 1 = filter active; 0 = pass every point (identity). */
  readonly enabled: 0 | 1;
  /** Inclusive lower bound, raw intensity units. Meaningless when `enabled` is 0. */
  readonly min: number;
  /** Inclusive upper bound, raw intensity units. Meaningless when `enabled` is 0. */
  readonly max: number;
}

/** The identity payload — passes every point. `min`/`max` are 0 (never read). */
export const INTENSITY_FILTER_OFF: Readonly<IntensityFilterUniform> = Object.freeze({
  enabled: 0,
  min: 0,
  max: 0,
});

/**
 * Build the shader uniform from an intensity window.
 *
 * @param range Inclusive `[min, max]` in raw intensity units, or `undefined`.
 * @returns The identity payload (`enabled: 0`) when the range is absent or
 *          unusable; otherwise the active window (order-independent).
 */
export function intensityFilterUniform(
  range: readonly [number, number] | undefined,
): IntensityFilterUniform {
  const norm = normalizeRange(range);
  if (norm === null) return { enabled: 0, min: 0, max: 0 };
  return { enabled: 1, min: norm[0], max: norm[1] };
}

/**
 * CPU mirror of the shader test: does a point of intensity `value` survive the
 * filter? Inclusive at both ends, and disabled passes everything — the exact
 * contract the `sizeNode` multiply implements on the GPU, so a unit test can pin
 * parity without a device.
 */
export function intensityPasses(u: IntensityFilterUniform, value: number): boolean {
  if (u.enabled !== 1) return true;
  if (!Number.isFinite(value)) return false;
  return value >= u.min && value <= u.max;
}
