/**
 * classMaskUniform.ts
 *
 * Pure mapping helpers that bridge the class-visibility state to the
 * GPU mask uniform. The actual uniform upload lives in the render
 * layer, but the array-build and per-code lookup logic live here so
 * they can be unit-tested without a GPU context — the shader does the
 * exact same `mask[code] === 1` test on its side.
 *
 * Pure data — no DOM, no three.js, no I/O.
 */

/** Anything that can hand back a 256-entry visibility mask. */
export interface MaskSource {
  toMaskArray(): Float32Array;
}

/** Returns the 256-entry mask array for the given visibility source. */
export function writeMask(v: MaskSource): Float32Array {
  return v.toMaskArray();
}

/**
 * Returns whether the class `code` is shown in `mask`, i.e.
 * `mask[code & 0xff] === 1`. Mirrors the per-point test the shader runs.
 *
 * Accepts any `ArrayLike<number>` so callers can pass either the built mask
 * (`Float32Array`) or the live backing array of the GPU uniform (`number[]`);
 * the `=== 1` test is identical for both.
 */
export function classVisibleAt(mask: ArrayLike<number>, code: number): boolean {
  return mask[code & 0xff] === 1;
}
