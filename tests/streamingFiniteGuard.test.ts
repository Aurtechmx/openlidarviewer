/**
 * streamingFiniteGuard.test.ts
 *
 * The streaming decoders must never hand a non-finite coordinate to the GPU.
 * sanitizeCloud cleans file-loaded clouds but by contract leaves streaming node
 * buffers alone, so the guard lives in the decoders themselves: a non-finite
 * transform (bad header scale/offset or render origin) or a float X/Y/Z NaN in
 * an EPT tile must refuse the node with a structured malformed-file error, not
 * emit NaN.
 */

import { test, expect } from 'vitest';
import {
  assertFiniteNodeTransform,
  assertFinitePositions,
} from '../src/io/streamingFiniteGuard';
import { decodeRecords, type ChunkDecodeMetadata } from '../src/io/copc/copcChunkDecode';
import { decodeEptBinaryTile } from '../src/io/ept/eptBinaryDecode';
import { LoadError } from '../src/io/loadErrors';
import type { EptSchemaField } from '../src/io/ept/eptTypes';

function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

// ── The pure guard ──────────────────────────────────────────────────────────

test('assertFiniteNodeTransform passes a finite transform and refuses a non-finite one', () => {
  expect(() => assertFiniteNodeTransform([0.01, 0.01, 0.01], [100, 200, 0], [10, 20, 0])).not.toThrow();
  for (const bad of [NaN, Infinity, -Infinity]) {
    const err = caught(() => assertFiniteNodeTransform([0.01, bad, 0.01], [0, 0, 0], [0, 0, 0]));
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
  }
  // A bad render origin is caught too — the most likely real-world source.
  const err = caught(() => assertFiniteNodeTransform([1, 1, 1], [0, 0, 0], [NaN, 0, 0]));
  expect(err).toBeInstanceOf(LoadError);
});

test('assertFinitePositions passes clean positions and refuses a NaN, naming the point', () => {
  expect(() => assertFinitePositions(Float32Array.from([0, 0, 0, 1, 2, 3]))).not.toThrow();
  // Point 1's Y is non-finite.
  const err = caught(() => assertFinitePositions(Float32Array.from([0, 0, 0, 4, NaN, 6])));
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
  expect((err as LoadError).message).toMatch(/point 1/);
});

// ── COPC / EPT-laszip path (integer source: transform check is complete) ──────

/** One raw PDRF-6 record with a settable xyz. */
function oneRecord(x = 0, y = 0, z = 0): Uint8Array {
  const buf = new Uint8Array(30);
  const view = new DataView(buf.buffer);
  view.setInt32(0, x, true);
  view.setInt32(4, y, true);
  view.setInt32(8, z, true);
  return buf;
}

const META6 = (over: Partial<ChunkDecodeMetadata> = {}): ChunkDecodeMetadata => ({
  pointDataRecordFormat: 6,
  pointRecordLength: 30,
  pointCount: 1,
  scale: [0.01, 0.01, 0.01],
  offset: [0, 0, 0],
  renderOrigin: [0, 0, 0],
  ...over,
});

test('decodeRecords refuses a node whose scale is non-finite', () => {
  const err = caught(() => decodeRecords(oneRecord(1000, 2000, 3000), META6({ scale: [NaN, 0.01, 0.01] })));
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
});

test('decodeRecords refuses a node whose render origin is non-finite', () => {
  const err = caught(() => decodeRecords(oneRecord(1, 1, 1), META6({ renderOrigin: [0, Infinity, 0] })));
  expect(err).toBeInstanceOf(LoadError);
});

test('decodeRecords still decodes a finite node unchanged (regression)', () => {
  const d = decodeRecords(oneRecord(1000, 2000, 3000), META6());
  expect(d.pointCount).toBe(1);
  expect(d.positions[0]).toBeCloseTo(10);
  expect(Number.isFinite(d.positions[0])).toBe(true);
});

// ── EPT binary path (float source can carry a literal NaN) ───────────────────

const XYZ_F32: EptSchemaField[] = [
  { name: 'X', size: 4, type: 'float' },
  { name: 'Y', size: 4, type: 'float' },
  { name: 'Z', size: 4, type: 'float' },
];

function f32Tile(x: number, y: number, z: number): ArrayBuffer {
  const buf = new ArrayBuffer(12);
  const view = new DataView(buf);
  view.setFloat32(0, x, true);
  view.setFloat32(4, y, true);
  view.setFloat32(8, z, true);
  return buf;
}

test('decodeEptBinaryTile refuses a tile whose float X/Y/Z carries a NaN', () => {
  const err = caught(() => decodeEptBinaryTile(f32Tile(NaN, 2, 3), 1, XYZ_F32, [0, 0, 0]));
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
});

test('decodeEptBinaryTile refuses a tile whose render origin is non-finite', () => {
  const err = caught(() => decodeEptBinaryTile(f32Tile(1, 2, 3), 1, XYZ_F32, [Infinity, 0, 0]));
  expect(err).toBeInstanceOf(LoadError);
});

test('decodeEptBinaryTile decodes a finite float tile unchanged (regression)', () => {
  const d = decodeEptBinaryTile(f32Tile(1.5, 2.5, 3.5), 1, XYZ_F32, [0, 0, 0]);
  expect(d.positions[0]).toBeCloseTo(1.5, 5);
  expect(d.positions[1]).toBeCloseTo(2.5, 5);
  expect(d.positions[2]).toBeCloseTo(3.5, 5);
});
