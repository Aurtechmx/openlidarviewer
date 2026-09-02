/**
 * densityPointSize.ts — the `density` point-size mode's render-side wiring.
 *
 * The maths (per-point size from local neighbourhood density) lives in
 * `localDensitySize.ts`; this is the thin bridge that attaches those per-point
 * multipliers to a cloud's geometry and selects the size-graph node for the
 * mode. It is kept out of Viewer.ts so the density feature does not grow the
 * ratcheted monolith, and imports the maths module — graduating it from the
 * staged register.
 *
 * The multiplier is a DISPLAY aid: sparse regions get larger points and dense
 * ones smaller, so thin areas read clearly. It never alters point data or any
 * measurement.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, max, mix, positionView } from 'three/tsl';
import { localDensitySizes, autoDensitySizeParams } from './localDensitySize';
import { POINT_STYLE_DEFAULTS, type PointSizeMode } from './pointStyle';

// The coarse-LOD display fold is part of the same size-graph wiring seam, so it
// reaches the Viewer through this module rather than as a second direct import.
export { CoarseLodSizeNodes } from './streamingLodSize';

// Broad TSL node type, matching how Viewer.ts bridges the three/tsl graph.
type TslNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** userData flag marking a material whose geometry carries the `aSize` attribute. */
const DENSITY_SIZE_FLAG = 'olvDensitySize';

/** The subset of a cloud entry this module needs. */
export interface DensitySizeEntry {
  readonly cloud: { readonly positions: Float32Array };
  readonly mesh: { readonly geometry: THREE.BufferGeometry };
  readonly material: THREE.PointsNodeMaterial;
}

/**
 * Compute and attach the per-point density-size multiplier to every cloud that
 * does not yet carry one, from the positions the cloud already holds. Idempotent
 * (a material already flagged is skipped) and self-tuning (grid and reference
 * density come from the cloud's own extent). The `aSize` attribute must align
 * 1:1 with the uploaded instances, so a cloud whose retained positions and mesh
 * instance count disagree is skipped rather than mis-sized.
 */
export function ensureDensitySizes(clouds: Iterable<DensitySizeEntry>): void {
  for (const entry of clouds) {
    const material = entry.material;
    if (material.userData?.[DENSITY_SIZE_FLAG] === true) continue;
    const positions = entry.cloud.positions;
    const n = positions.length / 3;
    const geom = entry.mesh.geometry;
    if (n === 0 || !(geom instanceof THREE.InstancedBufferGeometry)) continue;
    if (geom.instanceCount !== n) continue;
    const scales = localDensitySizes({ positions, ...autoDensitySizeParams(positions) });
    geom.setAttribute('aSize', new THREE.InstancedBufferAttribute(scales, 1));
    material.userData[DENSITY_SIZE_FLAG] = true;
  }
}

/**
 * The base size-graph node for a material under the current mode: the adaptive
 * distance node multiplied by the per-point `aSize` attribute for `density`,
 * the plain adaptive node for `adaptive` (and for `density` on a material with
 * no attribute — a streaming node — so it degrades rather than reads a missing
 * attribute), or null for `fixed` (the material's scalar size is used).
 */
export function pointSizeBaseNode(
  mode: PointSizeMode,
  adaptiveNode: TslNode,
  material: THREE.PointsNodeMaterial,
): TslNode | null {
  const density = mode === 'density' && material.userData?.[DENSITY_SIZE_FLAG] === true;
  if (density) return adaptiveNode.mul(attribute('aSize'));
  return mode === 'fixed' ? null : adaptiveNode;
}

/**
 * Build the adaptive point-size node: a point's pixel size is `base × ref /
 * eyeDistance`, clamped to `[minSizePx, base × maxSizeFactor]`. Mirrors
 * `adaptivePointSize` in `pointStyle.ts`. `positionView` is the point's
 * instance centre in view space, so `-z` is its eye-space distance.
 */
export function buildAdaptiveSizeNode(
  base: TslNode,
  attnRef: TslNode,
  orthoDist: TslNode,
  orthoFlag: TslNode,
): TslNode {
  // Perspective: divide by each point's own eye distance so far points shrink.
  // Orthographic: there is no perspective divide, so every point takes the
  // SAME size — divide by the camera's distance to the target (a uniform)
  // instead, which makes points scale with zoom but not with depth. `orthoFlag`
  // is exactly 0 or 1, so `mix` selects one divisor with no blending.
  const eyeDist: TslNode = max((positionView as TslNode).z.negate(), float(1e-4));
  const divisor: TslNode = mix(eyeDist, orthoDist, orthoFlag);
  const attenuated: TslNode = base.mul(attnRef).div(divisor);
  const maxSize: TslNode = base.mul(POINT_STYLE_DEFAULTS.maxSizeFactor);
  return attenuated.clamp(float(POINT_STYLE_DEFAULTS.minSizePx), maxSize);
}
