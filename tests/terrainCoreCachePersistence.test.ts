/**
 * terrainCoreCachePersistence.test.ts
 *
 * The in-memory core cache consults the persistent tier on a miss and hands
 * a computed core to it afterwards, without ever delaying the result: the
 * caller has its core before the tier is asked to write. A tier that throws
 * is a miss, and a restored core is reported as such. The tier is a pair of
 * spies, except for the last case, which drives the real OPFS-backed store
 * over a fake directory to check that a refused restore is named.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getOrComputeCoreAsync,
  clearTerrainCoreCache,
  setTerrainCorePersistence,
  lastTerrainCoreSource,
  lastTerrainCorePersistenceMiss,
} from '../src/terrain/contour/terrainCoreCache';
import { fakeOpfsDir } from './support/fakeOpfs';
import { createTerrainCoreStore, TERRAIN_CORE_STORE_DIR } from '../src/terrain/contour/terrainCoreStore';
import { computeTerrainCore } from '../src/terrain/contour/analyseContours';
import { smallCloud, SMALL_PARAMS } from './terrainCorePayload.test';
import type { TerrainCore, TerrainCoreParams } from '../src/terrain/contour/analyseContours';

const PARAMS: TerrainCoreParams = { cellSizeM: 2, crs: 'EPSG:32610' };
const fakeCore = (tag: string) => ({ tag } as unknown as TerrainCore);
const cloud = (seed: number) => Float32Array.from({ length: 30 }, (_, i) => i + seed);

afterEach(() => {
  setTerrainCorePersistence(null);
  clearTerrainCoreCache();
});

describe('terrain core cache with a persistent tier', () => {
  it('restores from the tier instead of computing', async () => {
    const lookup = vi.fn(async () => ({ core: fakeCore('restored') }));
    const persist = vi.fn(async () => true);
    setTerrainCorePersistence({ lookup, persist });
    const compute = vi.fn(async () => fakeCore('computed'));
    const core = await getOrComputeCoreAsync(cloud(1), PARAMS, compute);
    expect((core as unknown as { tag: string }).tag).toBe('restored');
    expect(compute).not.toHaveBeenCalled();
    expect(lastTerrainCoreSource()).toBe('restored');
    await new Promise((r) => setTimeout(r, 0));
    expect(persist).not.toHaveBeenCalled();
  });

  it('computes on a tier miss and persists after the result is out', async () => {
    let persistedAt = -1;
    let returnedAt = -1;
    let tick = 0;
    const persist = vi.fn(async (_p: Float32Array, _q: TerrainCoreParams, _c: TerrainCore, ms: number) => {
      persistedAt = ++tick;
      expect(ms).toBeGreaterThanOrEqual(0);
      return true;
    });
    setTerrainCorePersistence({ lookup: async () => ({ miss: 'not-found' }), persist });
    const core = await getOrComputeCoreAsync(cloud(2), PARAMS, async () => fakeCore('computed'));
    returnedAt = ++tick;
    expect((core as unknown as { tag: string }).tag).toBe('computed');
    expect(lastTerrainCoreSource()).toBe('computed');
    await new Promise((r) => setTimeout(r, 0));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persistedAt).toBeGreaterThan(returnedAt);
  });

  it('a throwing tier is a miss, and a memory hit never asks the tier', async () => {
    const lookup = vi.fn(async () => { throw new Error('opfs down'); });
    setTerrainCorePersistence({ lookup, persist: async () => false });
    const compute = vi.fn(async () => fakeCore('computed'));
    await getOrComputeCoreAsync(cloud(3), PARAMS, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    await getOrComputeCoreAsync(cloud(3), PARAMS, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lastTerrainCoreSource()).toBe('memory');
  });

  it('a rejected compute is not persisted', async () => {
    const persist = vi.fn(async () => true);
    setTerrainCorePersistence({ lookup: async () => ({ miss: 'not-found' }), persist });
    await expect(getOrComputeCoreAsync(cloud(4), PARAMS, async () => { throw new Error('aborted'); })).rejects.toThrow('aborted');
    await new Promise((r) => setTimeout(r, 0));
    expect(persist).not.toHaveBeenCalled();
  });

  it('names why a restore did not happen, and clears the name on a hit', async () => {
    setTerrainCorePersistence({ lookup: async () => ({ miss: 'generation-mismatch' }), persist: async () => true });
    await getOrComputeCoreAsync(cloud(5), PARAMS, async () => fakeCore('computed'));
    expect(lastTerrainCorePersistenceMiss()).toBe('generation-mismatch');
    await getOrComputeCoreAsync(cloud(5), PARAMS, async () => fakeCore('computed'));
    expect(lastTerrainCoreSource()).toBe('memory');
    expect(lastTerrainCorePersistenceMiss()).toBeNull();
  });

  it('a corrupt persisted entry recomputes and reads as an integrity failure', async () => {
    const root = fakeOpfsDir();
    const positions = smallCloud();
    const real = computeTerrainCore(positions, SMALL_PARAMS);
    const store = createTerrainCoreStore(root, { generation: 'g1' });
    expect(await store.persist(positions, SMALL_PARAMS, real, 5000)).toBe(true);
    // Flip a byte of the stored payload: the recorded digest no longer holds.
    const dir = await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR);
    const names: string[] = [];
    for await (const k of dir.keys()) if (k.endsWith('.bin')) names.push(k);
    const bytes = new Uint8Array(await (await (await dir.getFileHandle(names[0])).getFile()).arrayBuffer());
    bytes[bytes.byteLength - 1] ^= 0x01;
    const w = await (await dir.getFileHandle(names[0], { create: true })).createWritable();
    await w.write(bytes);
    await w.close();

    setTerrainCorePersistence(store);
    const compute = vi.fn(async () => fakeCore('recomputed'));
    const core = await getOrComputeCoreAsync(positions, SMALL_PARAMS, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect((core as unknown as { tag: string }).tag).toBe('recomputed');
    expect(lastTerrainCoreSource()).toBe('computed');
    expect(lastTerrainCorePersistenceMiss()).toBe('integrity-failure');
  });
});
