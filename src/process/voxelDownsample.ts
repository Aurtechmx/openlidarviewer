import { PointCloud } from '../model/PointCloud';

/**
 * Voxel-grid downsample.
 *
 * Points are bucketed into a regular grid of cubic voxels of side `voxelSize`.
 * Each occupied voxel collapses to one output point at the centroid of its
 * members; colour and intensity are averaged. Classification is categorical,
 * so the first member's code is kept rather than averaged.
 *
 * Deterministic: voxels are emitted in first-seen (insertion) order, so the
 * same input always produces the same output — which is what makes this
 * unit-testable.
 */
export function voxelDownsample(cloud: PointCloud, voxelSize: number): PointCloud {
  if (!(voxelSize > 0)) {
    throw new RangeError(`voxelDownsample: voxelSize must be > 0 (got ${voxelSize})`);
  }

  const pos = cloud.positions;
  const count = cloud.pointCount;
  const colors = cloud.colors;
  const intensity = cloud.intensity;
  const classification = cloud.classification;

  interface Voxel {
    x: number;
    y: number;
    z: number;
    r: number;
    g: number;
    b: number;
    intensity: number;
    classification: number;
    n: number;
  }

  const grid = new Map<string, Voxel>();
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const key =
      Math.floor(x / voxelSize) + ',' + Math.floor(y / voxelSize) + ',' + Math.floor(z / voxelSize);

    let v = grid.get(key);
    if (v === undefined) {
      v = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, intensity: 0, classification: 0, n: 0 };
      grid.set(key, v);
    }
    v.x += x;
    v.y += y;
    v.z += z;
    if (colors !== undefined) {
      v.r += colors[i * 3];
      v.g += colors[i * 3 + 1];
      v.b += colors[i * 3 + 2];
    }
    if (intensity !== undefined) v.intensity += intensity[i];
    if (classification !== undefined && v.n === 0) v.classification = classification[i];
    v.n++;
  }

  const out = grid.size;
  const outPositions = new Float32Array(out * 3);
  const outColors = colors !== undefined ? new Uint8Array(out * 3) : undefined;
  const outIntensity = intensity !== undefined ? new Uint16Array(out) : undefined;
  const outClass = classification !== undefined ? new Uint8Array(out) : undefined;

  let i = 0;
  for (const v of grid.values()) {
    outPositions[i * 3] = v.x / v.n;
    outPositions[i * 3 + 1] = v.y / v.n;
    outPositions[i * 3 + 2] = v.z / v.n;
    if (outColors !== undefined) {
      outColors[i * 3] = Math.round(v.r / v.n);
      outColors[i * 3 + 1] = Math.round(v.g / v.n);
      outColors[i * 3 + 2] = Math.round(v.b / v.n);
    }
    if (outIntensity !== undefined) outIntensity[i] = Math.round(v.intensity / v.n);
    if (outClass !== undefined) outClass[i] = v.classification;
    i++;
  }

  return new PointCloud({
    positions: outPositions,
    colors: outColors,
    intensity: outIntensity,
    classification: outClass,
    origin: cloud.origin,
    sourceFormat: cloud.sourceFormat,
    name: cloud.name,
    declaredPointCount: cloud.declaredPointCount,
    // Preserve the decoded count so the Health Check still compares against
    // what was read from the file, not this reduced cloud.
    decodedPointCount: cloud.decodedPointCount,
  });
}

/**
 * Estimate a voxel size that brings `cloud` near `maxPoints`.
 *
 * LiDAR and scan data lies on a roughly two-dimensional surface, not a filled
 * three-dimensional volume. A volume-based estimate (`cbrt(volume / target)`)
 * therefore picks a voxel far too large — it would crush a multi-million-point
 * survey down to a few tens of thousands of points. Sizing the voxel from the
 * dominant face of the bounding box (`sqrt(area / target)`) instead lands
 * close to the budget for surface-like data.
 *
 * It is still only an estimate — clouds are rarely uniformly dense — so
 * callers downsample iteratively, growing or shrinking the size, to converge
 * on the budget.
 */
export function voxelSizeForBudget(cloud: PointCloud, maxPoints: number): number {
  const { min, max } = cloud.bounds();
  const dx = Math.max(max[0] - min[0], 1e-6);
  const dy = Math.max(max[1] - min[1], 1e-6);
  const dz = Math.max(max[2] - min[2], 1e-6);
  const target = Math.max(maxPoints, 1);
  const dominantFace = Math.max(dx * dy, dx * dz, dy * dz);
  return Math.sqrt(dominantFace / target);
}

/**
 * Downsample `cloud` so it fits within `maxPoints`.
 *
 * Starts from `voxelSizeForBudget`'s estimate, then converges on the budget
 * from both sides: it grows the voxel while the cloud is over budget, then
 * shrinks it while the cloud sits wastefully far under budget — without ever
 * letting the result exceed `maxPoints`. The pass count is capped so a
 * pathological cloud cannot loop indefinitely.
 *
 * If `cloud` already fits, the *same object* is returned untouched, so callers
 * can detect "was it downsampled?" with a simple identity check.
 */
export function downsampleToBudget(cloud: PointCloud, maxPoints: number): PointCloud {
  if (cloud.pointCount <= maxPoints) return cloud;

  const MAX_PASSES = 14;
  let voxelSize = voxelSizeForBudget(cloud, maxPoints);
  let reduced = voxelDownsample(cloud, voxelSize);
  let passes = 1;

  // Still too many points: grow the voxel until the cloud fits the budget.
  while (reduced.pointCount > maxPoints && passes < MAX_PASSES) {
    voxelSize *= 1.4;
    reduced = voxelDownsample(cloud, voxelSize);
    passes++;
  }

  // Wastefully far under budget: the voxel is too large and detail is being
  // thrown away. Shrink it to recover points — but never past the size that
  // would push the cloud back over the budget.
  while (reduced.pointCount < maxPoints * 0.6 && passes < MAX_PASSES) {
    const candidate = voxelDownsample(cloud, voxelSize / 1.4);
    if (candidate.pointCount > maxPoints) break;
    voxelSize /= 1.4;
    reduced = candidate;
    passes++;
  }

  return reduced;
}
