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
});
