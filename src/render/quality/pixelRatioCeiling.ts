/**
 * pixelRatioCeiling.ts
 *
 * The renderer's device-pixel-ratio ceiling — the one number that decides how
 * many device pixels the drawing buffer holds per CSS pixel. It used to be a
 * `const MAX_PIXEL_RATIO = 1.5` inside `Viewer.ts`, unreachable from anything
 * the user could touch. It lives here so the Speed ↔ Quality control can move
 * it, and so the bounds are stated in one place rather than implied by a
 * literal.
 *
 * Why 1.5 is the default: a retina display reports DPR 2 and shades four
 * sub-pixels per logical pixel. For a point cloud that is close to pure GPU
 * waste — points rasterise as sprite quads, so the visible difference between
 * 1.5× and 2× is small while fragment work grows with the square of the ratio
 * (~44 % more going 1.5 → 2.0). Capping at 1.5 is what keeps laptop-class GPUs
 * out of the thermal envelope on a long session. A low-DPR display is
 * unaffected: the renderer takes `min(window.devicePixelRatio, ceiling)`.
 *
 * SCOPE — display only. The ceiling changes how many pixels are shaded and
 * nothing else. Figure and world-file export render at pixel ratio 1 through
 * `Viewer._renderAtSize`, so no exported raster, measurement, or terrain
 * product can observe this value.
 *
 * The ceiling is module state, deliberately: the Viewer reads it once per
 * frame from inside the render loop, and the shell writes it from the quality
 * control. Rollup hoists a module shared by the shell and the Viewer chunk
 * into one shared chunk, so both sides read the same binding.
 */

/** The shipping default — the historical `MAX_PIXEL_RATIO` in `Viewer.ts`. */
export const MAX_PIXEL_RATIO_DEFAULT = 1.5;

/** Never below one device pixel per CSS pixel: points and text must stay legible. */
export const MAX_PIXEL_RATIO_MIN = 1;

/**
 * Never above 2. Beyond a 2× backing store the extra fragments are invisible on
 * every display this runs on, and the cost keeps growing quadratically.
 */
export const MAX_PIXEL_RATIO_MAX = 2;

let ceiling: number = MAX_PIXEL_RATIO_DEFAULT;

/** Clamp a requested ceiling into `[MAX_PIXEL_RATIO_MIN, MAX_PIXEL_RATIO_MAX]`. */
export function clampPixelRatioCeiling(value: number): number {
  if (!Number.isFinite(value)) return MAX_PIXEL_RATIO_DEFAULT;
  return Math.min(MAX_PIXEL_RATIO_MAX, Math.max(MAX_PIXEL_RATIO_MIN, value));
}

/** The ceiling the renderer applies to `window.devicePixelRatio`. */
export function maxPixelRatio(): number {
  return ceiling;
}

/**
 * Set the ceiling. Returns the value actually applied after clamping, so a
 * caller can render what it got rather than what it asked for. A non-finite
 * request falls back to the default rather than poisoning the render loop.
 */
export function setMaxPixelRatio(value: number): number {
  ceiling = clampPixelRatioCeiling(value);
  return ceiling;
}

/** Restore the shipping default. Used by tests and by "reset to automatic". */
export function resetMaxPixelRatio(): void {
  ceiling = MAX_PIXEL_RATIO_DEFAULT;
}
