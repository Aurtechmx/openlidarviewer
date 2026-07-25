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
 * The cloud's own frame is fixed for its life.
 *
 * The in-place rebase these blocks used to exercise — the mechanism that
 * mounted a layer by rewriting every Float32 position and moving `origin` —
 * is retired (docs/architecture/float64-transform.md, step 5). Mounting is
 * now a Float64 placement held BESIDE the cloud, so the invariant flips:
 * nothing may move `origin`, and the world coordinate of a point is a
 * constant of the object, mounted or not.
 */
describe('PointCloud frame immutability', () => {
  const make = () =>
    new PointCloud({
      positions: Float32Array.from([0, 0, 0, 10, 20, 5]),
      origin: [500_000, 4_500_000, 100],
      sourceFormat: 'las',
      name: 'a.las',
    });

  it('exposes no method that could move the origin', () => {
    // The retired writers are gone from the class, not merely unused.
    const proto = Object.getOwnPropertyNames(PointCloud.prototype);
    expect(proto).not.toContain('rebaseOrigin');
    expect(proto).not.toContain('restoreSourceFrame');
  });

  it('origin equals sourceOrigin, always', () => {
    const c = make();
    expect([...c.origin]).toEqual([...c.sourceOrigin]);
    // Exercise the read surface; the two records still agree afterwards.
    c.bounds();
    c.worldXYZ(1);
    c.projectXYZ(1, { sourceToProject: [1000, 0, -20] });
    c.rebaseQuantum([499_000, 4_500_000, 80]);
    expect([...c.origin]).toEqual([500_000, 4_500_000, 100]);
    expect([...c.sourceOrigin]).toEqual([500_000, 4_500_000, 100]);
  });

  it('worldXYZ is a constant of the object', () => {
    const c = make();
    const before = c.worldXYZ(1);
    // A placement is data ABOUT the layer; deriving project coordinates from
    // one must leave the world coordinate untouched.
    c.projectXYZ(1, { sourceToProject: [12_345, -6_789, 42] });
    expect(c.worldXYZ(1)).toEqual(before);
    expect(before).toEqual([500_010, 4_500_020, 105]);
  });

  it('does not alias the caller’s origin array', () => {
    // The class no longer writes `origin`, but the caller still can — a
    // shared reference would let it rewrite the source record from outside.
    const origin: [number, number, number] = [501_000, 4_500_000, 100];
    const c = new PointCloud({ positions: Float32Array.from([0, 0, 0]), origin, sourceFormat: 'las', name: 'c.las' });
    origin[0] = 0;
    expect([...c.sourceOrigin]).toEqual([501_000, 4_500_000, 100]);
  });

  it('a placement round trip is the identity on everything the cloud stores', () => {
    // Mount and unmount are exact inverses because neither touches the cloud:
    // setting a transform, reading through it, and clearing it leaves
    // positions, bounds and both origins bit-identical.
    const c = make();
    const positionsBefore = c.positions.slice();
    const boundsBefore = c.bounds();
    c.projectXYZ(0, { sourceToProject: [1000, 2000, -20] });
    c.projectXYZ(0, { sourceToProject: [0, 0, 0] });
    expect(c.positions).toEqual(positionsBefore);
    expect(c.bounds()).toEqual(boundsBefore);
    expect([...c.origin]).toEqual([...c.sourceOrigin]);
  });
});

/**
 * A mount that would have cost real precision is disclosed, not hidden.
 *
 * This models the RETIRED in-place mechanism: writing a large offset into
 * Float32 positions consumes mantissa the residual was using — at a 100 km
 * separation a millimetre is simply gone. The placement mechanism never
 * writes the buffer, but the LayerService mount gates still read this figure
 * as a conservative admission rule until browser verification (step 6)
 * revisits them.
 */
describe('PointCloud.rebaseQuantum', () => {
  const make = (origin: [number, number, number]) =>
    new PointCloud({ positions: Float32Array.from([0, 0, 0]), origin, sourceFormat: 'las', name: 'd.las' });

  it('is sub-micron when a layer anchors on its own origin', () => {
    const c = make([2_485_000, 1_109_000, 330]);
    const q = c.rebaseQuantum([2_485_000, 1_109_000, 330]);
    expect(q.horizontal).toBeLessThan(1e-6);
    expect(q.vertical).toBeLessThan(1e-6);
  });

  it('grows with separation, not with absolute coordinate magnitude', () => {
    const near = make([2_485_000, 1_109_000, 330]).rebaseQuantum([2_484_000, 1_109_000, 330]);
    const far = make([600_000, 4_500_000, 0]).rebaseQuantum([500_000, 4_500_000, 0]);
    expect(near.horizontal).toBeLessThan(far.horizontal);
    expect(far.horizontal).toBeGreaterThanOrEqual(0.001); // 100 km costs a millimetre
  });

  // Horizontal and vertical units can differ (compound CRS), so the two costs
  // have to stay separable — collapsing them to one worst number meant a Z
  // step was later converted through the HORIZONTAL unit and under-reported.
  it('reports the X/Y worst and the Z cost separately', () => {
    // Moved 100 km in X, not at all in Z: the cost is horizontal only.
    const h = make([600_000, 4_500_000, 100]).rebaseQuantum([500_000, 4_500_000, 100]);
    expect(h.horizontal).toBeGreaterThanOrEqual(0.001);
    expect(h.vertical).toBeLessThan(1e-6);

    // Moved only in Z: the cost is vertical, and X/Y stay free.
    const v = make([600_000, 4_500_000, 100]).rebaseQuantum([600_000, 4_500_000, 100 - 20_000]);
    expect(v.vertical).toBeGreaterThan(0.001);
    expect(v.horizontal).toBeLessThan(1e-6);
  });
});
