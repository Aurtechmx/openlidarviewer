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
 * Piecewise linear → sRGB OETF for ONE channel value in [0, 1] — the exact
 * inverse of {@link srgbToLinearScalar} (IEC 61966-2-1, matches three.js's
 * `Color.LinearToSRGB`). Input is clamped to [0, 1]. Exported so the encode
 * call sites (patchView's neighbourhood splat, the Inspector's colour-
 * provenance card) share the one curve instead of carrying byte-identical
 * inline copies that could drift from this seam.
 */
export function linearToSrgbScalar(v: number): number {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
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
    dst[i] = srgbToLinearScalar(srcU8[i] / 255);
  }
}
