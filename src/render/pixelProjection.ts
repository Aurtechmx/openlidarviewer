/**
 * pixelProjection.ts
 *
 * Pure perspective-projection maths for the P4 pixel-space scheduler refinement
 * (program §P4). Converts a world-space size at a given eye distance into its
 * projected extent in CSS pixels, so LOD decisions use SCREEN influence in CSS
 * pixels — never framebuffer pixels. Adaptive DPR must not change which data
 * resolution the scheduler considers necessary.
 *
 *   projectedPx = worldSize · viewportHeightCss / (2 · distance · tan(vFov / 2))
 *
 * Two derived quantities the scheduler keeps DISTINCT (projected node diameter
 * alone is not a sufficient error metric):
 *   - `coveragePixels`     — a node's screen influence (its world diameter).
 *   - `spacingErrorPixels` — whether its internal sample spacing looks coarse.
 *
 * No three import — plain numbers, unit-tested in Node.
 */

/**
 * Project a world-space length to CSS pixels at a given eye distance under a
 * vertical-FOV perspective camera. Guards: non-positive size / viewport / FOV
 * → 0; a near-zero or negative distance is floored so a node containing the
 * camera yields a large-but-finite value (→ "refine", the conservative choice).
 */
export function projectedPixels(
  worldSize: number,
  distance: number,
  viewportHeightCss: number,
  verticalFovRadians: number,
): number {
  if (!(worldSize > 0) || !(viewportHeightCss > 0) || !(verticalFovRadians > 0)) return 0;
  const d = distance > 1e-6 ? distance : 1e-6;
  const denom = 2 * d * Math.tan(verticalFovRadians / 2);
  if (!(denom > 0) || !Number.isFinite(denom)) return 0;
  return (worldSize * viewportHeightCss) / denom;
}

/** A node's projected screen influence, in CSS pixels (its world diameter). */
export function coveragePixels(
  nodeWorldDiameter: number,
  distance: number,
  viewportHeightCss: number,
  verticalFovRadians: number,
): number {
  return projectedPixels(nodeWorldDiameter, distance, viewportHeightCss, verticalFovRadians);
}

/** A node's projected sample spacing, in CSS pixels (how coarse it looks). */
export function spacingErrorPixels(
  nodeSpacing: number,
  distance: number,
  viewportHeightCss: number,
  verticalFovRadians: number,
): number {
  return projectedPixels(nodeSpacing, distance, viewportHeightCss, verticalFovRadians);
}
