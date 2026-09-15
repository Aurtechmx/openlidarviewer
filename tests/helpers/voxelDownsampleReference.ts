/**
 * voxelDownsampleReference.ts: the voxel pass as it was before the typed
 * accumulator, kept verbatim so `tests/voxelDownsampleIdentity.test.ts` can
 * hold the live implementation to it byte for byte. Not production code.
 */
import { PointCloud } from '../../src/model/PointCloud';
import { sourcePositions } from '../../src/model/pointFrames';
import { withLinkageUnavailable } from '../../src/model/OrganizedRange';

const GRID_STRIDE = 131072;
const GRID_INDEX_BOUND = GRID_STRIDE / 2;
function voxelIndexInRange(g: number): boolean {
  return g >= -GRID_INDEX_BOUND && g < GRID_INDEX_BOUND;
}

export function voxelDownsampleReference(cloud: PointCloud, voxelSize: number): PointCloud {
  if (!(voxelSize > 0)) {
    throw new RangeError(`voxelDownsample: voxelSize must be > 0 (got ${voxelSize})`);
  }

  const pos = sourcePositions(cloud);
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
    // Drop non-finite points before they reach a voxel. `bounds()` already
    // ignores them for the camera, but the reduced cloud must not carry them
    // either: a NaN/Inf coordinate falls into its own key, sums to NaN, and
    // emits a NaN centroid that would ride through into rendering and analysis.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
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
    // what was read from the file, not this reduced cloud — and the load
    // stride, so a deliberate display-sample cap stays distinguishable from
    // genuine decode loss after the voxel pass.
    decodedPointCount: cloud.decodedPointCount,
    loadStride: cloud.loadStride,
    // Provenance metadata is independent of point count — carry it through.
    metadata: cloud.metadata,
    // The acquisition grid survives; the link from a cell to a display point
    // does not. Every output point here is a centroid of several source
    // returns, so no cell names a return any more, and `withLinkageUnavailable`
    // both says so and clears the stale indices. Dropping the sidecar entirely
    // would be safe but wasteful: the grid, its validity states and its ranges
    // are all still true of the source, and losing them is the reason a
    // reduced scan used to become uninspectable.
    organizedRange: cloud.organizedRange
      ? withLinkageUnavailable(cloud.organizedRange, 'voxel-centroids')
      : undefined,
  });
}

