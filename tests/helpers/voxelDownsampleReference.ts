/**
 * voxelDownsampleReference.ts: the voxel pass accumulation as it was before
 * the typed accumulator, kept so `tests/voxelDownsampleIdentity.test.ts` can
 * hold the live implementation to it byte for byte. The emit step is the
 * live one, which both ran unchanged. Not production code.
 */
import type { PointCloud } from '../../src/model/PointCloud';
import { sourcePositions } from '../../src/model/pointFrames';
import { emitVoxelCloud, GRID_STRIDE, voxelIndexInRange } from '../../src/process/voxelDownsample';

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

  const slotOf = new Map<number | string, number>();
  const sumX: number[] = [];
  const sumY: number[] = [];
  const sumZ: number[] = [];
  const sumR: number[] = [];
  const sumG: number[] = [];
  const sumB: number[] = [];
  const sumI: number[] = [];
  const firstClass: number[] = [];
  const firstReturnNumber: number[] = [];
  const firstReturnCount: number[] = [];
  const firstSourceId: number[] = [];
  const firstGpsTime: number[] = [];
  const counts: number[] = [];

  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const gx = Math.floor(x / voxelSize);
    const gy = Math.floor(y / voxelSize);
    const gz = Math.floor(z / voxelSize);
    const key =
      voxelIndexInRange(gx) && voxelIndexInRange(gy) && voxelIndexInRange(gz)
        ? (gx * GRID_STRIDE + gy) * GRID_STRIDE + gz
        : `${gx},${gy},${gz}`;
    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = sumX.length;
      slotOf.set(key, slot);
      for (const arr of [sumX, sumY, sumZ, sumR, sumG, sumB, sumI, firstClass, firstReturnNumber, firstReturnCount, firstSourceId, firstGpsTime, counts]) arr.push(0);
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
    if (counts[slot] === 0) {
      if (classification !== undefined) firstClass[slot] = classification[i];
      if (returnNumber !== undefined) firstReturnNumber[slot] = returnNumber[i];
      if (returnCount !== undefined) firstReturnCount[slot] = returnCount[i];
      if (pointSourceId !== undefined) firstSourceId[slot] = pointSourceId[i];
      if (gpsTime !== undefined) firstGpsTime[slot] = gpsTime[i];
    }
    counts[slot]++;
  }
  return emitVoxelCloud(cloud, slotOf.size, {
    sumX, sumY, sumZ, sumR, sumG, sumB, sumI, firstClass, firstReturnNumber, firstReturnCount, firstSourceId, firstGpsTime, counts,
  });
}
