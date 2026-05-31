/**
 * ssaoApproximation.ts
 *
 * A pure-data screen-space ambient occlusion approximation for point
 * clouds. No three.js, no fragment shaders, no extra render pass —
 * runs once per chunk at decode time. The renderer reads the resulting
 * per-point AO factor as a colour-modulation factor (multiplicative
 * darkening), composing under the existing EDL pass to produce the
 * "EDL on edges + SSAO on cavities" stack the v0.3.7 graphics roadmap
 * targets.
 *
 * Algorithm (the standard "depth-difference AO" idiom, downprojected
 * into a 2D voxel grid):
 *
 *   1. Hash points into a 2D horizontal voxel grid. Each cell records
 *      the mean height of the points inside it (same pass density and
 *      hillshade use).
 *   2. For each point, compare its height to the *minimum* height in
 *      the 8 surrounding cells. A point that sits well above the
 *      neighbourhood floor is in the open and gets AO = 1; a point in
 *      a pit (below the rim) is occluded and gets AO close to
 *      `minOcclusion`.
 *   3. Map the depth ratio through a smooth curve so the transition
 *      between "open" and "occluded" reads cleanly.
 *
 * The approximation is coarse but produces the perceptually-right
 * darkening for crevices, corners, and depressions — which is what
 * the eye reads to perceive 3D structure. A future
 * full screen-space raymarched SSAO can reuse the same `aoFactor`
 * field on the streaming chunk; consumers won't need to change.
 */

/** Inputs to `ssaoApproximation`. */
export interface SsaoInput {
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  positions: Float32Array;
  /**
   * Horizontal voxel cell size, m. Smaller cells produce sharper AO
   * but more noise on sparse clouds.
   */
  cellSize: number;
  /**
   * Depth window in metres — the height difference at which a point
   * transitions from "open" to "fully occluded". Defaults to 1 m, which
   * works well on terrestrial and drone surveys.
   */
  depthWindow?: number;
  /**
   * Strength multiplier, 0..1. 0 disables AO (every point reads as 1.0
   * → no darkening); 1 applies the full AO factor.
   */
  strength?: number;
  /**
   * Floor on the per-point AO factor — even the most-occluded points
   * never go below this. Default 0.4 (60 % darkening max) prevents
   * crevice points from rendering as nearly-black.
   */
  minOcclusion?: number;
}

/**
 * Compute a per-point AO factor in [minOcclusion, 1]. Returns a new
 * Float32Array of length N. Multiply each point's RGB colour by the
 * factor to bake AO into the rendered output (the renderer's colour
 * pipeline does this once per attribute upload).
 */
export function ssaoApproximation(input: SsaoInput): Float32Array {
  const positions = input.positions;
  const n = positions.length / 3;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const cellSize = Math.max(1e-3, input.cellSize);
  const depthWindow = Math.max(1e-6, input.depthWindow ?? 1);
  const strength = Math.min(1, Math.max(0, input.strength ?? 1));
  const minOcc = Math.min(1, Math.max(0, input.minOcclusion ?? 0.4));

  if (strength === 0) {
    out.fill(1);
    return out;
  }

  // Build 2D voxel grid → mean height per cell, single linear pass.
  const cellSum = new Map<string, number>();
  const cellCount = new Map<string, number>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const ix = Math.floor(x / cellSize);
    const iy = Math.floor(y / cellSize);
    const k = ix + '|' + iy;
    keys[i] = k;
    cellSum.set(k, (cellSum.get(k) ?? 0) + z);
    cellCount.set(k, (cellCount.get(k) ?? 0) + 1);
  }
  const cellZ = new Map<string, number>();
  for (const [k, sum] of cellSum) cellZ.set(k, sum / (cellCount.get(k) ?? 1));

  // Per-point AO via the rim-height heuristic: take the MAXIMUM of the
  // 8-neighbourhood mean heights — the height of the geometry that
  // would occlude the point from light coming from above. Points whose
  // rim is well above them (i.e. they're in a pit) get the most
  // occlusion; points whose rim is at or below their own height (on a
  // plateau, or isolated with no neighbours) read as fully exposed
  // (AO = 1).
  const aoCache = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    const cached = aoCache.get(k);
    let factor: number;
    if (cached !== undefined) {
      factor = cached;
    } else {
      const [ixStr, iyStr] = k.split('|');
      const ix = Number(ixStr);
      const iy = Number(iyStr);
      const self = cellZ.get(k) ?? 0;
      let rim = self; // baseline: no neighbour higher than me → exposed
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const z = cellZ.get(ix + dx + '|' + (iy + dy));
          if (z !== undefined && z > rim) rim = z;
        }
      }
      // Rim-above-self in [0, ∞). 0 → no occluding rim → AO = 1.
      // Larger → rim higher above self → AO → minOcc.
      const rimAbove = Math.max(0, rim - self);
      const t = Math.min(1, rimAbove / depthWindow);
      // Smoothstep so the transition reads cleanly.
      const smooth = t * t * (3 - 2 * t);
      const fullFactor = minOcc + (1 - minOcc) * (1 - smooth);
      factor = 1 - strength * (1 - fullFactor);
      aoCache.set(k, factor);
    }
    out[i] = factor;
  }
  return out;
}
