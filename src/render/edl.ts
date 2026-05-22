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
  /** Higher = more pronounced depth cueing. */
  strength: 0.5,
  /** Neighbour sampling distance, in device pixels. */
  radiusPx: 1.4,
} as const;

/** A reasonable strength range for a user-facing control. */
export const EDL_STRENGTH_RANGE = { min: 0, max: 1.5 } as const;

/** Floor applied before a log, so a zero/near-zero distance never blows up. */
const MIN_DIST = 1e-4;

/**
 * EDL obscurance for one pixel: the summed amount by which the pixel sits
 * *behind* its screen-space neighbours, measured in log2(eye-distance) space.
 *
 * Working in log2 of the eye-space distance makes the effect scale-invariant —
 * it reads the same on a kilometre-wide survey and a single room. A pixel
 * deeper than a neighbour contributes a positive term; a pixel in front of a
 * neighbour contributes nothing. The result is always >= 0.
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
    sum += Math.max(0, logC - logN);
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
