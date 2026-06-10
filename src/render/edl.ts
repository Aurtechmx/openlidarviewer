/**
 * edl.ts
 *
 * The pure mathematics behind Eye Dome Lighting — the screen-space depth-cue
 * that traces every depth discontinuity in a point cloud, giving the eye a
 * readable sense of 3D structure.
 *
 * This module has NO three.js or DOM dependency, so it is unit-tested in Node.
 * The GPU-side EDL node (in `Viewer.ts`) mirrors these exact formulas, so the
 * tests here pin down the behaviour the shader is expected to reproduce.
 */

/** Which GPU backend the renderer ended up on. */
export type RenderBackend = 'webgpu' | 'webgl2';

/** Default EDL tuning, chosen for the bundled survey samples. */
export const EDL_DEFAULTS = {
  /**
   * Higher = more pronounced depth cueing. v0.3.6 premium-graphics pass:
   * 0.5 → 0.7 so the screen-space depth cueing actually carves visible
   * geometry into the cloud (buildings, terrain folds, vegetation
   * volumes) rather than just whispering at it. Still well clear of the
   * over-cooked "burned-edge" range above 1.0.
   */
  strength: 0.7,
  /**
   * Neighbour sampling distance, in device pixels. Bumped 1.4 → 1.6 to
   * widen the edge halo a hair — reads as a richer rim light at the
   * device pixel ratios the renderer now targets.
   */
  radiusPx: 1.6,
} as const;

/** A reasonable strength range for a user-facing control. */
export const EDL_STRENGTH_RANGE = { min: 0, max: 1.5 } as const;

/** Floor applied before a log, so a zero/near-zero distance never blows up. */
const MIN_DIST = 1e-4;

/**
 * Floor applied to the camera near plane inside the logarithmic depth
 * encoding, exactly as three.js's `viewZToLogarithmicDepth` clamps it
 * (`near = near.max(1e-6)`), so a `near = 0` camera never divides by zero.
 */
const LOG_DEPTH_NEAR_MIN = 1e-6;

// ─────────────────────────────────────────────────────────────────────────────
// Logarithmic depth-buffer encoding
//
// The Viewer constructs its renderer with `logarithmicDepthBuffer: true`, so
// the depth texture the EDL pass samples is NOT standard perspective depth.
// three.js's node pipeline (r184, `NodeMaterial.setupDepth` →
// `viewZToLogarithmicDepth`) overwrites fragment depth with the Ulrich
// near-anchored logarithmic encoding:
//
//     raw = log2(eyeDist / near') / log2(far / near'),   near' = max(near, 1e-6)
//
// where `eyeDist` is the positive eye-space distance (-viewZ). This maps
// eyeDist = near → 0 and eyeDist = far → 1, with constant *relative* depth
// precision across the whole range — which is why a 50 km survey and a 5 m
// indoor scan can share one depth buffer without z-fighting.
//
// NOTE this is the WebGPURenderer/node-pipeline convention, used by BOTH the
// WebGPU backend and the WebGL 2 fallback (they compile the same node graph).
// It is deliberately NOT the legacy WebGLRenderer GLSL-chunk convention
// (`gl_FragDepth = log2(1 + w) / log2(1 + far)`), which this app never uses.
//
// Inverting for the eye distance (solve the forward formula for eyeDist):
//
//     raw · log2(far / near') = log2(eyeDist / near')
//     eyeDist                 = near' · 2^(raw · log2(far / near'))
//
// The GPU-side EDL node in `Viewer.ts` mirrors these formulas node-for-node;
// the unit tests on these CPU twins pin the maths down.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forward logarithmic depth encoding — the value three.js writes into the
 * depth buffer for a fragment at positive eye-space distance `eyeDist`, when
 * the renderer was created with `logarithmicDepthBuffer: true`.
 *
 * Exists chiefly so tests can round-trip {@link logDepthToEyeDistance}
 * against the exact forward formula the GPU applies.
 *
 * @param eyeDist - Positive eye-space distance of the fragment (world units).
 * @param near - Camera near plane (clamped to >= 1e-6, as three.js does).
 * @param far - Camera far plane.
 */
export function eyeDistanceToLogDepth(
  eyeDist: number,
  near: number,
  far: number,
): number {
  const n = Math.max(near, LOG_DEPTH_NEAR_MIN);
  return Math.log2(Math.max(eyeDist, MIN_DIST) / n) / Math.log2(far / n);
}

/**
 * Invert a logarithmic depth-buffer sample back to a positive eye-space
 * distance: `eyeDist = near' · 2^(raw · log2(far / near'))`.
 *
 * This is the inversion the EDL pass must use when the renderer owns a
 * logarithmic depth buffer. Feeding a log-encoded sample through the standard
 * `perspectiveDepthToViewZ` formula instead computes obscurance in the wrong
 * space — far too weak near the camera, erratic at distance — which was
 * exactly the v0.4.x rendering defect this function fixes.
 *
 * The result is floored at the same `MIN_DIST` (1e-4) the obscurance maths
 * uses, so a raw sample of 0 with a degenerate near plane can never reach the
 * downstream `log2` as zero.
 *
 * @param raw - The depth-buffer sample in [0, 1] (0 = near plane, 1 = far).
 * @param near - Camera near plane (clamped to >= 1e-6, as three.js does).
 * @param far - Camera far plane.
 */
export function logDepthToEyeDistance(
  raw: number,
  near: number,
  far: number,
): number {
  const n = Math.max(near, LOG_DEPTH_NEAR_MIN);
  return Math.max(n * Math.pow(2, raw * Math.log2(far / n)), MIN_DIST);
}

/**
 * Noise gate, in log2(eye-distance) units. A neighbour must sit at least this
 * much deeper before it contributes any obscurance.
 *
 * The depth buffer has finite precision, so a perfectly flat surface still
 * yields tiny, jittery depth differences between a pixel and its neighbours.
 * Un-gated, that jitter makes EDL shading shimmer as the camera moves. Real
 * depth discontinuities are far larger than this threshold (a neighbour twice
 * as far away is a full 1.0 in log2 space), so gating sub-threshold
 * differences removes the shimmer without weakening genuine edges.
 */
export const EDL_DEPTH_BIAS = 0.1;

/**
 * EDL obscurance for one pixel: the summed amount by which the pixel sits
 * *behind* its screen-space neighbours, measured in log2(eye-distance) space.
 *
 * Working in log2 of the eye-space distance makes the effect scale-invariant —
 * it reads the same on a kilometre-wide survey and a single room. A pixel
 * deeper than a neighbour by more than `EDL_DEPTH_BIAS` contributes a positive
 * term; smaller differences (including depth-buffer noise) contribute nothing.
 * The result is always >= 0.
 *
 * @param centerEyeDist - Eye-space distance of the pixel (world units, > 0).
 * @param neighbourEyeDists - Eye-space distances of the sampled neighbours.
 */
export function edlObscurance(
  centerEyeDist: number,
  neighbourEyeDists: number[],
): number {
  const logC = Math.log2(Math.max(centerEyeDist, MIN_DIST));
  let sum = 0;
  for (const n of neighbourEyeDists) {
    const logN = Math.log2(Math.max(n, MIN_DIST));
    sum += Math.max(0, logC - logN - EDL_DEPTH_BIAS);
  }
  return sum;
}

/**
 * Shading factor in [0, 1] from an obscurance sum and a strength. 1 leaves a
 * pixel untouched; lower values darken it. `strength` is clamped to >= 0, so a
 * pixel on a flat surface (obscurance 0) always returns exactly 1.
 */
export function edlShade(obscurance: number, strength: number): number {
  const s = Math.exp(-Math.max(0, obscurance) * Math.max(0, strength));
  return Math.min(1, Math.max(0, s));
}

/**
 * Whether EDL should be ON by default for a given backend and device.
 *
 * EDL is a full-screen pass; on the WebGL 2 fallback backend and on mobile
 * GPUs it defaults OFF so a weak device is never dropped below interactive on
 * first load. The user can still enable it manually from the render controls.
 */
export function edlDefaultEnabled(
  backend: RenderBackend,
  isMobile: boolean,
): boolean {
  return backend === 'webgpu' && !isMobile;
}
