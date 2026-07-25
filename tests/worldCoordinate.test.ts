/**
 * worldCoordinate.test.ts — the world-coordinate accessor, step one of the
 * Float64 transform migration.
 *
 * `worldXYZ` reads `positions[i] + sourceOrigin`, the world coordinate by
 * construction — `sourceOrigin` is fixed for the object's life. When this
 * seam was cut, the destructive rebase could still move `origin`; step 5 of
 * the migration (docs/architecture/float64-transform.md) then removed the
 * rebase entirely, so neither term of the sum can ever change and the
 * accessor holds for every cloud, mounted or not. Placement into a project
 * frame is data beside the cloud (`projectXYZ`) and never enters this sum.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';

function cloudAt(origin: [number, number, number], positions: number[]): PointCloud {
  return new PointCloud({
    positions: Float32Array.from(positions),
    origin,
    sourceFormat: 'las',
    name: 'world.las',
  });
}

const ORIGIN: [number, number, number] = [500000, 4100000, 1500];

describe('PointCloud.worldXYZ', () => {
  it('returns source-local position plus the source origin', () => {
    const cloud = cloudAt(ORIGIN, [1, 2, 3, 4, 5, 6]);
    expect(cloud.worldXYZ(0)).toEqual([500001, 4100002, 1503]);
    expect(cloud.worldXYZ(1)).toEqual([500004, 4100005, 1506]);
  });

  it('agrees with the legacy positions-plus-origin formula', () => {
    // The migration invariant made explicit: swapping a consumer from
    // `positions + origin` to this accessor is a no-op, because the two
    // origins coincide for the object's life now that nothing moves `origin`.
    const cloud = cloudAt(ORIGIN, [7, 11, 13, -2, -4, -6]);
    for (const i of [0, 1]) {
      const viaOrigin: [number, number, number] = [
        cloud.positions[i * 3] + cloud.origin[0],
        cloud.positions[i * 3 + 1] + cloud.origin[1],
        cloud.positions[i * 3 + 2] + cloud.origin[2],
      ];
      expect(cloud.worldXYZ(i)).toEqual(viaOrigin);
    }
  });

  it('writes into a caller-supplied tuple to avoid per-point allocation', () => {
    const cloud = cloudAt(ORIGIN, [10, 20, 30]);
    const out: [number, number, number] = [0, 0, 0];
    const same = cloud.worldXYZ(0, out);
    expect(same).toBe(out);
    expect(out).toEqual([500010, 4100020, 1530]);
  });

  it('throws on an out-of-range index rather than returning silent garbage', () => {
    const cloud = cloudAt(ORIGIN, [1, 2, 3]);
    expect(() => cloud.worldXYZ(1)).toThrow();
    expect(() => cloud.worldXYZ(-1)).toThrow();
  });
});
