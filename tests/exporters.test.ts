import { toXyz, toCsv, toPly, toObj, exportCloud } from '../src/io/exporters';
import { loadXyz } from '../src/io/loadXyz';
import { PointCloud } from '../src/model/PointCloud';

function makeCloud(positions: number[], origin: [number, number, number], colors?: number[]): PointCloud {
  return new PointCloud({
    positions: new Float32Array(positions),
    colors: colors ? new Uint8Array(colors) : undefined,
    origin,
    sourceFormat: 'xyz',
    name: 'test',
  });
}

describe('toXyz / toCsv', () => {
  test('writes global coordinates (local position + origin)', () => {
    const cloud = makeCloud([0, 0, 0, 1, 2, 3], [100, 200, 300]);
    const text = toXyz(cloud);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('100.000 200.000 300.000');
    expect(lines[1]).toBe('101.000 202.000 303.000');
  });

  test('includes r g b columns when the cloud has colour', () => {
    const cloud = makeCloud([0, 0, 0], [0, 0, 0], [255, 128, 0]);
    expect(toXyz(cloud).trim()).toBe('0.000 0.000 0.000 255 128 0');
  });

  test('CSV is comma-delimited with a header row', () => {
    const cloud = makeCloud([0, 0, 0, 1, 1, 1], [0, 0, 0]);
    const lines = toCsv(cloud).trim().split('\n');
    expect(lines[0]).toBe('x,y,z');
    expect(lines[1]).toBe('0.000,0.000,0.000');
  });
});

describe('toPly', () => {
  test('writes a valid ASCII PLY header with the vertex count', () => {
    const cloud = makeCloud([0, 0, 0, 1, 1, 1], [0, 0, 0]);
    const text = toPly(cloud);
    expect(text.startsWith('ply\nformat ascii 1.0')).toBe(true);
    expect(text).toContain('element vertex 2');
    expect(text).toContain('end_header');
  });

  test('declares colour properties only when colour is present', () => {
    expect(toPly(makeCloud([0, 0, 0], [0, 0, 0]))).not.toContain('property uchar red');
    expect(toPly(makeCloud([0, 0, 0], [0, 0, 0], [1, 2, 3]))).toContain('property uchar red');
  });
});

describe('toObj', () => {
  test('writes one v line per point', () => {
    const cloud = makeCloud([0, 0, 0, 5, 5, 5], [10, 0, 0]);
    const vLines = toObj(cloud).split('\n').filter((l) => l.startsWith('v '));
    expect(vLines).toHaveLength(2);
    expect(vLines[0]).toBe('v 10.000 0.000 0.000');
  });
});

describe('exportCloud + round-trip', () => {
  test('exportCloud dispatches by format', () => {
    const cloud = makeCloud([0, 0, 0], [0, 0, 0]);
    expect(exportCloud(cloud, 'ply').startsWith('ply')).toBe(true);
    expect(exportCloud(cloud, 'obj').startsWith('#')).toBe(true);
  });

  test('XYZ export re-imports to the same global coordinates', async () => {
    const cloud = makeCloud([0.5, 1.5, 2.5, 3, 4, 5], [500000, 4100000, 100], [10, 20, 30, 40, 50, 60]);
    const text = toXyz(cloud);
    const reloaded = await loadXyz(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(reloaded.pointCount).toBe(2);
    // Global coordinate of the first point survives the round-trip.
    expect(reloaded.positions[0] + reloaded.origin[0]).toBeCloseTo(500000.5, 2);
    expect(reloaded.positions[1] + reloaded.origin[1]).toBeCloseTo(4100001.5, 2);
    expect(reloaded.colors?.[0]).toBe(10);
  });
});
