import { PointCloud } from '../src/model/PointCloud';

function makeBasicCloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([
      0, 0, 0,
      1, 2, 3,
      -1, 5, 2,
      4, -3, 1,
    ]),
    origin: [500000, 4100000, 200],
    sourceFormat: 'las',
    name: 'tiny.las',
  });
}

describe('PointCloud — construction', () => {
  test('stores the provided fields', () => {
    const pc = makeBasicCloud();
    expect(pc.name).toBe('tiny.las');
    expect(pc.sourceFormat).toBe('las');
    expect(pc.positions).toBeInstanceOf(Float32Array);
  });

  test('origin round-trips unchanged', () => {
    const pc = makeBasicCloud();
    expect(pc.origin).toEqual([500000, 4100000, 200]);
  });

  test('optional attributes default to undefined', () => {
    const pc = makeBasicCloud();
    expect(pc.colors).toBeUndefined();
    expect(pc.intensity).toBeUndefined();
    expect(pc.classification).toBeUndefined();
    expect(pc.declaredPointCount).toBeUndefined();
  });

  test('optional attributes are stored when provided', () => {
    const pc = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      colors: new Uint8Array([255, 0, 0, 0, 255, 0]),
      intensity: new Uint16Array([10, 20]),
      classification: new Uint8Array([2, 3]),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'tiny.ply',
      declaredPointCount: 2,
    });
    expect(pc.colors).toEqual(new Uint8Array([255, 0, 0, 0, 255, 0]));
    expect(pc.intensity).toEqual(new Uint16Array([10, 20]));
    expect(pc.classification).toEqual(new Uint8Array([2, 3]));
    expect(pc.declaredPointCount).toBe(2);
  });
});

describe('PointCloud — attribute-length validation', () => {
  const base = {
    positions: new Float32Array([0, 0, 0, 1, 1, 1]), // 2 points
    origin: [0, 0, 0] as [number, number, number],
    sourceFormat: 'las' as const,
    name: 't.las',
  };

  test('rejects positions not divisible by 3', () => {
    expect(
      () => new PointCloud({ ...base, positions: new Float32Array([0, 0, 0, 1, 1]) }),
    ).toThrow(/divisible by 3/);
  });

  test('rejects a colors array that is not 3× the point count', () => {
    expect(
      () => new PointCloud({ ...base, colors: new Uint8Array([255, 0, 0]) }), // 1 point of rgb, need 2
    ).toThrow(/colors length 3 does not match 6/);
  });

  test('rejects a classification array shorter than the point count', () => {
    expect(
      () => new PointCloud({ ...base, classification: new Uint8Array([2]) }), // need 2
    ).toThrow(/classification length 1 does not match 2/);
  });

  test('rejects mismatched intensity / returns / source-id / gps-time', () => {
    expect(() => new PointCloud({ ...base, intensity: new Uint16Array([1]) })).toThrow(/intensity/);
    expect(() => new PointCloud({ ...base, returnNumber: new Uint8Array([1]) })).toThrow(/returnNumber/);
    expect(() => new PointCloud({ ...base, pointSourceId: new Uint16Array([1]) })).toThrow(/pointSourceId/);
    expect(() => new PointCloud({ ...base, gpsTime: new Float64Array([1]) })).toThrow(/gpsTime/);
  });

  test('accepts correctly-sized attributes (no false positives)', () => {
    expect(
      () =>
        new PointCloud({
          ...base,
          colors: new Uint8Array([1, 2, 3, 4, 5, 6]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1]),
          intensity: new Uint16Array([10, 20]),
          classification: new Uint8Array([2, 2]),
          gpsTime: new Float64Array([1, 2]),
        }),
    ).not.toThrow();
  });
});

describe('PointCloud — pointCount getter', () => {
  test('returns positions.length / 3', () => {
    expect(makeBasicCloud().pointCount).toBe(4);
  });

  test('is zero for an empty cloud', () => {
    const pc = new PointCloud({
      positions: new Float32Array([]),
      origin: [0, 0, 0],
      sourceFormat: 'obj',
      name: 'empty.obj',
    });
    expect(pc.pointCount).toBe(0);
  });
});

describe('PointCloud — bounds()', () => {
  test('computes local min/max over all positions', () => {
    const { min, max } = makeBasicCloud().bounds();
    expect(min).toEqual([-1, -3, 0]);
    expect(max).toEqual([4, 5, 3]);
  });

  test('single-point cloud has min equal to max', () => {
    const pc = new PointCloud({
      positions: new Float32Array([7, 8, 9]),
      origin: [0, 0, 0],
      sourceFormat: 'glb',
      name: 'one.glb',
    });
    expect(pc.bounds()).toEqual({ min: [7, 8, 9], max: [7, 8, 9] });
  });

  test('a non-finite coordinate cannot blow the box out to infinity', () => {
    // One good point plus a malformed point with +Infinity and NaN — the box
    // must span only the finite point, never reach Infinity (which would make
    // the camera frame to nothing).
    const pc = new PointCloud({
      positions: new Float32Array([2, 3, 4, Infinity, NaN, -Infinity]),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'bad.ply',
    });
    const b = pc.bounds();
    expect(b).toEqual({ min: [2, 3, 4], max: [2, 3, 4] });
    expect(b.min.every(Number.isFinite) && b.max.every(Number.isFinite)).toBe(true);
  });

  test('an all-non-finite cloud collapses to a finite degenerate box', () => {
    const pc = new PointCloud({
      positions: new Float32Array([Infinity, NaN, -Infinity]),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'worse.ply',
    });
    expect(pc.bounds()).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });
});

/**
 * Origin rebase — the mechanism that mounts a layer into the shared project
 * frame at the DATA level.
 *
 * The first mount implementation translated the MESH instead, which split the
 * scene in two: rendering and camera bounds saw project space while picking
 * (`nearestPointAlongRay` over raw positions), terrain gather, lasso, profiles,
 * volumes and export bounds all still read cloud-local coordinates — layers
 * LOOKED aligned while every calculation used a different frame. Rebasing the
 * positions themselves makes every consumer of `cloud.positions` project-local
 * automatically, and keeps the world invariant exact: local + origin is the
 * same point before and after.
 */
describe('PointCloud.rebaseOrigin', () => {
  const make = () =>
    new PointCloud({
      positions: Float32Array.from([0, 0, 0, 10, 20, 5]),
      origin: [500_000, 4_500_000, 100],
      sourceFormat: 'las',
      name: 'a.las',
    });

  it('keeps every point at the same WORLD position', () => {
    const c = make();
    const worldBefore = [c.positions[3] + c.origin[0], c.positions[4] + c.origin[1], c.positions[5] + c.origin[2]];
    c.rebaseOrigin([499_000, 4_500_000, 80]);
    const worldAfter = [c.positions[3] + c.origin[0], c.positions[4] + c.origin[1], c.positions[5] + c.origin[2]];
    expect(worldAfter).toEqual(worldBefore);
  });

  it('shifts the local positions by the origin delta', () => {
    const c = make();
    c.rebaseOrigin([499_000, 4_500_000, 80]);
    expect([...c.positions.slice(0, 3)]).toEqual([1000, 0, 20]);
    expect(c.origin).toEqual([499_000, 4_500_000, 80]);
  });

  it('keeps bounds() consistent with the shifted positions', () => {
    const c = make();
    const before = c.bounds(); // prime the cache — the stale-cache case is the trap
    c.rebaseOrigin([499_000, 4_500_000, 80]);
    const after = c.bounds();
    expect(after.min).toEqual([before.min[0] + 1000, before.min[1], before.min[2] + 20]);
    expect(after.max).toEqual([before.max[0] + 1000, before.max[1], before.max[2] + 20]);
  });

  it('returns false and touches nothing for an identity rebase', () => {
    const c = make();
    expect(c.rebaseOrigin([500_000, 4_500_000, 100])).toBe(false);
    expect([...c.positions.slice(0, 3)]).toEqual([0, 0, 0]);
  });

  it('returns true when it moved', () => {
    expect(make().rebaseOrigin([499_000, 4_500_000, 80])).toBe(true);
  });
});

/**
 * The file frame survives project membership.
 *
 * `rebaseOrigin` overwrote `origin` in place, so once a layer joined the
 * project frame there was no record of where its file said it was. A layer
 * whose CRS was later overridden to something incompatible stayed parked on
 * the project origin with no way back, and source-coordinate export,
 * provenance, session restore and audit all had nothing true to read.
 */
describe('PointCloud source frame', () => {
  const make = () =>
    new PointCloud({
      positions: Float32Array.from([0, 0, 0, 10, 20, 5]),
      origin: [501_000, 4_500_000, 100],
      sourceFormat: 'las',
      name: 'b.las',
    });

  it('remembers the file origin after a rebase', () => {
    const c = make();
    c.rebaseOrigin([500_000, 4_500_000, 80]);
    expect(c.origin).toEqual([500_000, 4_500_000, 80]);
    expect(c.sourceOrigin).toEqual([501_000, 4_500_000, 100]);
  });

  it('does not alias the caller’s origin array', () => {
    // `origin` is mutated in place, so a shared reference would let the
    // rebase quietly rewrite the source origin too — the exact bug this
    // field exists to prevent.
    const origin: [number, number, number] = [501_000, 4_500_000, 100];
    const c = new PointCloud({ positions: Float32Array.from([0, 0, 0]), origin, sourceFormat: 'las', name: 'c.las' });
    c.rebaseOrigin([500_000, 4_500_000, 80]);
    expect(c.sourceOrigin).toEqual([501_000, 4_500_000, 100]);
  });

  it('reports whether it currently sits in a foreign frame', () => {
    const c = make();
    expect(c.isRebased).toBe(false);
    c.rebaseOrigin([500_000, 4_500_000, 80]);
    expect(c.isRebased).toBe(true);
  });

  it('returns to the file frame on demand', () => {
    // The reproduction from the audit: a layer rebased into the project and
    // then found incompatible must be able to go home.
    const c = make();
    const before = Array.from(c.positions);
    c.rebaseOrigin([500_000, 4_500_000, 80]);
    expect(c.restoreSourceFrame()).toBe(true);
    expect(c.origin).toEqual([501_000, 4_500_000, 100]);
    expect(Array.from(c.positions)).toEqual(before);
    expect(c.isRebased).toBe(false);
  });

  it('restoring an unrebased cloud is a no-op', () => {
    expect(make().restoreSourceFrame()).toBe(false);
  });

  it('keeps world positions identical across a round trip', () => {
    const c = make();
    const world = (i: number) => [
      c.positions[i] + c.origin[0], c.positions[i + 1] + c.origin[1], c.positions[i + 2] + c.origin[2],
    ];
    const before = world(3);
    c.rebaseOrigin([500_000, 4_500_000, 80]);
    c.restoreSourceFrame();
    expect(world(3)).toEqual(before);
  });
});

/**
 * A rebase that would cost real precision is disclosed, not hidden.
 *
 * Positions are Float32, so writing a large offset into them consumes
 * mantissa the residual was using: at a 100 km separation a millimetre is
 * simply gone. That is bounded by how far apart the layers are, not by the
 * absolute coordinate — a lone georeferenced scan anchors on its own origin
 * and loses nothing — but the far case must be visible rather than silent.
 */
describe('PointCloud.rebaseQuantum', () => {
  const make = (origin: [number, number, number]) =>
    new PointCloud({ positions: Float32Array.from([0, 0, 0]), origin, sourceFormat: 'las', name: 'd.las' });

  it('is sub-micron when a layer anchors on its own origin', () => {
    const c = make([2_485_000, 1_109_000, 330]);
    expect(c.rebaseQuantum([2_485_000, 1_109_000, 330])).toBeLessThan(1e-6);
  });

  it('grows with separation, not with absolute coordinate magnitude', () => {
    const near = make([2_485_000, 1_109_000, 330]).rebaseQuantum([2_484_000, 1_109_000, 330]);
    const far = make([600_000, 4_500_000, 0]).rebaseQuantum([500_000, 4_500_000, 0]);
    expect(near).toBeLessThan(far);
    expect(far).toBeGreaterThanOrEqual(0.001); // 100 km costs a millimetre
  });
});
