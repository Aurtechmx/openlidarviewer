/**
 * scaleBar.ts
 *
 * Pure-data scale-bar formatter for the v0.3.7 final-polish snapshot
 * overlay. Given a `pixelsPerMetre` ratio derived from the camera and
 * the canvas height, returns:
 *
 *   - a "nice" round step in metres (1-2-5 progression, like a tape
 *     measure: 0.5 m, 1 m, 2 m, 5 m, 10 m, 20 m, 50 m, …)
 *   - the bar's pixel length at that step
 *   - the matching label
 *
 * No DOM, no three.js — the consumer (Viewer snapshot path or a future
 * inspector overlay) calls this and draws the bar however it wants.
 */

/** Computed scale-bar geometry + label. */
export interface ScaleBarLayout {
  /** Nice-step distance the bar represents, metres. */
  readonly stepMetres: number;
  /** Bar length in canvas pixels. */
  readonly stepPixels: number;
  /** User-facing label, with units. Example: "5 m", "20 m", "1 km". */
  readonly label: string;
}

/**
 * Compute a nice scale-bar layout that fits within `maxPixels`.
 *
 * The function picks the largest 1-2-5 step that draws inside
 * `maxPixels` at the given `pixelsPerMetre`. Returns a 0-length layout
 * with empty label when the camera state can't be measured (zero or
 * negative `pixelsPerMetre`), so the caller can skip drawing without
 * a special branch.
 */
export function computeScaleBar(
  pixelsPerMetre: number,
  maxPixels: number,
): ScaleBarLayout {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0 || maxPixels <= 0) {
    return { stepMetres: 0, stepPixels: 0, label: '' };
  }
  // Desired pixel width — fill ~60 % of the budget so the bar leaves room.
  const targetPixels = Math.max(60, maxPixels * 0.6);
  const targetMetres = targetPixels / pixelsPerMetre;

  // 1-2-5 progression — find the largest "nice" step ≤ targetMetres.
  const exp = Math.floor(Math.log10(targetMetres));
  const base = Math.pow(10, exp);
  const choices = [1, 2, 5, 10].map((m) => m * base);
  let stepMetres = choices[0];
  for (const c of choices) {
    if (c <= targetMetres) stepMetres = c;
  }

  const stepPixels = Math.round(stepMetres * pixelsPerMetre);
  // Clip the bar to the budget. If the next "nice" step would overflow,
  // the bar simply stays at the current step — its pixel length stays
  // within `maxPixels`.

  // Label formatting — 1 km and above show "km", below 1 m show "cm".
  let label: string;
  if (stepMetres >= 1000) {
    label = `${(stepMetres / 1000).toFixed(stepMetres >= 10_000 ? 0 : 1)} km`;
  } else if (stepMetres >= 1) {
    label = `${stepMetres % 1 === 0 ? stepMetres : stepMetres.toFixed(1)} m`;
  } else {
    label = `${Math.round(stepMetres * 100)} cm`;
  }

  return { stepMetres, stepPixels, label };
}

/**
 * Estimate pixels-per-metre at the current camera depth — the value the
 * snapshot overlay feeds `computeScaleBar`. Returns 0 when the camera
 * state is degenerate (zero focal length, infinite depth).
 *
 * Derivation: a perspective camera with vertical FOV `fovYRadians` and
 * a viewport of `canvasHeight` pixels projects 1 metre at distance `d`
 * onto `canvasHeight / (2 · d · tan(fov / 2))` pixels.
 */
export function pixelsPerMetreAt(
  fovYRadians: number,
  canvasHeight: number,
  cameraDistanceToTarget: number,
): number {
  if (
    !Number.isFinite(fovYRadians) ||
    !Number.isFinite(canvasHeight) ||
    !Number.isFinite(cameraDistanceToTarget)
  ) {
    return 0;
  }
  if (fovYRadians <= 0 || canvasHeight <= 0 || cameraDistanceToTarget <= 0) {
    return 0;
  }
  return canvasHeight / (2 * cameraDistanceToTarget * Math.tan(fovYRadians / 2));
}
