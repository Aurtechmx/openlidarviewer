/**
 * A geographic scan beyond ±89° is refused with the latitude reason before the
 * terrain worker runs. Were the worker asked, its error would read as a worker
 * failure and be retried on the main thread, where a large scan's size refusal
 * would replace the reason.
 */
import { describe, expect, it, vi } from 'vitest';
import { computeTerrainCoreAsync, type TerrainCoreClientLike } from '../src/terrain/worker/computeTerrainCoreAsync';
import { GeographicLatitudeError } from '../src/terrain/ground/horizontalScale';
import type { TerrainCoreParams } from '../src/terrain/contour/analyseContours';

describe('a polar geographic terrain run', () => {
  it('is refused with the latitude reason and never reaches the worker or the main-thread fallback', async () => {
    const computeCore = vi.fn(() => Promise.reject(new Error('worker should not be called')));
    const client = { computeCore } as unknown as TerrainCoreClientLike;
    const n = 5_000_000; // far above the main-thread fallback ceiling
    const run = computeTerrainCoreAsync(
      new Float32Array(9),
      n,
      { cellSizeM: 0.0001, isGeographic: true, latitudeDeg: 89.9 } as TerrainCoreParams,
      undefined,
      undefined,
      client,
      { enforceLimits: true },
    );
    await expect(run).rejects.toBeInstanceOf(GeographicLatitudeError);
    await expect(run).rejects.toThrow(/polar projected CRS/);
    expect(computeCore).not.toHaveBeenCalled();
  });

  it('a projected scan at the same latitude value is not refused', async () => {
    const computeCore = vi.fn(() => Promise.resolve({ ok: true }));
    const client = { computeCore } as unknown as TerrainCoreClientLike;
    await computeTerrainCoreAsync(new Float32Array(9), 3, { cellSizeM: 1, isGeographic: false, latitudeDeg: 89.9 } as TerrainCoreParams, undefined, undefined, client);
    expect(computeCore).toHaveBeenCalledTimes(1);
  });
});
