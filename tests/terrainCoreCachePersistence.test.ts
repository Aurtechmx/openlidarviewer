/**
 * terrainCoreCachePersistence.test.ts
 *
 * The in-memory core cache consults the persistent tier on a miss and hands
 * a computed core to it afterwards, without ever delaying the result: the
 * caller has its core before the tier is asked to write. A tier that throws
 * is a miss, and a restored core is reported as such. The tier here is a pair
 * of spies. No OPFS is involved.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getOrComputeCoreAsync,
  clearTerrainCoreCache,
  setTerrainCorePersistence,
  lastTerrainCoreSource,
} from '../src/terrain/contour/terrainCoreCache';
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
});
