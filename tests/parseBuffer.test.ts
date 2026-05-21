import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pickLoader, parseBuffer } from '../src/io/parseBuffer';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): ArrayBuffer {
  const u8 = readFileSync(resolve(here, 'fixtures', name));
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

test('pickLoader returns a loader function for every supported format', () => {
  for (const format of ['ply', 'las', 'laz', 'obj', 'glb', 'gltf'] as const) {
    expect(typeof pickLoader(format)).toBe('function');
  }
});

test('pickLoader throws on an unknown format', () => {
  expect(() => pickLoader('unknown')).toThrow();
});

test('parseBuffer parses a PLY buffer into a PointCloud', async () => {
  const result = await parseBuffer(fixture('tiny.ply'), 'ply', 'tiny.ply');
  expect(result.cloud.pointCount).toBeGreaterThan(0);
  expect(result.downsampled).toBe(false);
  expect(result.originalPointCount).toBe(result.cloud.pointCount);
});

test('parseBuffer downsamples when a cloud exceeds the budget', async () => {
  // A deliberately tiny budget forces the 10-point fixture down the downsample path.
  const result = await parseBuffer(fixture('tiny.ply'), 'ply', 'tiny.ply', 4);
  expect(result.downsampled).toBe(true);
  expect(result.originalPointCount).toBeGreaterThan(result.cloud.pointCount);
});
