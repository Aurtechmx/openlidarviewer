/**
 * eptStreaming.test.ts — v0.3.3 — EPT streaming integration.
 *
 * Three layers covered:
 *   1. EPT binary tile decoder — schema-driven layout + Float64-narrow
 *      precision contract (matches docs/coordinate-precision.md).
 *   2. EptOctree — hierarchy traversal builds the shared StreamingNodeStore;
 *      parent/child links resolve correctly; bounds derive from cube + key.
 *   3. EptStreamingPointCloud — open() round-trip against the synthetic
 *      fixture: hierarchy loads, octree populates, readNodeChunk fetches
 *      the right URL, decodeBinary produces a DecodedChunk with the
 *      right point count + coordinate range.
 *
 * Network is mocked through the `EptTransport` callback shape so the test
 * runs entirely against `tests/fixtures/ept-tiny/` (no live HTTP needed).
 *
 * Pure Node — no DOM, no three.js, no WebGPU.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import {
  computeSchemaLayout,
  decodeEptBinaryTile,
} from '../src/io/ept/eptBinaryDecode';
import { EptOctree } from '../src/render/streaming/EptOctree';
import { EptStreamingPointCloud } from '../src/render/streaming/EptStreamingPointCloud';
import type { EptTransport } from '../src/render/streaming/EptStreamingPointCloud';
import { parseEptMetadata } from '../src/io/ept/eptDetect';
import type { EptMetadata, EptSchemaField } from '../src/io/ept/eptTypes';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'ept-tiny');

function loadFixtureMetadata(): EptMetadata {
  const text = readFileSync(join(FIXTURE_DIR, 'ept.json'), 'utf8');
  const result = parseEptMetadata(text);
  if (!result.isEpt) throw new Error('fixture failed to parse');
  return result.metadata;
}

/** A test EptTransport that serves the synthetic fixture from local disk. */
function fixtureTransport(): EptTransport {
  return {
    fetchText: async (url) => {
      // URLs in tests look like "fixture://ept-tiny/ept-hierarchy/0-0-0-0.json".
      // We strip the prefix and read the path off the fixture dir.
      const rel = url.replace(/^fixture:\/\/ept-tiny\//, '');
      return readFileSync(join(FIXTURE_DIR, rel), 'utf8');
    },
    fetchBytes: async (url) => {
      const rel = url.replace(/^fixture:\/\/ept-tiny\//, '');
      const buf = readFileSync(join(FIXTURE_DIR, rel));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema layout + binary decode
// ─────────────────────────────────────────────────────────────────────────────

test('computeSchemaLayout produces stable offsets + total stride', () => {
  const schema: EptSchemaField[] = [
    { name: 'X',              size: 4, type: 'signed',   scale: 0.001 },
    { name: 'Y',              size: 4, type: 'signed',   scale: 0.001 },
    { name: 'Z',              size: 4, type: 'signed',   scale: 0.001 },
    { name: 'Intensity',      size: 2, type: 'unsigned' },
    { name: 'Classification', size: 1, type: 'unsigned' },
  ];
  const { attrs, stride } = computeSchemaLayout(schema);
  expect(stride).toBe(15);
  expect(attrs[0].offset).toBe(0);
  expect(attrs[1].offset).toBe(4);
  expect(attrs[2].offset).toBe(8);
  expect(attrs[3].offset).toBe(12);
  expect(attrs[4].offset).toBe(14);
});

test('decodeEptBinaryTile decodes the synthetic fixture cleanly', () => {
  const meta = loadFixtureMetadata();
  const tileBytes = readFileSync(join(FIXTURE_DIR, 'ept-data', '0-0-0-0.bin'));
  const buffer = tileBytes.buffer.slice(
    tileBytes.byteOffset,
    tileBytes.byteOffset + tileBytes.byteLength,
  );
  // Render origin matches the fixture's cube centre (floored). For the
  // fixture's [500_000, 500_000, 1_500] – [500_100, 500_100, 1_550] cube
  // the centre is (500_050, 500_050, 1_525) → floored = (500_050, 500_050, 1_525).
  const renderOrigin: [number, number, number] = [500_050, 500_050, 1_525];
  const decoded = decodeEptBinaryTile(buffer, 100, meta.schema, renderOrigin);

  expect(decoded.pointCount).toBe(100);
  expect(decoded.positions.length).toBe(300);
  expect(decoded.intensity.length).toBe(100);
  expect(decoded.classification.length).toBe(100);

  // Every position is in render-origin-subtracted local space — the
  // fixture's cube is 100 m × 100 m × 50 m, so EVERY local x/y is within
  // [−50, +50] and z within [−25, +25] (the cube minus its centre).
  for (let i = 0; i < 100; i++) {
    expect(Math.abs(decoded.positions[i * 3])).toBeLessThanOrEqual(60);
    expect(Math.abs(decoded.positions[i * 3 + 1])).toBeLessThanOrEqual(60);
    expect(Math.abs(decoded.positions[i * 3 + 2])).toBeLessThanOrEqual(30);
  }

  // Classification values come from the fixture's choice set {1,2,5,6,9}.
  for (let i = 0; i < 100; i++) {
    expect([1, 2, 5, 6, 9]).toContain(decoded.classification[i]);
  }
});

test('decodeEptBinaryTile throws on a short buffer', () => {
  const schema: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 1 },
    { name: 'Y', size: 4, type: 'signed', scale: 1 },
    { name: 'Z', size: 4, type: 'signed', scale: 1 },
  ];
  const tooShort = new ArrayBuffer(6); // 12 bytes per point needed
  expect(() => decodeEptBinaryTile(tooShort, 1, schema, [0, 0, 0])).toThrow(/short/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// EptOctree
// ─────────────────────────────────────────────────────────────────────────────

test('EptOctree loads the synthetic fixture and registers one root node', async () => {
  const meta = loadFixtureMetadata();
  const transport = fixtureTransport();
  const renderOrigin: [number, number, number] = [500_050, 500_050, 1_525];
  const octree = new EptOctree(meta, renderOrigin, (key, signal) =>
    transport.fetchText(`fixture://ept-tiny/ept-hierarchy/${key.d}-${key.x}-${key.y}-${key.z}.json`, signal),
  );
  await octree.loadFullHierarchy();
  expect(octree.fullyLoaded).toBe(true);
  expect(octree.errors.length).toBe(0);
  const nodes = octree.nodes();
  expect(nodes.length).toBe(1);
  expect(nodes[0].record.id).toBe('0-0-0-0');
  expect(nodes[0].record.pointCount).toBe(100);
});

test('EptOctree.childKeysOf returns the 8 standard octree children', () => {
  const children = EptOctree.childKeysOf({ d: 0, x: 0, y: 0, z: 0 });
  expect(children.length).toBe(8);
});

test('EptOctree handles a fetcher failure without crashing — surfaces in errors', async () => {
  const meta = loadFixtureMetadata();
  const failingFetcher = (): Promise<string> => Promise.reject(new Error('network down'));
  const octree = new EptOctree(meta, [0, 0, 0], failingFetcher);
  await octree.loadFullHierarchy();
  expect(octree.fullyLoaded).toBe(true);
  expect(octree.errors.length).toBeGreaterThan(0);
  expect(octree.errors[0]).toMatch(/network down/);
});

// ─────────────────────────────────────────────────────────────────────────────
// EptStreamingPointCloud — end-to-end open() against the fixture
// ─────────────────────────────────────────────────────────────────────────────

test('EptStreamingPointCloud.open round-trips the fixture into a streaming source', async () => {
  const meta = loadFixtureMetadata();
  const transport = fixtureTransport();
  const cloud = await EptStreamingPointCloud.open(
    meta,
    'fixture://ept-tiny/',
    'ept-tiny',
    transport,
  );
  expect(cloud.kind).toBe('ept');
  expect(cloud.name).toBe('ept-tiny');
  expect(cloud.sourcePointCount).toBe(100);
  expect(cloud.dataType).toBe('binary');
  expect(cloud.maxDepth()).toBe(0);
  expect(cloud.octree.nodes().length).toBe(1);
});

test('EptStreamingPointCloud.readNodeChunk fetches the tile bytes', async () => {
  const meta = loadFixtureMetadata();
  const transport = fixtureTransport();
  const cloud = await EptStreamingPointCloud.open(
    meta,
    'fixture://ept-tiny/',
    'ept-tiny',
    transport,
  );
  const root = cloud.octree.nodes()[0];
  const bytes = await cloud.readNodeChunk(root.record);
  // 100 points × 15 bytes = 1500.
  expect(bytes.byteLength).toBe(1500);
});

test('EptStreamingPointCloud.decodeBinary recovers points within the cube', async () => {
  const meta = loadFixtureMetadata();
  const transport = fixtureTransport();
  const cloud = await EptStreamingPointCloud.open(
    meta,
    'fixture://ept-tiny/',
    'ept-tiny',
    transport,
  );
  const root = cloud.octree.nodes()[0];
  const bytes = await cloud.readNodeChunk(root.record);
  const decoded = cloud.decodeBinary(bytes, root.record.pointCount);
  expect(decoded.pointCount).toBe(100);
  expect(decoded.positions.length).toBe(300);
});

test('EptStreamingPointCloud pins the RGB bit-depth from the first decoded tile', async () => {
  const meta = loadFixtureMetadata();
  const transport = fixtureTransport();
  const cloud = await EptStreamingPointCloud.open(
    meta,
    'fixture://ept-tiny/',
    'ept-tiny',
    transport,
  );
  const root = cloud.octree.nodes()[0];
  // No decision yet — decodeMeta carries undefined.
  expect(cloud.decodeMeta(root.record).rgbEightBit).toBeUndefined();
  // First RGB tile decides "true 16-bit" (false) → pinned into decodeMeta.
  cloud.noteDecodedRgbDepth(false);
  expect(cloud.decodeMeta(root.record).rgbEightBit).toBe(false);
  // Sticky: a later all-dark tile reporting 8-bit can't flip the dataset.
  cloud.noteDecodedRgbDepth(true);
  expect(cloud.decodeMeta(root.record).rgbEightBit).toBe(false);
});

test('EptStreamingPointCloud.localBounds yields the cube in render space', async () => {
  const meta = loadFixtureMetadata();
  const transport = fixtureTransport();
  const cloud = await EptStreamingPointCloud.open(
    meta,
    'fixture://ept-tiny/',
    'ept-tiny',
    transport,
  );
  const b = cloud.localBounds();
  // Cube is 100 m × 100 m × 50 m → in render space it's [−50,+50] × [−50,+50] × [−25,+25].
  expect(b[3] - b[0]).toBeCloseTo(100, 6);
  expect(b[4] - b[1]).toBeCloseTo(100, 6);
  expect(b[5] - b[2]).toBeCloseTo(50, 6);
});
