/**
 * numeric.ts
 *
 * Tiny shared numeric helpers. `clamp` replaces the hand-written
 * `Math.max(lo, Math.min(hi, x))` (and its reversed twin) that appeared at
 * dozens of call sites — a form where it is easy to transpose the bounds or
 * drop one. One definition, unit-tested, so a clamp reads as a clamp.
 *
 * Pure — no DOM, no three.js.
 */

/**
 * Constrain `value` to the inclusive range `[min, max]`.
 *
 * `min` is applied last, so when `min > max` the result is `min` — the same
 * behaviour as the common `Math.max(min, Math.min(max, value))` idiom this
 * replaces. `NaN` propagates (matching `Math.min`/`Math.max`).
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Constrain `value` to the unit range `[0, 1]` — the most common clamp. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
