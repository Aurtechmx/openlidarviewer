/**
 * opfsSpillStore.test.ts — the OPFS-shaped tile backing, against an in-memory
 * fake of the file-system handles.
 *
 * OPFS is a browser API, so the real handles are exercised in the browser; here
 * a fake stands in for `FileSystemDirectoryHandle` so the store's own logic
 * — append-concatenation, the key-to-file-name mapping, and text artifacts — is
 * unit-tested in Node. A second case runs the whole build into the fake store and
 * reads it back through the tile-store reader, proving the OPFS backing is a drop-
 * in for the memory store used elsewhere.
 *
 * The build case runs TWICE, once with sync access handles available and once
 * without, because the store picks its write path from what the handle offers
 * and a suite that only ever saw one of them would not notice the other break.
 * `tests/opfsSpillCost.test.ts` is where the two are separated by cost; here
 * they only have to agree on the result. The fake itself lives in
 * `tests/support/fakeOpfs.ts`, shared by both files.
 */
import { describe, it, expect } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { indexOutOfCore } from '../src/io/heavy/oocIndexer';
import { openSlicedLasSource } from '../src/io/heavy/slicedLasSource';
import { buildTileStore, parseHierarchy, parseTileManifest, TileStoreReader } from '../src/io/heavy/tileStore';
import {
  opfsSpillStore,
  readOpfsText,
  writeOpfsText,
} from '../src/io/heavy/opfsSpillStore';
import { fakeOpfsDir } from './support/fakeOpfs';

describe('OPFS spill store', () => {
  it('appends, reads, maps keys, and round-trips text', async () => {
    const store = opfsSpillStore(fakeOpfsDir());
    await store.append('3', new Uint8Array([1, 2, 3]));
    await store.append('3', new Uint8Array([4, 5]));
    await store.append('', new Uint8Array([9]));

    expect([...(await store.read('3'))]).toEqual([1, 2, 3, 4, 5]);
    expect([...(await store.read(''))]).toEqual([9]); // the root key
    expect((await store.keys()).sort()).toEqual(['', '3']);

    const dir = fakeOpfsDir();
    await writeOpfsText(dir, 'manifest.json', '{"ok":true}');
    expect(await readOpfsText(dir, 'manifest.json')).toBe('{"ok":true}');
  });

  it.each([
    ['with sync access handles', { syncAccess: true }],
    ['with only a writable stream', {}],
  ])('holds a whole build and reads it back through the tile store, %s', async (_label, capabilities) => {
    const n = 3000;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    const intensity = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = 500000 + (i % 60) * 3;
      y[i] = 4100000 + Math.floor(i / 60) * 3;
      z[i] = 190 + (i % 30);
      intensity[i] = i;
    }
    const cloud: GlobalPoints = { count: n, x, y, z, intensity };
    const bytes = writeLas14(cloud);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const dir = fakeOpfsDir(capabilities);
    const store = opfsSpillStore(dir);
    const las = await openSlicedLasSource(new ArrayBufferRangeSource(ab));
    const index = await indexOutOfCore(las.source, store, { pointsPerLeaf: 600, memoryBudgetBytes: 16 * 1024 });

    const { manifestJson, hierarchy } = buildTileStore(index, las.schema, las.origin);
    await writeOpfsText(dir, 'manifest.json', manifestJson);
    await writeOpfsText(dir, 'hierarchy.txt', hierarchy);

    // Reopen from the store's own artifacts, then read tiles back.
    const manifest = parseTileManifest(JSON.parse(await readOpfsText(dir, 'manifest.json')));
    const leaves = parseHierarchy(await readOpfsText(dir, 'hierarchy.txt'));
    const reader = new TileStoreReader(manifest, leaves);

    expect(manifest.pointCount).toBe(n);
    expect(reader.leaves().reduce((s, l) => s + l.pointCount, 0)).toBe(n);

    let total = 0;
    let bad = 0;
    for (const leaf of reader.leaves()) {
      const points = reader.decodeTile(await store.read(leaf.key));
      const cube = reader.cubeFor(leaf.key);
      for (const pt of points) {
        for (let a = 0; a < 3; a++) {
          if (pt.position[a] < cube.min[a] || pt.position[a] > cube.min[a] + cube.size) bad++;
        }
      }
      total += points.length;
    }
    expect(bad).toBe(0);
    expect(total).toBe(n);
  });
});
