/**
 * splatShader.ts
 *
 * Pure mathematics of the soft-circular point sprite — how a point's
 * alpha varies across the sprite quad. The GPU-side fragment node (in
 * `Viewer.ts`) mirrors `splatAlpha` exactly so a screenshot and a unit
 * test agree on the same value at the same `distFromCenter`.
 *
 * Why a leaf module
 * ─────────────────
 * Same shape as `pointStyle.ts`: keep the maths in one place, unit-test
 * it in Node, then mirror it in the renderer's TSL node graph. Avoiding
 * a `three` / `three/tsl` import here means a typo in the alpha curve
 * is caught by the suite, not by squinting at a render.
 *
 * Falloff shape
 * ─────────────
 * Quadratic falloff anchored to a configurable feather:
 *   - `feather = 0` → flat disc. Alpha is 1 inside the unit circle,
 *     0 outside. No anti-aliased edge.
 *   - `feather = 1` → full quadratic falloff `1 - d²`. The canonical
 *     splat curve: centre = 1, half-radius ≈ 0.75, edge = 0.
 *   - intermediate values shift where the falloff begins.
 *
 * The feather makes the sprite "kissable" without leaking visible
 * banding inside the cloud. Default 1.0 is the cinematic Soft Splat
 * shape; the Inspection Splats preset uses ~0.4 for a sharper core.
 */

/** Tuning knobs for a splat sprite. */
export interface SplatParams {
  /**
   * How much of the radius is feathered. 0 = hard disc; 1 = pure
   * quadratic falloff from centre to edge.
   */
  readonly feather: number;
}

/** Canonical defaults — what "Soft Splats" mode ships with. */
export const SOFT_SPLAT_DEFAULTS: SplatParams = {
  feather: 1.0,
};

/** Inspection mode — sharper core for measurement work. */
export const INSPECTION_SPLAT_DEFAULTS: SplatParams = {
  feather: 0.4,
};

/**
 * Splat rendering mode. Drives the Viewer's per-frame radius multiplier
 * + alphaToCoverage forcing so the visible point-cloud reads as either
 * crisp samples ("Classic") or a continuous soft surface ("Soft" /
 * "Inspection").
 */
export type SplatMode = 'classic' | 'soft' | 'inspection';

/**
 * Effective on-screen radius multiplier per mode. Multiplied into the
 * user's `_pointSize` at material-push time so the user-displayed size
 * stays meaningful while the rendered sprite grows enough for two
 * adjacent samples to overlap and read as a continuous surface.
 *
 *   Classic    = 1.00   the existing crisp single-pixel sample
 *   Soft       = 1.50   neighbouring sprites kiss → continuous surface
 *   Inspection = 2.00   sparse data fills in cleanly for measurement
 */
export function splatRadiusMultiplier(mode: SplatMode): number {
  switch (mode) {
    case 'classic': return 1.0;
    case 'soft': return 1.5;
    case 'inspection': return 2.0;
  }
}

/**
 * Whether the renderer should force alphaToCoverage on for this mode,
 * regardless of the user's antialiasing preference. Soft and Inspection
 * modes both rely on the smooth circular edge to look continuous;
 * Classic respects the user's choice.
 */
export function splatForcesAlphaToCoverage(mode: SplatMode): boolean {
  return mode === 'soft' || mode === 'inspection';
}

/**
 * Alpha at a normalised distance from the sprite centre.
 *
 * @param distFromCenter - Distance from sprite centre, normalised so
 *   that `0` is the centre and `1` is the outer edge. Out-of-range
 *   inputs are clamped before the maths runs.
 * @param feather - Width of the smooth falloff in `[0, 1]`. Clamped.
 * @returns Alpha in `[0, 1]`.
 */
export function splatAlpha(distFromCenter: number, feather: number): number {
  const d = clamp01(distFromCenter);
  const f = clamp01(feather);
  // A degenerate feather collapses to a hard disc — outside the unit
  // circle is fully transparent so the alphaToCoverage discard still
  // produces a clean edge.
  if (f <= 1e-6) return d >= 1 ? 0 : 1;
  // Flat plateau up to the start of the falloff.
  const startFalloff = 1 - f;
  if (d <= startFalloff) return 1;
  // Map [startFalloff, 1] → [0, 1] and apply the quadratic falloff
  // 1 - t². At t = 0 (start) alpha is 1; at t = 1 (edge) alpha is 0.
  const t = (d - startFalloff) / f;
  return 1 - t * t;
}

/**
 * Distance-aware sprite radius in screen pixels.
 *
 * The sprite covers more pixels per point at a far distance so two
 * neighbouring samples form a continuous surface rather than a sparse
 * dot pattern. `eyeDist / referenceDist` is the perspective falloff;
 * a point at `referenceDist` renders exactly `baseRadiusPx`.
 *
 * Mirrors the size formula in `adaptivePointSize` so a fixed-size and
 * splat-size point produce the same on-screen footprint at the
 * reference distance — switching mode never changes the headline
 * sample size at a glance.
 *
 * @param baseRadiusPx - User-chosen base radius, in device pixels.
 * @param eyeDist - The point's eye-space distance from the camera (> 0).
 * @param referenceDist - Distance at which the sprite is exactly the
 *   base radius (> 0).
 * @param minPx - Lower clamp, in device pixels.
 * @param maxPx - Upper clamp, in device pixels.
 */
export function splatRadiusPx(
  baseRadiusPx: number,
  eyeDist: number,
  referenceDist: number,
  minPx: number,
  maxPx: number,
): number {
  if (eyeDist <= 0 || referenceDist <= 0) return maxPx;
  const attenuated = baseRadiusPx * (referenceDist / eyeDist);
  return Math.min(maxPx, Math.max(minPx, attenuated));
}

/**
 * Combined distance + density-aware radius. Sparse regions widen more
 * aggressively than already-dense regions, so a thinning periphery on
 * an aerial scan still reads as a continuous surface while the dense
 * centre stays crisp.
 *
 * @param baseRadiusPx - User-chosen base radius, in device pixels.
 * @param eyeDist - The point's eye-space distance from the camera (> 0).
 * @param referenceDist - Distance at which the sprite is exactly the
 *   base radius (> 0).
 * @param densityScale - Per-point density factor from
 *   `localDensitySizes` — a unitless multiplier centred on 1.
 *   Defaults to 1 (no density bias) when omitted by the caller.
 * @param minPx - Lower clamp, in device pixels.
 * @param maxPx - Upper clamp, in device pixels.
 */
export function splatRadiusWithDensity(
  baseRadiusPx: number,
  eyeDist: number,
  referenceDist: number,
  densityScale: number,
  minPx: number,
  maxPx: number,
): number {
  const distanceRadius = splatRadiusPx(
    baseRadiusPx,
    eyeDist,
    referenceDist,
    0,
    Number.POSITIVE_INFINITY,
  );
  // Apply density after the distance falloff so the clamp acts on the
  // combined value — a sparse region near the camera does not blow
  // past the maxPx ceiling.
  const combined = distanceRadius * Math.max(0, densityScale);
  return Math.min(maxPx, Math.max(minPx, combined));
}

function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}
