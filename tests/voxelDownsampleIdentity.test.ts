import { describe, it, expect } from 'vitest';
import { voxelDownsample } from '../src/process/voxelDownsample';
import { voxelDownsampleReference } from './helpers/voxelDownsampleReference';
import { PointCloud } from '../src/model/PointCloud';

/**
 * The typed-array voxel pass must reproduce the earlier Map-based pass to the
 * byte: same voxels in the same first-seen order, the same double sums in the
 * same input order, the same rounding at emit. The reference is the earlier
 * code, kept verbatim under tests/helpers.
 */

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
}

interface Shape { n: number; box: [number, number, number]; offset?: [number, number, number]; colors?: boolean; extras?: boolean; nan?: boolean }

function make(seed: number, shape: Shape): PointCloud {
  const rnd = prng(seed);
  const { n } = shape;
  const positions = new Float32Array(n * 3);
  const off = shape.offset ?? [0, 0, 0];
  for (let i = 0; i < n; i++) {
    positions[i * 3] = off[0] + rnd() * shape.box[0];
    positions[i * 3 + 1] = off[1] + rnd() * shape.box[1];
    positions[i * 3 + 2] = off[2] + rnd() * shape.box[2];
  }
  if (shape.nan) {
    positions[3] = Number.NaN;
    positions[7] = Number.POSITIVE_INFINITY;
    positions[11] = Number.NEGATIVE_INFINITY;
  }
  const colors = shape.colors ? new Uint8Array(n * 3).map(() => Math.floor(rnd() * 256)) : undefined;
  const intensity = shape.colors ? new Uint16Array(n).map(() => Math.floor(rnd() * 65536)) : undefined;
  const extras = shape.extras
    ? {
        classification: new Uint8Array(n).map(() => Math.floor(rnd() * 8)),
        returnNumber: new Uint8Array(n).map(() => 1 + Math.floor(rnd() * 3)),
        returnCount: new Uint8Array(n).map(() => 3),
        pointSourceId: new Uint16Array(n).map(() => Math.floor(rnd() * 100)),
        gpsTime: new Float64Array(n).map(() => 1e9 + rnd() * 1e5),
      }
    : {};
  return new PointCloud({ positions, colors, intensity, ...extras, origin: [1, 2, 3], sourceFormat: 'laz', name: 'v' });
}

const bytes = (a: ArrayBufferView | undefined): Buffer | undefined =>
  a && Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function expectIdentical(a: PointCloud, b: PointCloud, label: string): void {
  expect(a.pointCount, label).toBe(b.pointCount);
  for (const key of ['positions', 'colors', 'intensity', 'classification', 'returnNumber', 'returnCount', 'pointSourceId', 'gpsTime'] as const) {
    const x = a[key] as ArrayBufferView | undefined;
    const y = b[key] as ArrayBufferView | undefined;
    expect(x === undefined, `${label} ${key} presence`).toBe(y === undefined);
    if (x && y) {
      expect(x.constructor, `${label} ${key} type`).toBe(y.constructor);
      expect(Buffer.compare(bytes(x)!, bytes(y)!), `${label} ${key} bytes`).toBe(0);
    }
  }
  expect(a.origin).toEqual(b.origin);
  expect(a.name).toBe(b.name);
}

describe('voxelDownsample: typed accumulator is byte-identical to the Map-based pass', () => {
  const shapes: Array<[string, Shape]> = [
    ['random volume', { n: 60_000, box: [300, 300, 20] }],
    ['surface, colours, extras', { n: 50_000, box: [400, 400, 2], colors: true, extras: true }],
    ['volume with non-finite points', { n: 5_000, box: [50, 50, 50], nan: true, extras: true }],
    ['single voxel collapse', { n: 2_000, box: [0.01, 0.01, 0.01], colors: true }],
    ['far offset: string-key overflow mixed with in-range points', { n: 4_000, box: [200_000, 10, 10], offset: [-100_000, 0, 0], extras: true }],
    ['negative coordinates around the key-zero voxel', { n: 8_000, box: [6, 6, 6], offset: [-3, -3, -3], colors: true }],
  ];
  it('matches across shapes, attribute sets and voxel sizes, including slot growth', () => {
    for (const [name, shape] of shapes) {
      const cloud = make(7, shape);
      for (const size of [0.5, 1, 2.5, 8]) {
        expectIdentical(voxelDownsample(cloud, size), voxelDownsampleReference(cloud, size), `${name} @ ${size}`);
      }
    }
  });

  it('grows past its initial slot capacity without renumbering a voxel', () => {
    // More distinct voxels than the initial slot capacity: every point alone.
    const n = 70_000;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { positions[i * 3] = (i % 400) * 3; positions[i * 3 + 1] = Math.floor(i / 400) * 3; positions[i * 3 + 2] = 0; }
    const cloud = new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'grid' });
    expectIdentical(voxelDownsample(cloud, 1), voxelDownsampleReference(cloud, 1), 'growth');
    expect(voxelDownsample(cloud, 1).pointCount).toBe(n);
  });
});
