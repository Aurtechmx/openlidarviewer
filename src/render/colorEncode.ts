/**
 * colorEncode.ts
 *
 * The ONE sRGB → linear (EOTF) seam for point-colour uploads.
 *
 * Every colour source in the app (`colorForMode`, `streamingNodeColors`,
 * the loaders) produces sRGB-encoded Uint8 bytes, and every GPU colour
 * attribute is consumed as LINEAR light by the TSL pipeline (the attribute
 * is plumbed straight through `instancedBufferAttribute`, bypassing
 * three.js's automatic `vertexColors` sRGB → linear conversion, while
 * `outputColorSpace = SRGBColorSpace` re-encodes at output). So every
 * write into a Float32 colour attribute MUST pass through the piecewise
 * sRGB EOTF — a bare `u8 / 255` leaves the values display-referred, and
 * the renderer's output encode then applies sRGB a second time: washed-out,
 * brightened colours. v0.4.3 had exactly this seam bug in five recolour
 * paths (colour-mode switch, coverage grid, percentile trim,
 * classification refresh, streaming recolour) while the initial upload was
 * correct — switching colour modes visibly paled the cloud.
 *
 * This module is a leaf (no imports) so both `Viewer.ts` and the
 * lazy-chunked `StreamingRenderer.ts` can share it without creating a
 * Viewer ↔ streaming-chunk cycle.
 *
 * The piecewise sRGB EOTF (IEC 61966-2-1) is exact, not the 2.2-power
 * approximation — matches three.js's `Color.SRGBToLinear`, so PNG exports
 * stay in lock-step with the on-screen image.
 */

/**
 * Piecewise sRGB → linear EOTF for ONE normalised channel value in [0, 1].
 * Exported so scalar call sites (patchView's neighbourhood averaging, the
 * Inspector's colour-provenance card) share the exact curve instead of
 * carrying inline copies that could drift from the bulk path below.
 */
export function srgbToLinearScalar(v: number): number {
  // Piecewise sRGB → linear (matches three.js's Color.SRGBToLinear).
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * The 256 linear-light values an 8-bit sRGB channel can take, evaluated at
 * module load from {@link srgbToLinearScalar}. A byte has 256 possible
 * values, so `srgbToLinearScalar(b / 255)` has 256 possible results: this
 * table is the exact set of them, not an approximation of the curve. The
 * transfer function keeps its single definition above and the table is
 * generated from it, so the two cannot drift.
 *
 * Float64Array rather than Float32Array because the consumers are not all
 * Float32. `writeFloatColorsInto` stores into a Float32 attribute and would
 * round either way, but the Inspector's colour-provenance card formats the
 * linear value as a decimal string and patchView weights it into an average,
 * and float32 rounding is visible in both. A Float64Array element reads back
 * as the same double `srgbToLinearScalar` returns, so every consumer sees
 * the value it saw before the table existed.
 */
const SRGB_BYTE_TO_LINEAR: Float64Array = (() => {
  const table = new Float64Array(256);
  for (let b = 0; b < 256; b++) table[b] = srgbToLinearScalar(b / 255);
  return table;
})();

/**
 * Piecewise sRGB → linear EOTF for ONE 8-bit channel value [0, 255], by
 * table lookup. Equal to `srgbToLinearScalar(b / 255)` for every finite
 * input, bit for bit.
 *
 * Input handling: an integer in [0, 255] reads the precomputed entry. Any
 * other argument (non-integer, negative, above 255, NaN, Infinity) falls
 * through to `srgbToLinearScalar(b / 255)` rather than indexing past the
 * table, which would yield `undefined` and poison a Float32 write with NaN.
 * Out-of-range and fractional arguments therefore return exactly what they
 * returned before the table existed, NaN included.
 */
export function srgbByteToLinear(b: number): number {
  return b >= 0 && b <= 255 && Number.isInteger(b)
    ? SRGB_BYTE_TO_LINEAR[b]
    : srgbToLinearScalar(b / 255);
}

/**
 * Piecewise linear → sRGB OETF for ONE channel value in [0, 1] — the exact
 * inverse of {@link srgbToLinearScalar} (IEC 61966-2-1, matches three.js's
 * `Color.LinearToSRGB`). Input is clamped to [0, 1]. Exported so the encode
 * call sites (patchView's neighbourhood splat, the Inspector's colour-
 * provenance card) share the one curve instead of carrying byte-identical
 * inline copies that could drift from this seam.
 *
 * No lookup table in this direction: the argument is an arbitrary float (a
 * weighted neighbourhood average in patchView, an EOTF result in the
 * provenance card), not one of 256 quantised values, so there is nothing
 * finite to precompute. The quantisation is on the OUTPUT side, which a
 * table keyed on input cannot exploit.
 */
export function linearToSrgbScalar(v: number): number {
  let x = v;
  if (v < 0) x = 0;
  else if (v > 1) x = 1;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/**
 * Decode interleaved sRGB-encoded Uint8 [0-255] channels into linear-light
 * Float32 [0-1], writing IN PLACE into `dst`. `dst` must be at least as
 * long as `srcU8`; exactly `srcU8.length` elements are written (matching
 * the bounds the previous inline loops used). Channel layout (RGB vs RGBA)
 * is irrelevant — the EOTF is applied per channel.
 */
export function writeFloatColorsInto(
  dst: Float32Array,
  srcU8: Uint8Array | Uint8ClampedArray,
): void {
  for (let i = 0; i < srcU8.length; i++) {
    // Indexes the table directly instead of calling `srgbByteToLinear`: an
    // in-bounds read of a Uint8Array or Uint8ClampedArray is always an
    // integer in [0, 255], so the range guard can only ever pass here and
    // the loop skips it. Values are identical to the guarded entry point.
    dst[i] = SRGB_BYTE_TO_LINEAR[srcU8[i]];
  }
}
