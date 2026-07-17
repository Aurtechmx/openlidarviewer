import { computeOrigin, recenter, resolveSceneOrigin } from '../src/io/coordinateBridge';

describe('computeOrigin', () => {
  test('floors each component', () => {
    expect(computeOrigin([500123.4, 4100876.7, 210.2])).toEqual([500123, 4100876, 210]);
  });

  test('floors negative components toward negative infinity', () => {
    expect(computeOrigin([-1.2, -0.5, 3.9])).toEqual([-2, -1, 3]);
  });

  test('integers are unchanged', () => {
    expect(computeOrigin([10, 20, 30])).toEqual([10, 20, 30]);
  });
});

describe('recenter', () => {
  test('subtracts the origin from interleaved xyz coordinates', () => {
    const coords = new Float64Array([500123.456, 4100876.789, 210.25]);
    const origin: [number, number, number] = [500123, 4100876, 210];
    const out = recenter(coords, origin);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out[0]).toBeCloseTo(0.456, 3);
    expect(out[1]).toBeCloseTo(0.789, 3);
    expect(out[2]).toBeCloseTo(0.25, 3);
  });

  test('cycles the origin across multiple points', () => {
    const coords = new Float64Array([
      500123.0, 4100876.0, 210.0,
      500125.0, 4100878.0, 212.0,
    ]);
    const origin: [number, number, number] = [500123, 4100876, 210];
    const out = recenter(coords, origin);
    expect(out[0]).toBeCloseTo(0, 3);
    expect(out[1]).toBeCloseTo(0, 3);
    expect(out[2]).toBeCloseTo(0, 3);
    expect(out[3]).toBeCloseTo(2, 3);
    expect(out[4]).toBeCloseTo(2, 3);
    expect(out[5]).toBeCloseTo(2, 3);
  });

  test('preserves relative geometry of large UTM coordinates within 1e-3', () => {
    const a: [number, number, number] = [500100.125, 4100200.875, 305.5];
    const b: [number, number, number] = [500107.625, 4100211.375, 318.25];
    const coords = new Float64Array([...a, ...b]);
    const origin = computeOrigin(a);
    const out = recenter(coords, origin);

    const dxOrig = b[0] - a[0];
    const dyOrig = b[1] - a[1];
    const dzOrig = b[2] - a[2];
    expect(out[3] - out[0]).toBeCloseTo(dxOrig, 3);
    expect(out[4] - out[1]).toBeCloseTo(dyOrig, 3);
    expect(out[5] - out[2]).toBeCloseTo(dzOrig, 3);
  });
});

describe('resolveSceneOrigin', () => {
  const A: [number, number, number] = [514233, 2105887, 830];
  const B: [number, number, number] = [514233, 2105887, 0];

  test('one cloud gives its own origin', () => {
    expect(resolveSceneOrigin([A])).toEqual(A);
  });

  test('clouds that agree give the origin they share', () => {
    expect(resolveSceneOrigin([A, [...A], [...A]])).toEqual(A);
  });

  test('clouds that disagree resolve to no origin at all', () => {
    // Each cloud is recentred on its OWN floor(min), so two files can differ.
    // Nothing then describes the scene: picking either one would hand cloud A's
    // frame to points that were never in it.
    expect(resolveSceneOrigin([A, B])).toBeNull();
  });

  test('the answer does not depend on load order', () => {
    // The bug this replaces: whichever cloud loaded LAST became the frame, so
    // the same scene resolved differently depending on the order of two clicks.
    expect(resolveSceneOrigin([A, B])).toBe(resolveSceneOrigin([B, A]));
    expect(resolveSceneOrigin([A, [...A]])).toEqual(resolveSceneOrigin([[...A], A]));
  });

  test('a disagreement on any single axis is a disagreement', () => {
    expect(resolveSceneOrigin([A, [A[0] + 1, A[1], A[2]]])).toBeNull();
    expect(resolveSceneOrigin([A, [A[0], A[1] + 1, A[2]]])).toBeNull();
  });

  test('an empty scene has no origin to assert', () => {
    expect(resolveSceneOrigin([])).toBeNull();
  });

  test('a cloud with no origin at all makes the scene unresolvable', () => {
    expect(resolveSceneOrigin([A, null])).toBeNull();
    expect(resolveSceneOrigin([null])).toBeNull();
  });
});
