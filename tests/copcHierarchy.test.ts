import {
  rootKey,
  keyId,
  isValidKey,
  childKeys,
  parentKey,
  nodeBounds,
  nodeSpacing,
} from '../src/io/copc/voxelKey';
import { parseHierarchyPage } from '../src/io/copc/copcHierarchy';
import { CopcSource } from '../src/io/copc/CopcSource';
import { LoadError } from '../src/io/loadErrors';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { OctreeCube } from '../src/io/copc/copcTypes';

// --- voxelKey ----------------------------------------------------------------

test('keyId is deterministic and the root key is (0,0,0,0)', () => {
  expect(keyId(rootKey())).toBe('0-0-0-0');
  expect(keyId({ depth: 3, x: 5, y: 1, z: 2 })).toBe('3-5-1-2');
});

test('childKeys yields eight correctly-bisected children', () => {
  const kids = childKeys(rootKey());
  expect(kids).toHaveLength(8);
  expect(kids[0]).toEqual({ depth: 1, x: 0, y: 0, z: 0 });
  expect(kids[7]).toEqual({ depth: 1, x: 1, y: 1, z: 1 });
  // every child is one depth deeper and within [0,1] cells
  for (const k of kids) expect(k.depth).toBe(1);
});

test('parentKey climbs the octree and stops at the root', () => {
  expect(parentKey(rootKey())).toBeNull();
  expect(parentKey({ depth: 1, x: 1, y: 1, z: 1 })).toEqual({ depth: 0, x: 0, y: 0, z: 0 });
  expect(parentKey({ depth: 3, x: 5, y: 3, z: 0 })).toEqual({ depth: 2, x: 2, y: 1, z: 0 });
});

test('isValidKey rejects negative or non-integer keys', () => {
  expect(isValidKey({ depth: 0, x: 0, y: 0, z: 0 })).toBe(true);
  expect(isValidKey({ depth: -1, x: 0, y: 0, z: 0 })).toBe(false);
  expect(isValidKey({ depth: 1, x: 1.5, y: 0, z: 0 })).toBe(false);
});

test('nodeBounds subdivides the octree cube; spacing halves per depth', () => {
  const cube: OctreeCube = { center: [0, 0, 0], halfsize: 100 };
  expect(nodeBounds(rootKey(), cube)).toEqual([-100, -100, -100, 100, 100, 100]);
  expect(nodeBounds({ depth: 1, x: 0, y: 0, z: 0 }, cube)).toEqual([-100, -100, -100, 0, 0, 0]);
  expect(nodeBounds({ depth: 1, x: 1, y: 1, z: 1 }, cube)).toEqual([0, 0, 0, 100, 100, 100]);
  expect(nodeSpacing(0, 16)).toBe(16);
  expect(nodeSpacing(2, 16)).toBe(4);
});

// --- parseHierarchyPage ------------------------------------------------------

const CUBE: OctreeCube = { center: [0, 0, 0], halfsize: 128 };

/** Build just the root hierarchy-page bytes from a synthetic COPC. */
function rootPageBytes(fixture: ReturnType<typeof buildSyntheticCopc>): ArrayBuffer {
  return fixture.buffer.slice(
    fixture.rootHierOffset,
    fixture.rootHierOffset + fixture.rootHierSize,
  );
}

test('parseHierarchyPage extracts data nodes, empty nodes, and child pages', () => {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    spacing: 32,
    pages: [
      {
        pageKey: [0, 0, 0, 0],
        nodes: [
          { key: [0, 0, 0, 0], pointCount: 1000 },
          { key: [1, 0, 0, 0], pointCount: 0 }, // empty node
        ],
        childPages: [1],
      },
      { pageKey: [1, 1, 0, 0], nodes: [{ key: [1, 1, 0, 0], pointCount: 400 }] },
    ],
  });
  const page = parseHierarchyPage(rootPageBytes(fixture), CUBE, 32);
  expect(page.errors).toEqual([]);
  expect(page.nodes).toHaveLength(1);
  expect(page.nodes[0].id).toBe('0-0-0-0');
  expect(page.nodes[0].pointCount).toBe(1000);
  expect(page.nodes[0].spacing).toBe(32);
  expect(page.nodes[0].bounds).toEqual([-128, -128, -128, 128, 128, 128]);
  expect(page.emptyKeys).toHaveLength(1);
  expect(page.childPages).toHaveLength(1);
  expect(page.childPages[0].key).toEqual({ depth: 1, x: 1, y: 0, z: 0 });
});

test('parseHierarchyPage collects malformed entries instead of throwing', () => {
  const fixture = buildSyntheticCopc({
    corrupt: 'bad-hierarchy-entry',
    nodes: [{ key: [0, 0, 0, 0], pointCount: 500 }],
  });
  const page = parseHierarchyPage(rootPageBytes(fixture), CUBE, 32);
  expect(page.errors.length).toBeGreaterThan(0);
  expect(page.nodes).toHaveLength(0); // the one (corrupt) node was skipped
});

test('parseHierarchyPage tolerates a buffer that is not a multiple of 32', () => {
  // A two-node root page is 64 bytes; slicing to 42 leaves one whole entry
  // plus 10 stray bytes — the parse must keep the entry and flag the tail.
  const fixture = buildSyntheticCopc({
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 100 },
      { key: [1, 0, 0, 0], pointCount: 50 },
    ],
  });
  const short = rootPageBytes(fixture).slice(0, 32 + 10);
  expect(short.byteLength).toBe(42);
  const page = parseHierarchyPage(short, CUBE, 32);
  expect(page.nodes).toHaveLength(1);
  expect(page.errors.some((e) => e.includes('multiple of 32'))).toBe(true);
});

// --- CopcSource --------------------------------------------------------------

test('CopcSource.open reads metadata and the root hierarchy page', async () => {
  const fixture = buildSyntheticCopc({
    center: [200, 200, 20],
    halfsize: 256,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 800 },
      { key: [1, 0, 0, 0], pointCount: 600 },
    ],
  });
  const source = await CopcSource.open(new ArrayBufferRangeSource(fixture.buffer));
  expect(source.metadata.info.halfsize).toBe(256);
  expect(source.cube.center).toEqual([200, 200, 20]);
  expect(source.rootPage.nodes).toHaveLength(2);
});

test('CopcSource descends to a child page and reads a node chunk', async () => {
  const fixture = buildSyntheticCopc({
    pages: [
      {
        pageKey: [0, 0, 0, 0],
        nodes: [{ key: [0, 0, 0, 0], pointCount: 900, byteSize: 128 }],
        childPages: [1],
      },
      { pageKey: [1, 1, 1, 1], nodes: [{ key: [1, 1, 1, 1], pointCount: 250 }] },
    ],
  });
  const source = await CopcSource.open(new ArrayBufferRangeSource(fixture.buffer));
  const childPage = await source.loadChildPage(source.rootPage.childPages[0]);
  expect(childPage.nodes).toHaveLength(1);
  expect(childPage.nodes[0].id).toBe('1-1-1-1');

  const chunk = await source.readNodeChunk(source.rootPage.nodes[0]);
  expect(chunk.byteLength).toBe(128);
});

test('CopcSource.open rejects a non-COPC file', async () => {
  const notCopc = buildSyntheticCopc({ corrupt: 'no-copc-vlr' });
  await expect(
    CopcSource.open(new ArrayBufferRangeSource(notCopc.buffer)),
  ).rejects.toThrow(LoadError);
});
