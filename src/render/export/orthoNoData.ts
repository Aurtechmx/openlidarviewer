/**
 * orthoNoData.ts
 *
 * Coverage mask for the georeferenced top-down ortho PNG. The live renderer is
 * opaque (`alpha: false`), so a capture paints the scene background into every
 * pixel that holds no point. A GIS layer needs those no-data pixels
 * transparent. The framed render is therefore captured twice, once on a black
 * clear and once on a white clear. A pixel fully covered by points has the same
 * colour in both; a pixel with no points takes each background; an
 * antialiased edge pixel lies between them in proportion to its coverage.
 *
 * {@link composeNoDataAlpha} turns the pair into one RGBA raster with a binary
 * alpha: coverage of at least {@link NODATA_COVERAGE_THRESHOLD} becomes an
 * opaque pixel holding the point colour (recovered from the black capture by
 * dividing out the coverage), anything less becomes alpha 0 with RGB 0. No
 * pixel is semi-transparent, so a covered pixel never carries a halo.
 *
 * Both captures go through the same canvas pipeline as every other snapshot,
 * so the colours of covered pixels match the opaque export exactly on WebGPU
 * and WebGL2. Pure: no DOM, no three.js.
 */

/** Coverage (0..1) at and above which a pixel counts as data. */
export const NODATA_COVERAGE_THRESHOLD = 0.5;

/** The two clear colours the captures use, as 0..255 sRGB channel values. */
export const NODATA_DARK_CLEAR = 0;
export const NODATA_LIGHT_CLEAR = 255;

/**
 * Compose the black-clear and white-clear captures (RGBA, same size) into one
 * RGBA raster with binary alpha. Writes into `out` (which may be `onDark`
 * itself) and returns the number of covered pixels.
 */
export function composeNoDataAlpha(
  onDark: ArrayLike<number>,
  onLight: ArrayLike<number>,
  out: { [index: number]: number; readonly length: number },
): number {
  if (onDark.length !== onLight.length || out.length !== onDark.length || onDark.length % 4 !== 0) {
    throw new Error('composeNoDataAlpha: the two captures and the output must be RGBA rasters of one size');
  }
  const span = NODATA_LIGHT_CLEAR - NODATA_DARK_CLEAR;
  let covered = 0;
  for (let i = 0; i < onDark.length; i += 4) {
    const r = onDark[i]!;
    const g = onDark[i + 1]!;
    const b = onDark[i + 2]!;
    // The background shows through by (light - dark) / span in each channel;
    // the largest channel gap is the least coverage the pixel can have.
    const gap = Math.max(onLight[i]! - r, onLight[i + 1]! - g, onLight[i + 2]! - b, 0);
    const coverage = 1 - gap / span;
    if (coverage >= NODATA_COVERAGE_THRESHOLD) {
      covered++;
      out[i] = Math.min(255, Math.round((r - NODATA_DARK_CLEAR) / coverage));
      out[i + 1] = Math.min(255, Math.round((g - NODATA_DARK_CLEAR) / coverage));
      out[i + 2] = Math.min(255, Math.round((b - NODATA_DARK_CLEAR) / coverage));
      out[i + 3] = 255;
    } else {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
    }
  }
  return covered;
}
