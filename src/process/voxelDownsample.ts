import { PointCloud } from '../model/PointCloud';

/**
 * Voxel-grid stride for packing a 3-D voxel index into one numeric Map key.
 * A numeric key avoids building a string for every point — the dominant cost
 * when downsampling a multi-million-point cloud. Packing as `(gx*S + gy)*S + gz`
 * stays collision-free while each grid index is within [-S/2, S/2), i.e. the
 * ±65536-voxel-per-axis window every realistic recentred scan satisfies.
 */
const GRID_STRIDE = 131072;

/**
 * Half the stride — the inclusive lower / exclusive upper bound a voxel index
 * may take before the numeric pack can alias a neighbouring bucket. Outside it
 * (huge un-recentred projected coordinates with a tiny voxel size) we fall back
 * to a string key, which can't collide — a silent spatial collision would
 * corrupt the downsample without ever throwing.
 */
const GRID_INDEX_BOUND = GRID_STRIDE / 2;

function voxelIndexInRange(g: number): boolean {
  return g >= -GRID_INDEX_BOUND && g < GRID_INDEX_BOUND;
}

/**
 * Voxel-grid downsample.
 *
 * Points are bucketed into a regular grid of cubic voxels of side `voxelSize`.
 * Each occupied voxel collapses to one output point at the centroid of its
 * members; colour and intensity are averaged. Classification and the LAS
 * inspection extras (return number/count, point source ID, GPS time) are
 * per-record metadata, not quantities to average — the first member's values
 * are kept, the same contract classification has always used.
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
  const returnNumber = cloud.returnNumber;
  const returnCount = cloud.returnCount;
  const pointSourceId = cloud.pointSourceId;
  const gpsTime = cloud.gpsTime;

  // Per-voxel running sums, kept in flat arrays indexed by a first-seen slot.
  // Avoiding a per-voxel object keeps allocation out of this hot loop, which
  // runs once for every point in the cloud.
  const slotOf = new Map<number | string, number>();
  const sumX: number[] = [];
  const sumY: number[] = [];
  const sumZ: number[] = [];
  const sumR: number[] = [];
  const sumG: number[] = [];
  const sumB: number[] = [];
  const sumI: number[] = [];
  const firstClass: number[] = [];
  // Per-record LAS metadata — kept from the first member, like classification.
  const firstReturnNumber: number[] = [];
  const firstReturnCount: number[] = [];
  const firstSourceId: number[] = [];
  const firstGpsTime: number[] = [];
  const counts: number[] = [];

  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    // Pack the voxel's 3-D grid index into a single numeric key — far cheaper
    // than concatenating a string key for every point.
    const gx = Math.floor(x / voxelSize);
    const gy = Math.floor(y / voxelSize);
    const gz = Math.floor(z / voxelSize);
    // Fast numeric pack when every index sits inside the safe window; otherwise
    // a string key, which is slower but cannot alias another voxel. Mixed
    // number/string Map keys never collide (5 ≠ "5"), and the string form only
    // appears for the rare out-of-range point, so the hot path stays numeric.
    const key =
      voxelIndexInRange(gx) && voxelIndexInRange(gy) && voxelIndexInRange(gz)
        ? (gx * GRID_STRIDE + gy) * GRID_STRIDE + gz
        : `${gx},${gy},${gz}`;

    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = sumX.length;
      slotOf.set(key, slot);
      sumX.push(0);
      sumY.push(0);
      sumZ.push(0);
      sumR.push(0);
      sumG.push(0);
      sumB.push(0);
      sumI.push(0);
      firstClass.push(0);
      firstReturnNumber.push(0);
      firstReturnCount.push(0);
      firstSourceId.push(0);
      firstGpsTime.push(0);
      counts.push(0);
    }
    sumX[slot] += x;
    sumY[slot] += y;
    sumZ[slot] += z;
    if (colors !== undefined) {
      sumR[slot] += colors[i * 3];
      sumG[slot] += colors[i * 3 + 1];
      sumB[slot] += colors[i * 3 + 2];
    }
    if (intensity !== undefined) sumI[slot] += intensity[i];
    // Categorical / per-record metadata — keep the first member's values.
    if (counts[slot] === 0) {
      if (classification !== undefined) firstClass[slot] = classification[i];
      if (returnNumber !== undefined) firstReturnNumber[slot] = returnNumber[i];
      if (returnCount !== undefined) firstReturnCount[slot] = returnCount[i];
      if (pointSourceId !== undefined) firstSourceId[slot] = pointSourceId[i];
      if (gpsTime !== undefined) firstGpsTime[slot] = gpsTime[i];
    }
    counts[slot]++;
  }

  const out = slotOf.size;
  const outPositions = new Float32Array(out * 3);
  const outColors = colors !== undefined ? new Uint8Array(out * 3) : undefined;
  const outIntensity = intensity !== undefined ? new Uint16Array(out) : undefined;
  const outClass = classification !== undefined ? new Uint8Array(out) : undefined;
  const outReturnNumber = returnNumber !== undefined ? new Uint8Array(out) : undefined;
  const outReturnCount = returnCount !== undefined ? new Uint8Array(out) : undefined;
  const outSourceId = pointSourceId !== undefined ? new Uint16Array(out) : undefined;
  const outGpsTime = gpsTime !== undefined ? new Float64Array(out) : undefined;

  for (let s = 0; s < out; s++) {
    const n = counts[s];
    outPositions[s * 3] = sumX[s] / n;
    outPositions[s * 3 + 1] = sumY[s] / n;
    outPositions[s * 3 + 2] = sumZ[s] / n;
    if (outColors !== undefined) {
      outColors[s * 3] = Math.round(sumR[s] / n);
      outColors[s * 3 + 1] = Math.round(sumG[s] / n);
      outColors[s * 3 + 2] = Math.round(sumB[s] / n);
    }
    if (outIntensity !== undefined) outIntensity[s] = Math.round(sumI[s] / n);
    if (outClass !== undefined) outClass[s] = firstClass[s];
    if (outReturnNumber !== undefined) outReturnNumber[s] = firstReturnNumber[s];
    if (outReturnCount !== undefined) outReturnCount[s] = firstReturnCount[s];
    if (outSourceId !== undefined) outSourceId[s] = firstSourceId[s];
    if (outGpsTime !== undefined) outGpsTime[s] = firstGpsTime[s];
  }

  return new PointCloud({
    positions: outPositions,
    colors: outColors,
    intensity: outIntensity,
    classification: outClass,
    returnNumber: outReturnNumber,
    returnCount: outReturnCount,
    pointSourceId: outSourceId,
    gpsTime: outGpsTime,
    origin: cloud.origin,
    sourceFormat: cloud.sourceFormat,
    name: cloud.name,
    declaredPointCount: cloud.declaredPointCount,
    // Preserve the decoded count so the Health Check still compares against
    // what was read from the file, not this reduced cloud.
    decodedPointCount: cloud.decodedPointCount,
    // Provenance metadata is independent of point count — carry it through.
    metadata: cloud.metadata,
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
 * The first voxel size is estimated for a target slightly under the budget,
 * so a typical estimate lands the first pass at or under `maxPoints` with no
 * further full-cloud passes. When the estimate misses, the size is corrected
 * proportionally — point count scales about `1 / size²` for surface-like
 * data — so it converges within a pass or two rather than creeping by a fixed
 * factor. The pass count is capped so a pathological cloud cannot loop
 * indefinitely, and the returned cloud never exceeds `maxPoints`.
 *
 * If `cloud` already fits, the *same object* is returned untouched, so callers
 * can detect "was it downsampled?" with a simple identity check.
 */
export function downsampleToBudget(cloud: PointCloud, maxPoints: number): PointCloud {
  if (cloud.pointCount <= maxPoints) return cloud;

  const MAX_PASSES = 12;
  // Aim the first estimate a little under budget. The estimate is usually
  // close, so undershooting the target lands the first pass at or under the
  // budget — and when it does, both loops below are skipped entirely.
  let voxelSize = voxelSizeForBudget(cloud, maxPoints * 0.9);
  let reduced = voxelDownsample(cloud, voxelSize);
  let passes = 1;

  // Over budget: grow the voxel by a proportional correction until it fits.
  while (reduced.pointCount > maxPoints && passes < MAX_PASSES) {
    const ratio = Math.sqrt(reduced.pointCount / maxPoints);
    voxelSize *= Math.min(Math.max(ratio, 1.05), 3);
    reduced = voxelDownsample(cloud, voxelSize);
    passes++;
  }

  // Wastefully far under budget: the voxel is too large and detail is being
  // thrown away. Shrink it to recover points — but never past the size that
  // would push the cloud back over the budget.
  while (reduced.pointCount < maxPoints * 0.6 && passes < MAX_PASSES) {
    const ratio = Math.sqrt(reduced.pointCount / maxPoints);
    const nextSize = voxelSize * Math.min(Math.max(ratio, 0.5), 0.95);
    const candidate = voxelDownsample(cloud, nextSize);
    if (candidate.pointCount > maxPoints) break;
    voxelSize = nextSize;
    reduced = candidate;
    passes++;
  }

  return reduced;
}
