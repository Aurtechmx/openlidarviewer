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
import { isAbortError } from '../src/app/openStreaming';
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
  expect(decoded.positions).toHaveLength(300);
  expect(decoded.intensity).toHaveLength(100);
  expect(decoded.classification).toHaveLength(100);

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
    expect([1, 2, 5, 6, 9]).toContain(decoded.classification?.[i]);
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
  const octree = new EptOctree(meta, (key, signal) =>
    transport.fetchText(`fixture://ept-tiny/ept-hierarchy/${key.d}-${key.x}-${key.y}-${key.z}.json`, signal),
  );
  await octree.loadFullHierarchy();
  expect(octree.fullyLoaded).toBe(true);
  expect(octree.errors).toHaveLength(0);
  // A whole hierarchy with no dropped file → complete, gradeable "exact".
  expect(octree.isComplete).toBe(true);
  const nodes = octree.nodes();
  expect(nodes).toHaveLength(1);
  expect(nodes[0].record.id).toBe('0-0-0-0');
  expect(nodes[0].record.pointCount).toBe(100);
});

test('EptOctree node bounds are ABSOLUTE (render-origin-independent), matching the COPC contract', async () => {
  // record.bounds must be in world space for BOTH formats: the shared
  // StreamingScheduler localises them once (bounds − renderOrigin) before
  // frustum culling. EptOctree used to pre-subtract the origin itself, so the
  // scheduler subtracted it a second time and every EPT node landed one whole
  // renderOrigin away from the near-origin camera — frustum-culled, visible=0,
  // nothing ever streamed. The root node (depth 0) must span the full cube in
  // ABSOLUTE coordinates regardless of the origin passed in.
  const meta = loadFixtureMetadata();
  const transport = fixtureTransport();
  const cube = meta.bounds.cubic;
  // A large non-zero origin — the value the render pipeline actually uses.
  const octree = new EptOctree(meta, (key, signal) =>
    transport.fetchText(`fixture://ept-tiny/ept-hierarchy/${key.d}-${key.x}-${key.y}-${key.z}.json`, signal),
  );
  await octree.loadFullHierarchy();
  const root = octree.nodes()[0];
  expect(root.record.bounds).toEqual([
    cube[0], cube[1], cube[2], cube[3], cube[4], cube[5],
  ]);
});

// A three-file hierarchy: root links to 1-1-0-0, which links to 2-2-0-0.
// Value -1 marks a link (a further file to fetch); anything else is a node.
const MULTI_FILE_HIERARCHY: Record<string, string> = {
  '0-0-0-0': JSON.stringify({ '0-0-0-0': 100, '1-0-0-0': 50, '1-1-0-0': -1 }),
  '1-1-0-0': JSON.stringify({ '1-1-0-0': 30, '2-2-0-0': -1 }),
  '2-2-0-0': JSON.stringify({ '2-2-0-0': 10 }),
};
function multiFileOctree(): EptOctree {
  const fetched: string[] = [];
  const octree = new EptOctree(loadFixtureMetadata(), (key) => {
    const id = `${key.d}-${key.x}-${key.y}-${key.z}`;
    fetched.push(id);
    const text = MULTI_FILE_HIERARCHY[id];
    return text ? Promise.resolve(text) : Promise.reject(new Error(`no file ${id}`));
  });
  return octree;
}

test('progressive hierarchy: an initial paint attaches before the full index loads', async () => {
  const octree = multiFileOctree();
  // Budget of one file: the root only.
  await octree.loadInitialHierarchy(1);
  expect(octree.fullyLoaded).toBe(false); // more to fetch in the background
  // Mid-deepening the index is not whole yet, so a grade taken now must not
  // claim exact — even though no error has occurred.
  expect(octree.isComplete).toBe(false);
  const idsAfterInitial = octree.nodes().map((n) => n.record.id).sort();
  expect(idsAfterInitial).toEqual(['0-0-0-0', '1-0-0-0']);
  // The nodes that DID land already carry correct child links.
  expect(octree.store.get('0-0-0-0')!.childIds).toEqual(['1-0-0-0']);

  // Continue to completion — nodes arrive and refine.
  await octree.continueHierarchy();
  expect(octree.fullyLoaded).toBe(true);
  // Deepened to completion with no dropped file → now complete.
  expect(octree.isComplete).toBe(true);
  expect(octree.nodes().map((n) => n.record.id).sort()).toEqual([
    '0-0-0-0', '1-0-0-0', '1-1-0-0', '2-2-0-0',
  ]);
  // Child links are complete AND never duplicated across the two passes —
  // the root gained 1-1-0-0 without re-adding 1-0-0-0.
  expect(new Set(octree.store.get('0-0-0-0')!.childIds)).toEqual(new Set(['1-0-0-0', '1-1-0-0']));
  expect(octree.store.get('0-0-0-0')!.childIds).toHaveLength(2);
  expect(octree.store.get('1-1-0-0')!.childIds).toEqual(['2-2-0-0']);
});

test('progressive and full load reach the same node set and child links', async () => {
  const progressive = multiFileOctree();
  await progressive.loadInitialHierarchy(1);
  await progressive.continueHierarchy();

  const full = multiFileOctree();
  await full.loadFullHierarchy();

  const ids = (o: EptOctree): string[] => o.nodes().map((n) => n.record.id).sort();
  expect(ids(progressive)).toEqual(ids(full));
  for (const id of ids(full)) {
    expect(new Set(progressive.store.get(id)!.childIds)).toEqual(
      new Set(full.store.get(id)!.childIds),
    );
  }
});

test('the walk terminates when sub-file fetches fail — no retry loop', async () => {
  // The root loads; every linked sub-file rejects. The walk must drop the failed
  // files and finish (surfacing errors), not re-attempt them forever — a failed
  // file that stayed on the frontier while the file count never advanced would
  // spin an allocating loop until the heap died.
  const octree = new EptOctree(loadFixtureMetadata(), (key) => {
    const id = `${key.d}-${key.x}-${key.y}-${key.z}`;
    if (id === '0-0-0-0') return Promise.resolve(MULTI_FILE_HIERARCHY['0-0-0-0']);
    return Promise.reject(new Error(`network down at ${id}`));
  });
  await octree.loadInitialHierarchy(1);
  await octree.continueHierarchy(); // must return, not hang
  expect(octree.fullyLoaded).toBe(true);
  expect(octree.nodes().map((n) => n.record.id).sort()).toEqual(['0-0-0-0', '1-0-0-0']);
  expect(octree.errors.some((e) => /network down/.test(e))).toBe(true);
  // EPT mirror of the COPC swallowed-fetch case: the walk finished but a sub-file
  // was dropped, so the octree is NOT complete and a grade must not claim exact.
  expect(octree.isComplete).toBe(false);
});

test('a small hierarchy that fits the first-paint budget loads fully in one call', async () => {
  const octree = multiFileOctree();
  await octree.loadInitialHierarchy(64); // budget exceeds the 3 files
  expect(octree.fullyLoaded).toBe(true);
  expect(octree.nodes()).toHaveLength(4);
});

test('EptOctree.childKeysOf returns the 8 standard octree children', () => {
  const children = EptOctree.childKeysOf({ d: 0, x: 0, y: 0, z: 0 });
  expect(children).toHaveLength(8);
});

test('EptOctree handles a fetcher failure without crashing — surfaces in errors', async () => {
  const meta = loadFixtureMetadata();
  const failingFetcher = (): Promise<string> => Promise.reject(new Error('network down'));
  const octree = new EptOctree(meta, failingFetcher);
  await octree.loadFullHierarchy();
  expect(octree.fullyLoaded).toBe(true);
  expect(octree.errors.length).toBeGreaterThan(0);
  expect(octree.errors[0]).toMatch(/network down/);
  expect(octree.isComplete).toBe(false);
});

// The mid-walk abort guard must keep a user cancel (silent) distinct from a
// timeout (visible). It used to throw a plain Error, which the cancel classifier
// read as neither; it now propagates the signal's own abort reason. The fetcher
// is never reached because the guard fires on the root key before any fetch.

test('EptOctree: a user cancel throws an AbortError the classifier treats as silent', async () => {
  const meta = loadFixtureMetadata();
  const octree = new EptOctree(meta, () => Promise.reject(new Error('fetcher must not run')));
  const controller = new AbortController();
  controller.abort();
  const err = await octree.loadFullHierarchy(controller.signal).catch((e: unknown) => e);
  expect((err as Error).name).toBe('AbortError');
  expect(isAbortError(err)).toBe(true);
});

test('EptOctree: a timeout-reason abort stays a visible error, not a silent cancel', async () => {
  const meta = loadFixtureMetadata();
  const octree = new EptOctree(meta, () => Promise.reject(new Error('fetcher must not run')));
  const controller = new AbortController();
  const timeout = new DOMException('EPT hierarchy load timed out', 'TimeoutError');
  controller.abort(timeout);
  const err = await octree.loadFullHierarchy(controller.signal).catch((e: unknown) => e);
  expect(err).toBe(timeout);
  expect(isAbortError(err)).toBe(false);
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
  // The frame and the render origin must describe the same conversion; a
  // consumer reconstructs a source coordinate through one or the other.
  expect(cloud.frame.isTranslationOnly).toBe(true);
  expect(cloud.frame.renderOrigin).toEqual([...cloud.renderOrigin]);
  expect(cloud.frame.renderToSourcePoint([1.5, -2.25, 30.125])).toEqual([
    1.5 + cloud.renderOrigin[0],
    -2.25 + cloud.renderOrigin[1],
    30.125 + cloud.renderOrigin[2],
  ]);
  expect(cloud.frame.renderWorldUp()).toEqual([0, 0, 1]);
  expect(cloud.sourcePointCount).toBe(100);
  expect(cloud.dataType).toBe('binary');
  expect(cloud.maxDepth()).toBe(0);
  expect(cloud.octree.nodes()).toHaveLength(1);
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
  expect(decoded.positions).toHaveLength(300);
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

// ─────────────────────────────────────────────────────────────────────────────
// close() aborts the background hierarchy deepening
// ─────────────────────────────────────────────────────────────────────────────

test('EptStreamingPointCloud.close() aborts the background hierarchy deepening', async () => {
  // A depth-chain longer than FIRST_PAINT_HIERARCHY_FILES (24): each `i-0-0-0`
  // links to `(i+1)-0-0-0` (x=0 = 2·0 is a valid child at every depth). The
  // first 24 files load in the awaited initial phase; the 25th (`24-0-0-0`) is
  // the first the fire-and-forget continueHierarchy fetches — we block it and
  // capture the signal it was handed to prove close() aborts that signal.
  const N = 30;
  const chain: Record<string, string> = {};
  for (let i = 0; i < N; i++) {
    const key = `${i}-0-0-0`;
    chain[key] =
      i < N - 1
        ? JSON.stringify({ [key]: 100, [`${i + 1}-0-0-0`]: -1 })
        : JSON.stringify({ [key]: 100 });
  }

  let deepenSignal: AbortSignal | undefined;
  const transport: EptTransport = {
    fetchText: (url, signal) => {
      const m = url.match(/ept-hierarchy\/(\d+-\d+-\d+-\d+)\.json/);
      const key = m?.[1] ?? '';
      const depth = Number(key.split('-')[0]);
      if (depth < 24) return Promise.resolve(chain[key]);
      // The first background file: capture its signal and block until aborted.
      deepenSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    },
    fetchBytes: () => Promise.reject(new Error('no tile fetch in this test')),
  };

  const cloud = await EptStreamingPointCloud.open(
    loadFixtureMetadata(),
    'fixture://ept-tiny/',
    'ept-chain',
    transport,
  );
  // Let continueHierarchy schedule + reach the blocked 25th fetch.
  await new Promise((r) => setTimeout(r, 0));
  expect(deepenSignal).toBeDefined();
  expect(deepenSignal!.aborted).toBe(false);

  // Closing the session must abort the in-flight deepening.
  await cloud.close();
  expect(deepenSignal!.aborted).toBe(true);
});
