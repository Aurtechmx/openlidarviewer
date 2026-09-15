/**
 * terrainCoreStore.test.ts
 *
 * The persistent TerrainCore tier over a fake OPFS. A hit needs the same
 * positions, classification, parameters, method generation and an intact
 * payload; every other case is a named miss and the caller recomputes. The
 * store also stays inside its byte budget and writes only cores worth keeping.
 * The fake keeps bytes in memory. Nothing here touches a real disk.
 */
import { describe, it, expect } from 'vitest';
import { fakeOpfsDir } from './support/fakeOpfs';
import type { OpfsDirHandle } from '../src/io/heavy/opfsSpillStore';
import { computeTerrainCore } from '../src/terrain/contour/analyseContours';
import type { TerrainCore } from '../src/terrain/contour/analyseContours';
import { createTerrainCoreStore, TERRAIN_CORE_STORE_DIR, TERRAIN_CORE_INDEX_FILE } from '../src/terrain/contour/terrainCoreStore';
import { encodeTerrainCore } from '../src/terrain/contour/terrainCorePayload';
import { integrityDigest } from '../src/terrain/contour/persistentCoreKey';
import { smallCloud, SMALL_PARAMS, sameCore } from './terrainCorePayload.test';

const positions = smallCloud();
const core = computeTerrainCore(positions, SMALL_PARAMS);
const EXPENSIVE = 5000;

async function readIndex(root: OpfsDirHandle) {
  const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
  return JSON.parse(await (await (await dir.getFileHandle(TERRAIN_CORE_INDEX_FILE)).getFile()).text());
}
async function writeIndex(root: OpfsDirHandle, index: unknown) {
  const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
  const w = await (await dir.getFileHandle(TERRAIN_CORE_INDEX_FILE, { create: true })).createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify(index)));
  await w.close();
}

describe('terrain core store', () => {
  it('restores the core it persisted, scientifically identical', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    expect(await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE)).toBe(true);
    const found = await store.lookup(positions, SMALL_PARAMS);
    expect('core' in found).toBe(true);
    expect(sameCore((found as { core: TerrainCore }).core, core)).toBeNull();
  });

  it('is a miss without OPFS', async () => {
    const store = createTerrainCoreStore(null);
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'unavailable' });
    expect(await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE)).toBe(false);
  });

  it('names the axis that missed', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'not-found' });
    await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    const edited = positions.slice();
    edited[3] += 0.001;
    expect(await store.lookup(edited, SMALL_PARAMS)).toEqual({ miss: 'content-mismatch' });
    expect(await store.lookup(positions, { ...SMALL_PARAMS, cellSizeM: 5 })).toEqual({ miss: 'parameter-mismatch' });
    const later = createTerrainCoreStore(root, { generation: 'g2' });
    expect(await later.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'generation-mismatch' });
  });

  it('a classification edit the sampled hash would miss is a content mismatch', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    const cls = new Uint8Array(positions.length / 3).fill(2);
    await store.persist(positions, { ...SMALL_PARAMS, classification: cls }, core, EXPENSIVE);
    const edited = cls.slice();
    edited[1] = 5;
    expect(await store.lookup(positions, { ...SMALL_PARAMS, classification: edited })).toEqual({ miss: 'content-mismatch' });
  });

  it('a flipped payload byte fails integrity and the entry is dropped', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    const index = await readIndex(root);
    const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
    const file = index.entries[0].file as string;
    const bytes = new Uint8Array(await (await (await dir.getFileHandle(file)).getFile()).arrayBuffer());
    bytes[bytes.byteLength - 1] ^= 0x01;
    const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'integrity-failure' });
    await new Promise((r) => setTimeout(r, 0));
    expect((await readIndex(root)).entries).toHaveLength(0);
  });

  it('a missing payload file is a read failure; a foreign format is a format mismatch', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    const index = await readIndex(root);
    await writeIndex(root, { ...index, entries: [{ ...index.entries[0], format: 99 }] });
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'format-mismatch' });
    await writeIndex(root, index);
    const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
    await dir.removeEntry(index.entries[0].file);
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'read-failure' });
  });

  it('a store opened fresh over the same root restores the earlier core', async () => {
    const root = fakeOpfsDir();
    const first = createTerrainCoreStore(root, { generation: 'g1' });
    expect(await first.persist(positions, SMALL_PARAMS, core, EXPENSIVE)).toBe(true);
    // A later session builds a new store over the same directory; the entry it
    // finds there is the whole point of persisting, so it must hit.
    const reopened = createTerrainCoreStore(root, { generation: 'g1' });
    const found = await reopened.lookup(positions, SMALL_PARAMS);
    expect('core' in found).toBe(true);
    expect(sameCore((found as { core: TerrainCore }).core, core)).toBeNull();
  });

  it('a payload that passes its digest but will not decode is an integrity failure', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    const index = await readIndex(root);
    const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
    const file = index.entries[0].file as string;
    // Bytes the index vouches for exactly, and which the decoder still cannot
    // read: the digest gate passes and the decode gate is what refuses.
    const garbage = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
    await w.write(garbage);
    await w.close();
    await writeIndex(root, {
      ...index,
      entries: [{ ...index.entries[0], bytes: garbage.byteLength, digest: await integrityDigest(garbage) }],
    });
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'integrity-failure' });
  });

  it('names generation, not parameters, when only the generation moved', async () => {
    const root = fakeOpfsDir();
    await createTerrainCoreStore(root, { generation: 'g1' }).persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    const bumped = createTerrainCoreStore(root, { generation: 'g2' });
    expect(await bumped.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'generation-mismatch' });
    // The same store still names the parameter axis when the parameters move,
    // so the two axes are not collapsed into one reason.
    expect(await bumped.lookup(positions, { ...SMALL_PARAMS, cellSizeM: 5 })).toEqual({ miss: 'parameter-mismatch' });
  });

  it('keeps cheap cores in memory only', async () => {
    const store = createTerrainCoreStore(fakeOpfsDir(), { generation: 'g1', persistMinMs: 1000 });
    expect(await store.persist(positions, SMALL_PARAMS, core, 999)).toBe(false);
    expect(await store.persist(positions, SMALL_PARAMS, core, 1000)).toBe(true);
  });

  it('evicts the least recently used entry to stay inside its budget', async () => {
    const root = fakeOpfsDir();
    let t = 0;
    // Room for two payloads of this size, not three.
    const budget = Math.floor(encodeTerrainCore(core)!.byteLength * 2.5);
    const store = createTerrainCoreStore(root, { generation: 'g1', budgetBytes: budget, now: () => ++t });
    const other = smallCloud(3000, 11);
    const otherCore = computeTerrainCore(other, SMALL_PARAMS);
    await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    await store.persist(other, SMALL_PARAMS, otherCore, EXPENSIVE);
    const third = smallCloud(3000, 13);
    await store.persist(third, SMALL_PARAMS, computeTerrainCore(third, SMALL_PARAMS), EXPENSIVE);
    const index = await readIndex(root);
    const total = index.entries.reduce((n: number, e: { bytes: number }) => n + e.bytes, 0);
    expect(total).toBeLessThanOrEqual(budget);
    expect(index.entries).toHaveLength(2);
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'content-mismatch' });
    expect('core' in (await store.lookup(third, SMALL_PARAMS))).toBe(true);
  });

  it('does not write when the platform reports no room', async () => {
    const store = createTerrainCoreStore(fakeOpfsDir(), { generation: 'g1', freeBytes: async () => 10 });
    expect(await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE)).toBe(false);
  });

  it('a torn index is treated as empty and rebuilt', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
    const w = await (await dir.getFileHandle(TERRAIN_CORE_INDEX_FILE, { create: true })).createWritable();
    await w.write(new TextEncoder().encode('{"version":1,"ent'));
    await w.close();
    expect(await store.lookup(positions, SMALL_PARAMS)).toEqual({ miss: 'not-found' });
    expect(await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE)).toBe(true);
    expect('core' in (await store.lookup(positions, SMALL_PARAMS))).toBe(true);
  });

  it('a write sweeps payload files the index no longer names', async () => {
    const root = fakeOpfsDir();
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    await store.persist(positions, SMALL_PARAMS, core, EXPENSIVE);
    const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
    const w = await (await dir.getFileHandle(TERRAIN_CORE_INDEX_FILE, { create: true })).createWritable();
    await w.write(new TextEncoder().encode('{"version":1,"ent'));
    await w.close();
    const other = smallCloud(3000, 11);
    await store.persist(other, SMALL_PARAMS, computeTerrainCore(other, SMALL_PARAMS), EXPENSIVE);
    const names: string[] = [];
    for await (const k of dir.keys()) names.push(k);
    expect(names.sort()).toEqual(['core-1.bin', TERRAIN_CORE_INDEX_FILE].sort());
  });
});
