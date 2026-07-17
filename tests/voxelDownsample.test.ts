import { voxelDownsample, voxelSizeForBudget, downsampleToBudget } from '../src/process/voxelDownsample';
import { PointCloud } from '../src/model/PointCloud';

function makeCloud(positions: number[], colors?: number[]): PointCloud {
  return new PointCloud({
    positions: new Float32Array(positions),
    colors: colors ? new Uint8Array(colors) : undefined,
    origin: [0, 0, 0],
    sourceFormat: 'ply',
    name: 'test',
  });
}

test('8 points inside one voxel collapse to a single centroid', () => {
  const pts: number[] = [];
  for (const x of [0.1, 0.9]) {
    for (const y of [0.1, 0.9]) {
      for (const z of [0.1, 0.9]) pts.push(x, y, z);
    }
  }
  const out = voxelDownsample(makeCloud(pts), 1.0);
  expect(out.pointCount).toBe(1);
  expect(out.positions[0]).toBeCloseTo(0.5, 5);
  expect(out.positions[1]).toBeCloseTo(0.5, 5);
  expect(out.positions[2]).toBeCloseTo(0.5, 5);
});

test('points spread across 8 voxels stay as 8 points', () => {
  const pts: number[] = [];
  for (const x of [0.5, 1.5]) {
    for (const y of [0.5, 1.5]) {
      for (const z of [0.5, 1.5]) pts.push(x, y, z);
    }
  }
  const out = voxelDownsample(makeCloud(pts), 1.0);
  expect(out.pointCount).toBe(8);
});

test('out-of-range voxel indices use a collision-free key (no silent merge)', () => {
  // Voxel indices (0, 65536, 0) and (1, -65536, 0) pack to the SAME numeric key
  // under the old (gx*S + gy)*S + gz scheme (both = 65536*S). With voxelSize 1
  // these are points ~131 km apart that must NOT collapse into one voxel — a
  // silent collision would corrupt the spatial representation. The string-key
  // fallback for out-of-range indices keeps them distinct.
  const a = [0.5, 65536.5, 0.5];
  const b = [1.5, -65535.5, 0.5];
  const out = voxelDownsample(makeCloud([...a, ...b]), 1.0);
  expect(out.pointCount).toBe(2);
});

test('non-finite input coordinates are dropped, never emitted as a point', () => {
  // bounds() already ignores non-finite coords for the camera, but the reduced
  // cloud itself must carry only finite points — otherwise a NaN centroid rides
  // through into rendering and downstream analysis (a real defect: NaN in → NaN
  // point out, in its own bucket).
  const out = voxelDownsample(
    makeCloud([
      0.1, 0.1, 0.1, // valid
      NaN, 0.2, 0.2, // NaN x
      0.3, Infinity, 0.3, // +Inf y
      0.4, 0.4, -Infinity, // -Inf z
      5.5, 5.5, 5.5, // valid, separate voxel
    ]),
    1.0,
  );
  expect(out.pointCount).toBe(2);
  for (let i = 0; i < out.positions.length; i++) {
    expect(Number.isFinite(out.positions[i])).toBe(true);
  }
});

test('colours are averaged within a voxel', () => {
  const out = voxelDownsample(
    makeCloud([0.1, 0.1, 0.1, 0.2, 0.2, 0.2], [0, 0, 0, 100, 100, 100]),
    1.0,
  );
  expect(out.pointCount).toBe(1);
  expect(out.colors?.[0]).toBe(50);
  expect(out.colors?.[1]).toBe(50);
  expect(out.colors?.[2]).toBe(50);
});

test('a non-positive voxel size is rejected', () => {
  expect(() => voxelDownsample(makeCloud([0, 0, 0]), 0)).toThrow(RangeError);
  expect(() => voxelDownsample(makeCloud([0, 0, 0]), -1)).toThrow(RangeError);
});

test('the result is deterministic', () => {
  const pts: number[] = [];
  for (let i = 0; i < 50; i++) pts.push(i * 0.03, i * 0.05, i * 0.02);
  const a = voxelDownsample(makeCloud(pts), 0.25);
  const b = voxelDownsample(makeCloud(pts), 0.25);
  expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
});

test('voxelSizeForBudget returns a finite positive size', () => {
  const pts: number[] = [];
  for (let i = 0; i < 100; i++) pts.push(i, i * 2, i * 0.5);
  const size = voxelSizeForBudget(makeCloud(pts), 10);
  expect(size).toBeGreaterThan(0);
  expect(Number.isFinite(size)).toBe(true);
});

test('downsampling reduces the point count of a dense cloud', () => {
  const pts: number[] = [];
  for (let i = 0; i < 1000; i++) {
    pts.push((i % 10) * 0.1, ((i / 10) % 10) * 0.1, Math.floor(i / 100) * 0.1);
  }
  const out = voxelDownsample(makeCloud(pts), 0.5);
  expect(out.pointCount).toBeLessThan(1000);
  expect(out.pointCount).toBeLessThanOrEqual(8);
});

/** A ~flat surface cloud — side × side points on a near-2D plane. */
function surfaceCloud(side: number): PointCloud {
  const pts: number[] = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      pts.push(i, j, ((i * 7 + j * 13) % 5) * 0.01); // z ∈ [0, 0.04] — near-flat
    }
  }
  return makeCloud(pts);
}

test('downsampleToBudget returns the same cloud untouched when it already fits', () => {
  const cloud = makeCloud([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  expect(downsampleToBudget(cloud, 100)).toBe(cloud);
});

test('downsampleToBudget converges near the budget for a surface cloud', () => {
  // Regression guard: a volume-based voxel estimate sized the voxel far too
  // large for surface-like LiDAR data and crushed clouds to a tiny fraction
  // of the budget. The result must land at or under budget — but not collapse.
  const cloud = surfaceCloud(200); // 40,000 points on a near-flat plane
  const budget = 5000;
  const out = downsampleToBudget(cloud, budget);
  expect(out.pointCount).toBeLessThanOrEqual(budget);
  expect(out.pointCount).toBeLessThan(cloud.pointCount);
  expect(out.pointCount).toBeGreaterThan(budget * 0.3); // not gutted
});

test('downsampleToBudget keeps a dense 3D cloud at or under budget', () => {
  const pts: number[] = [];
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 30; j++) {
      for (let k = 0; k < 30; k++) pts.push(i, j, k); // 27,000-point filled cube
    }
  }
  const out = downsampleToBudget(makeCloud(pts), 4000);
  expect(out.pointCount).toBeLessThanOrEqual(4000);
  expect(out.pointCount).toBeLessThan(27000);
});

// ────────────────────────────────────────────────────────────────────────────
// LAS inspection extras — carried through downsampling (v0.2.8)
// ────────────────────────────────────────────────────────────────────────────

test('LAS inspection extras are carried through, keeping the first member', () => {
  // Two points in one voxel, two in a second — output is two centroids.
  const cloud = new PointCloud({
    positions: new Float32Array([0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 5.1, 5.1, 5.1, 5.2, 5.2, 5.2]),
    returnNumber: new Uint8Array([1, 2, 3, 4]),
    returnCount: new Uint8Array([2, 2, 4, 4]),
    pointSourceId: new Uint16Array([10, 11, 20, 21]),
    gpsTime: new Float64Array([100.5, 101.5, 200.5, 201.5]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'test',
  });
  const out = voxelDownsample(cloud, 1.0);
  expect(out.pointCount).toBe(2);
  // Each output array exists and matches the reduced point count.
  expect(out.returnNumber).toBeInstanceOf(Uint8Array);
  expect(out.returnNumber!.length).toBe(2);
  expect(out.gpsTime).toBeInstanceOf(Float64Array);
  // The first member's discrete metadata is kept (the contract classification uses).
  expect(Array.from(out.returnNumber!)).toEqual([1, 3]);
  expect(Array.from(out.returnCount!)).toEqual([2, 4]);
  expect(Array.from(out.pointSourceId!)).toEqual([10, 20]);
  expect(Array.from(out.gpsTime!)).toEqual([100.5, 200.5]);
});

test('a cloud with no inspection extras yields none after downsampling', () => {
  const out = voxelDownsample(makeCloud([0.1, 0.1, 0.1, 0.2, 0.2, 0.2]), 1.0);
  expect(out.returnNumber).toBeUndefined();
  expect(out.pointSourceId).toBeUndefined();
  expect(out.gpsTime).toBeUndefined();
});
