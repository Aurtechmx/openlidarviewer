import { PointCloud } from '../model/PointCloud';
import { sourcePositions } from '../model/pointFrames';
import { withLinkageUnavailable } from '../model/OrganizedRange';

/**
 * Voxel-grid stride for packing a 3-D voxel index into one numeric Map key.
 * A numeric key avoids building a string for every point — the dominant cost
 * when downsampling a multi-million-point cloud. Packing as `(gx*S + gy)*S + gz`
 * stays collision-free while each grid index is within [-S/2, S/2), i.e. the
 * ±65536-voxel-per-axis window every realistic recentred scan satisfies.
 */
export const GRID_STRIDE = 131072;

/**
 * Half the stride — the inclusive lower / exclusive upper bound a voxel index
 * may take before the numeric pack can alias a neighbouring bucket. Outside it
 * (huge un-recentred projected coordinates with a tiny voxel size) we fall back
 * to a string key, which can't collide — a silent spatial collision would
 * corrupt the downsample without ever throwing.
 */
const GRID_INDEX_BOUND = GRID_STRIDE / 2;

export function voxelIndexInRange(g: number): boolean {
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

  const pos = sourcePositions(cloud);
  const count = cloud.pointCount;
  const colors = cloud.colors;
  const intensity = cloud.intensity;
  const classification = cloud.classification;
  const returnNumber = cloud.returnNumber;
  const returnCount = cloud.returnCount;
  const pointSourceId = cloud.pointSourceId;
  const gpsTime = cloud.gpsTime;

  // Per-voxel running sums in typed arrays indexed by a first-seen slot, with
  // the voxel lookup in an open-addressing table over the packed numeric key.
  // Slots are handed out by one counter in the order voxels are first seen,
  // and every sum is accumulated in input order in doubles, so the output is
  // the same as the Map-and-growable-array form this replaced, to the byte.
  const acc = new VoxelAccumulator(Math.min(count, INITIAL_SLOTS), {
    colors: colors !== undefined,
    intensity: intensity !== undefined,
    extras: classification !== undefined || returnNumber !== undefined
      || returnCount !== undefined || pointSourceId !== undefined,
    gpsTime: gpsTime !== undefined,
  });

  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const gx = Math.floor(x / voxelSize);
    const gy = Math.floor(y / voxelSize);
    const gz = Math.floor(z / voxelSize);
    const slot = acc.slotFor(gx, gy, gz);
    acc.sumX[slot] += x;
    acc.sumY[slot] += y;
    acc.sumZ[slot] += z;
    if (colors !== undefined) {
      acc.sumR[slot] += colors[i * 3];
      acc.sumG[slot] += colors[i * 3 + 1];
      acc.sumB[slot] += colors[i * 3 + 2];
    }
    if (intensity !== undefined) acc.sumI[slot] += intensity[i];
    if (acc.counts[slot] === 0) {
      if (classification !== undefined) acc.firstClass[slot] = classification[i];
      if (returnNumber !== undefined) acc.firstReturnNumber[slot] = returnNumber[i];
      if (returnCount !== undefined) acc.firstReturnCount[slot] = returnCount[i];
      if (pointSourceId !== undefined) acc.firstSourceId[slot] = pointSourceId[i];
      if (gpsTime !== undefined) acc.firstGpsTime[slot] = gpsTime[i];
    }
    acc.counts[slot]++;
  }

  return emitVoxelCloud(cloud, acc.slotCount, acc);
}

/** Per-voxel sums and first-member values, indexed by slot; typed or plain arrays alike. */
export interface VoxelSums {
  readonly sumX: ArrayLike<number>;
  readonly sumY: ArrayLike<number>;
  readonly sumZ: ArrayLike<number>;
  readonly sumR: ArrayLike<number>;
  readonly sumG: ArrayLike<number>;
  readonly sumB: ArrayLike<number>;
  readonly sumI: ArrayLike<number>;
  readonly firstClass: ArrayLike<number>;
  readonly firstReturnNumber: ArrayLike<number>;
  readonly firstReturnCount: ArrayLike<number>;
  readonly firstSourceId: ArrayLike<number>;
  readonly firstGpsTime: ArrayLike<number>;
  readonly counts: ArrayLike<number>;
}

/**
 * The output cloud from `out` voxels of sums: centroids as Float32, colours
 * and intensity rounded from their means, first-member values carried, and
 * every field of `cloud` that is not per point passed through.
 */
export function emitVoxelCloud(cloud: PointCloud, out: number, acc: VoxelSums): PointCloud {
  const colors = cloud.colors;
  const intensity = cloud.intensity;
  const classification = cloud.classification;
  const returnNumber = cloud.returnNumber;
  const returnCount = cloud.returnCount;
  const pointSourceId = cloud.pointSourceId;
  const gpsTime = cloud.gpsTime;
  const outPositions = new Float32Array(out * 3);
  const outColors = colors !== undefined ? new Uint8Array(out * 3) : undefined;
  const outIntensity = intensity !== undefined ? new Uint16Array(out) : undefined;
  const outClass = classification !== undefined ? new Uint8Array(out) : undefined;
  const outReturnNumber = returnNumber !== undefined ? new Uint8Array(out) : undefined;
  const outReturnCount = returnCount !== undefined ? new Uint8Array(out) : undefined;
  const outSourceId = pointSourceId !== undefined ? new Uint16Array(out) : undefined;
  const outGpsTime = gpsTime !== undefined ? new Float64Array(out) : undefined;

  for (let s = 0; s < out; s++) {
    const n = acc.counts[s];
    outPositions[s * 3] = acc.sumX[s] / n;
    outPositions[s * 3 + 1] = acc.sumY[s] / n;
    outPositions[s * 3 + 2] = acc.sumZ[s] / n;
    if (outColors !== undefined) {
      outColors[s * 3] = Math.round(acc.sumR[s] / n);
      outColors[s * 3 + 1] = Math.round(acc.sumG[s] / n);
      outColors[s * 3 + 2] = Math.round(acc.sumB[s] / n);
    }
    if (outIntensity !== undefined) outIntensity[s] = Math.round(acc.sumI[s] / n);
    if (outClass !== undefined) outClass[s] = acc.firstClass[s];
    if (outReturnNumber !== undefined) outReturnNumber[s] = acc.firstReturnNumber[s];
    if (outReturnCount !== undefined) outReturnCount[s] = acc.firstReturnCount[s];
    if (outSourceId !== undefined) outSourceId[s] = acc.firstSourceId[s];
    if (outGpsTime !== undefined) outGpsTime[s] = acc.firstGpsTime[s];
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
    decodedPointCount: cloud.decodedPointCount,
    loadStride: cloud.loadStride,
    metadata: cloud.metadata,
    organizedRange: cloud.organizedRange
      ? withLinkageUnavailable(cloud.organizedRange, 'voxel-centroids')
      : undefined,
  });
}

/** Slots the accumulator starts with; it doubles as voxels are first seen. */
const INITIAL_SLOTS = 1 << 16;

/** A 32-bit mix of the packed key's two halves; the key itself stays exact. */
function hashKey(key: number): number {
  const lo = (key % 4294967296) | 0;
  const hi = Math.floor(key / 4294967296) | 0;
  let h = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  return h ^ (h >>> 13);
}

/**
 * The per-voxel running state behind {@link voxelDownsample}: a lookup from
 * packed voxel key to slot, and typed accumulators indexed by slot.
 *
 * The lookup is an open-addressing table (linear probing, load at most one
 * half) over the exact packed key; a voxel whose indices fall outside the
 * packable window keeps a string key in a small side map, which stays
 * collision-free. Both hand out slots from one counter, so slot order is the
 * order voxels are first seen whichever table they live in. Growing rehashes
 * the keys but never renumbers a slot.
 */
class VoxelAccumulator {
  slotCount = 0;
  sumX: Float64Array;
  sumY: Float64Array;
  sumZ: Float64Array;
  sumR: Float64Array;
  sumG: Float64Array;
  sumB: Float64Array;
  sumI: Float64Array;
  firstClass: Int32Array;
  firstReturnNumber: Int32Array;
  firstReturnCount: Int32Array;
  firstSourceId: Int32Array;
  firstGpsTime: Float64Array;
  counts: Int32Array;
  private _capacity: number;
  private _keys: Float64Array;
  private _slots: Int32Array;
  private _mask: number;
  private readonly _overflow = new Map<string, number>();

  constructor(
    capacity: number,
    wants: { colors: boolean; intensity: boolean; extras: boolean; gpsTime: boolean },
  ) {
    this._capacity = Math.max(1, capacity);
    this.sumX = new Float64Array(this._capacity);
    this.sumY = new Float64Array(this._capacity);
    this.sumZ = new Float64Array(this._capacity);
    const none = new Float64Array(0);
    this.sumR = wants.colors ? new Float64Array(this._capacity) : none;
    this.sumG = wants.colors ? new Float64Array(this._capacity) : none;
    this.sumB = wants.colors ? new Float64Array(this._capacity) : none;
    this.sumI = wants.intensity ? new Float64Array(this._capacity) : none;
    const noInts = new Int32Array(0);
    this.firstClass = wants.extras ? new Int32Array(this._capacity) : noInts;
    this.firstReturnNumber = wants.extras ? new Int32Array(this._capacity) : noInts;
    this.firstReturnCount = wants.extras ? new Int32Array(this._capacity) : noInts;
    this.firstSourceId = wants.extras ? new Int32Array(this._capacity) : noInts;
    this.firstGpsTime = wants.gpsTime ? new Float64Array(this._capacity) : none;
    this.counts = new Int32Array(this._capacity);
    let tableSize = 1;
    while (tableSize < this._capacity * 2) tableSize *= 2;
    this._keys = new Float64Array(tableSize);
    this._slots = new Int32Array(tableSize).fill(-1);
    this._mask = tableSize - 1;
  }

  /** The slot of voxel (gx, gy, gz), allotted on first sight. */
  slotFor(gx: number, gy: number, gz: number): number {
    if (!voxelIndexInRange(gx) || !voxelIndexInRange(gy) || !voxelIndexInRange(gz)) {
      const key = `${gx},${gy},${gz}`;
      let slot = this._overflow.get(key);
      if (slot === undefined) {
        slot = this._newSlot();
        this._overflow.set(key, slot);
      }
      return slot;
    }
    // Room for one more slot is made before the probe, so an insert at the
    // empty index found below is never invalidated by a rehash.
    if (this.slotCount === this._capacity) this._grow();
    const key = (gx * GRID_STRIDE + gy) * GRID_STRIDE + gz;
    let i = hashKey(key) & this._mask;
    for (;;) {
      const slot = this._slots[i];
      if (slot === -1) {
        const fresh = this.slotCount++;
        this._keys[i] = key;
        this._slots[i] = fresh;
        return fresh;
      }
      if (this._keys[i] === key) return slot;
      i = (i + 1) & this._mask;
    }
  }

  private _newSlot(): number {
    if (this.slotCount === this._capacity) this._grow();
    return this.slotCount++;
  }

  /** Double every accumulator and rebuild the key table; slots keep their numbers. */
  private _grow(): void {
    const next = this._capacity * 2;
    const widen = <T extends Float64Array | Int32Array>(a: T): T => {
      if (a.length === 0) return a;
      const b = new (a.constructor as new (n: number) => T)(next);
      b.set(a);
      return b;
    };
    this.sumX = widen(this.sumX);
    this.sumY = widen(this.sumY);
    this.sumZ = widen(this.sumZ);
    this.sumR = widen(this.sumR);
    this.sumG = widen(this.sumG);
    this.sumB = widen(this.sumB);
    this.sumI = widen(this.sumI);
    this.firstClass = widen(this.firstClass);
    this.firstReturnNumber = widen(this.firstReturnNumber);
    this.firstReturnCount = widen(this.firstReturnCount);
    this.firstSourceId = widen(this.firstSourceId);
    this.firstGpsTime = widen(this.firstGpsTime);
    this.counts = widen(this.counts);
    this._capacity = next;
    const oldKeys = this._keys;
    const oldSlots = this._slots;
    let tableSize = 1;
    while (tableSize < next * 2) tableSize *= 2;
    this._keys = new Float64Array(tableSize);
    this._slots = new Int32Array(tableSize).fill(-1);
    this._mask = tableSize - 1;
    for (let j = 0; j < oldSlots.length; j++) {
      const slot = oldSlots[j];
      if (slot === -1) continue;
      const key = oldKeys[j];
      let i = hashKey(key) & this._mask;
      while (this._slots[i] !== -1) i = (i + 1) & this._mask;
      this._keys[i] = key;
      this._slots[i] = slot;
    }
  }
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
 * Reduce `cloud` to at most `maxPoints` by voxel centroids.
 *
 * The first voxel size is estimated for a target slightly under the budget,
 * so a typical estimate lands the first pass at or under `maxPoints` with no
 * further full-cloud passes. When the estimate misses, the size is corrected
 * proportionally (point count scales about `1 / size²` for surface-like
 * data). A pass that fails to move the count by a tenth means the voxel is
 * still below the point spacing, which a proportional step cannot cross; the
 * size then doubles instead. Once the count is under budget, at most two
 * passes aimed by the local count-versus-size exponent recover points a
 * large step gave away. The pass count is hard-capped at
 * {@link MAX_DOWNSAMPLE_PASSES}; the doubling phase reaches one voxel per axis
 * inside that cap for any cloud, so the result never exceeds `maxPoints`.
 *
 * If `cloud` already fits, the *same object* is returned untouched, so callers
 * can detect "was it downsampled?" with a simple identity check.
 */
export function downsampleToBudget(cloud: PointCloud, maxPoints: number): PointCloud {
  return downsampleToBudgetReport(cloud, maxPoints).cloud;
}

/** Full-cloud voxel passes {@link downsampleToBudget} may run, the first included. */
export const MAX_DOWNSAMPLE_PASSES = 16;

/** What a budget reduction did; `passes` counts full-cloud voxel passes. */
export interface DownsampleReport {
  readonly cloud: PointCloud;
  readonly passes: number;
  /** The voxel size of the returned cloud, or 0 when it was returned untouched. */
  readonly voxelSize: number;
}

/** {@link downsampleToBudget} with the pass count and voxel size it settled on. */
export function downsampleToBudgetReport(cloud: PointCloud, maxPoints: number): DownsampleReport {
  // A budget that is not a positive number already fails, but it fails two
  // calls down in `voxelDownsample` complaining about a voxel size the caller
  // never chose. NaN is the one that matters: `pointCount <= NaN` is false, so
  // a budget computed from a missing field walks past the early return and the
  // error arrives from the wrong place. Rejecting it here names the argument
  // that was actually wrong.
  if (!Number.isFinite(maxPoints) || maxPoints < 1) {
    throw new Error(`downsampleToBudget: maxPoints must be a finite number >= 1 (got ${maxPoints})`);
  }
  if (cloud.pointCount <= maxPoints) return { cloud, passes: 0, voxelSize: 0 };

  let passes = 0;
  const pass = (size: number): PointCloud => {
    passes++;
    return voxelDownsample(cloud, size);
  };

  // Aim the first estimate a little under budget. The estimate is usually
  // close, so undershooting the target lands the first pass at or under the
  // budget and the loops below are skipped.
  let size = voxelSizeForBudget(cloud, maxPoints * 0.9);
  let reduced = pass(size);

  // Over budget: grow the voxel. Proportional while a pass makes progress;
  // doubling once it does not, which is the sign the voxel is still below the
  // point spacing (every point alone in its voxel) and a small step is wasted.
  let overSize = 0;
  let overCount = 0;
  while (reduced.pointCount > maxPoints && passes < MAX_DOWNSAMPLE_PASSES) {
    overSize = size;
    overCount = reduced.pointCount;
    const before = reduced.pointCount;
    const ratio = Math.sqrt(before / maxPoints);
    const proportional = Math.min(Math.max(ratio * 1.1, 1.25), 3);
    size *= proportional;
    reduced = pass(size);
    if (reduced.pointCount > maxPoints && reduced.pointCount > before * 0.9) {
      // Flat: switch to doubling until the count moves.
      while (reduced.pointCount > maxPoints && passes < MAX_DOWNSAMPLE_PASSES) {
        overSize = size;
        overCount = reduced.pointCount;
        size *= 2;
        reduced = pass(size);
      }
    }
  }
  if (reduced.pointCount > maxPoints) {
    // Unreachable by the cap arithmetic (16 doublings exceed any extent the
    // estimate can start from); kept so the contract holds whatever the input.
    const { min, max } = cloud.bounds();
    size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6) * 2;
    reduced = pass(size);
  }

  // Wastefully far under budget after a large step: aim one more pass at
  // 0.85 of the budget using the local count-versus-size exponent between
  // the last over-budget size and this one, then at most one correction.
  // Only a result that fits is ever kept.
  if (overSize > 0) {
    let lo = overSize;
    let loCount = overCount;
    let hi = size;
    let hiCount = reduced.pointCount;
    for (let i = 0; i < 2 && hiCount < maxPoints * 0.6 && passes < MAX_DOWNSAMPLE_PASSES; i++) {
      const exponent = Math.log(loCount / hiCount) / Math.log(hi / lo);
      const target = maxPoints * 0.85;
      let next = hi * Math.pow(hiCount / target, 1 / Math.max(exponent, 0.5));
      next = Math.min(Math.max(next, lo * 1.01), hi * 0.99);
      const candidate = pass(next);
      if (candidate.pointCount > maxPoints) {
        lo = next;
        loCount = candidate.pointCount;
      } else {
        hi = next;
        hiCount = candidate.pointCount;
        size = next;
        reduced = candidate;
      }
    }
  }
  return { cloud: reduced, passes, voxelSize: size };
}
