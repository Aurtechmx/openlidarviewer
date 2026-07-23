/**
 * worldCoordinate.test.ts — the world-coordinate accessor, step one of the
 * Float64 transform migration.
 *
 * Consumers that want a point's world position today write `positions[i] +
 * origin`. That works only because `origin === sourceOrigin` for every loaded
 * cloud: multi-layer mounting is disabled, so no cloud is ever rebased, so the
 * live origin still equals the file's origin. When the migration makes
 * `rebaseOrigin` stop rewriting the Float32 buffer, `origin` will move while
 * `positions` stay source-local, and `positions + origin` will be wrong.
 *
 * `worldXYZ` reads `positions[i] + sourceOrigin`, the world coordinate by
 * construction — `sourceOrigin` is fixed for the object's life. Today that
 * equals `positions + origin` (the two origins agree), so migrating a consumer
 * onto it changes nothing observable now and makes it correct once the rebase
 * is non-destructive. This is the seam every world-coordinate consumer will
 * move onto, in gated batches, before the rebase itself is flipped.
 *
 * The rebase-invariance property — that a mounted cloud's world coordinate does
 * not move with its project origin — is the POINT of the migration and is
 * proved with the flip, not here: against today's destructive rebase, which
 * rewrites `positions`, it does not yet hold. So these tests assert only what
 * is true now: the accessor equals the world coordinate for an unrebased cloud.
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

  it('agrees with the current positions-plus-origin formula on an unrebased cloud', () => {
    // The migration invariant made explicit: swapping a consumer from
    // `positions + origin` to this accessor is a no-op today, because the two
    // origins coincide until a (disabled) rebase moves them apart.
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
