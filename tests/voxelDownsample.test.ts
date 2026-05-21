import { voxelDownsample, voxelSizeForBudget } from '../src/process/voxelDownsample';
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
