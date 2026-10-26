import { describe, it, expect } from 'vitest';
import { downsampleToBudgetReport, voxelDownsample, countVoxels } from '../src/process/voxelDownsample';
import { PointCloud } from '../src/model/PointCloud';

/**
 * The budget search reads only a point count from each step, so the steps
 * count voxels instead of building clouds. The cloud it returns, the voxel
 * size and the pass count must stay what the build-every-step search gave,
 * to the byte. That search returned the cloud built at its final size, so
 * the pass count and size it settled on, recorded below, pin all three.
 */

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
}

interface Shape { n: number; box: [number, number, number]; offset?: [number, number, number]; attrs?: boolean; nan?: boolean; strip?: boolean }

function make(seed: number, shape: Shape): PointCloud {
  const rnd = prng(seed);
  const { n } = shape;
  const positions = new Float32Array(n * 3);
  const off = shape.offset ?? [0, 0, 0];
  for (let i = 0; i < n; i++) {
    // A strip fills a diagonal band of its bounding box, so the first estimate lands far under budget.
    const t = rnd();
    positions[i * 3] = off[0] + t * shape.box[0];
    positions[i * 3 + 1] = off[1] + (shape.strip ? t * shape.box[1] + rnd() * 2 : rnd() * shape.box[1]);
    positions[i * 3 + 2] = off[2] + rnd() * shape.box[2];
  }
  if (shape.nan) {
    positions[3] = Number.NaN;
    positions[7] = Number.POSITIVE_INFINITY;
  }
  const attrs = shape.attrs
    ? {
        colors: new Uint8Array(n * 3).map(() => Math.floor(rnd() * 256)),
        intensity: new Uint16Array(n).map(() => Math.floor(rnd() * 65536)),
        classification: new Uint8Array(n).map(() => Math.floor(rnd() * 8)),
        returnNumber: new Uint8Array(n).map(() => 1 + Math.floor(rnd() * 3)),
        returnCount: new Uint8Array(n).map(() => 3),
        pointSourceId: new Uint16Array(n).map(() => Math.floor(rnd() * 100)),
        gpsTime: new Float64Array(n).map(() => 1e9 + rnd() * 1e5),
      }
    : {};
  return new PointCloud({ positions, ...attrs, origin: [1, 2, 3], sourceFormat: 'laz', name: 'b' });
}

const bytes = (a: ArrayBufferView): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function expectIdentical(a: PointCloud, b: PointCloud, label: string): void {
  expect(a.pointCount, label).toBe(b.pointCount);
  for (const key of ['positions', 'colors', 'intensity', 'classification', 'returnNumber', 'returnCount', 'pointSourceId', 'gpsTime'] as const) {
    const x = a[key] as ArrayBufferView | undefined;
    const y = b[key] as ArrayBufferView | undefined;
    expect(x === undefined, `${label} ${key} presence`).toBe(y === undefined);
    if (x && y) expect(Buffer.compare(bytes(x), bytes(y)), `${label} ${key} bytes`).toBe(0);
  }
  expect(a.origin).toEqual(b.origin);
}

const shapes: Array<[string, Shape]> = [
  ['random volume', { n: 40_000, box: [300, 300, 20] }],
  ['surface with every attribute', { n: 30_000, box: [400, 400, 2], attrs: true }],
  ['diagonal strip', { n: 30_000, box: [500, 500, 1], strip: true }],
  ['non-finite points', { n: 6_000, box: [50, 50, 50], nan: true, attrs: true }],
  ['far offset with string keys', { n: 6_000, box: [200_000, 10, 10], offset: [-100_000, 0, 0] }],
];

/**
 * Pass count, voxel size and point count the build-every-step search (each
 * step built the full voxel cloud and read its point count) returned for
 * each case below, seed 5. Recorded from that search before it was replaced.
 */
const BUILD_EVERY_STEP: Record<string, readonly [number, number, number]> = {
  'random volume @ 0.02': [2, 16.60187380934845, 716],
  'random volume @ 0.1': [4, 8.560749237083753, 3742],
  'random volume @ 0.33': [3, 5.900965904088244, 9888],
  'random volume @ 0.6': [4, 4.39108505752773, 18995],
  'random volume @ 0.95': [2, 2.0276540666676306, 36466],
  'surface with every attribute @ 0.02': [1, 17.21215889868449, 576],
  'surface with every attribute @ 0.1': [1, 7.697511467397286, 2704],
  'surface with every attribute @ 0.33': [1, 4.237340603624526, 8660],
  'surface with every attribute @ 0.6': [1, 3.1424958973909236, 13672],
  'surface with every attribute @ 0.95': [1, 2.497402498823058, 17757],
  'diagonal strip @ 0.02': [4, 2.655407340074569, 377],
  'diagonal strip @ 0.1': [5, 0.9276592815016333, 2936],
  'diagonal strip @ 0.33': [3, 0.5787205207484287, 7388],
  'diagonal strip @ 0.6': [3, 0.3917452631062826, 16016],
  'diagonal strip @ 0.95': [2, 0.35942563359309815, 17559],
  'non-finite points @ 0.02': [4, 12.772180986159572, 64],
  'non-finite points @ 0.1': [2, 6.4543355698821685, 512],
  'non-finite points @ 0.33': [4, 4.724985607668746, 1302],
  'non-finite points @ 0.6': [5, 2.9439333332707913, 3453],
  'non-finite points @ 0.95': [3, 1.745052481001859, 5288],
  'far offset with string keys @ 0.02': [5, 1696.7487790508735, 118],
  'far offset with string keys @ 0.1': [5, 388.77144646271415, 516],
  'far offset with string keys @ 0.33': [5, 109.59927180061344, 1767],
  'far offset with string keys @ 0.6': [3, 62.099343284099916, 2742],
  'far offset with string keys @ 0.95': [1, 19.740621487747237, 4515],
};

describe('downsampleToBudget: count-only search steps', () => {
  it('countVoxels equals the point count voxelDownsample builds', () => {
    for (const [name, shape] of shapes) {
      const cloud = make(11, shape);
      for (const size of [0.01, 0.5, 1, 3.7, 40, 1e6]) {
        expect(countVoxels(cloud, size), `${name} @ ${size}`).toBe(voxelDownsample(cloud, size).pointCount);
      }
    }
  });

  it('returns the same cloud, voxel size and pass count as building every step', () => {
    for (const [name, shape] of shapes) {
      const cloud = make(5, shape);
      for (const fraction of [0.02, 0.1, 0.33, 0.6, 0.95]) {
        const budget = Math.max(1, Math.floor(shape.n * fraction));
        const got = downsampleToBudgetReport(cloud, budget);
        const label = `${name} @ ${fraction}`;
        const [passes, voxelSize, pointCount] = BUILD_EVERY_STEP[label]!;
        expect(got.passes, label).toBe(passes);
        expect(got.voxelSize, label).toBe(voxelSize);
        expect(got.cloud.pointCount, label).toBe(pointCount);
        expectIdentical(got.cloud, voxelDownsample(cloud, voxelSize), label);
      }
    }
  });

  it('rejects a zero voxel size the same way voxelDownsample does', () => {
    const cloud = make(1, shapes[0]![1]);
    expect(() => countVoxels(cloud, 0)).toThrow(RangeError);
  });
});
