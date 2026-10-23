/**
 * heavyLasSampleFallback.test.ts: a heavy file the index cannot be built for
 * opens as a sample instead of being refused.
 *
 * Browser storage that is too small (or absent) used to end the open with a
 * refusal. Now the heavy path builds nothing and hands the file back as a
 * `sample`: the loader reads a stratified stride of all its records by ranges
 * and opens it as an ordinary scan (see loadLasRangedSample.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { fakeOpfs } from './support/fakeOpfs';
import { lasBytes, makeDeps, spyFile } from './support/heavyLasHarness';
import { makeEnv } from './support/heavyLasFakes';
import {
  openLocalHeavyLas,
  type HeavyLasBridgeEnv,
} from '../src/app/openLocalHeavyLas';
import { storageSampleNotice, type StorageEstimateReading } from '../src/io/heavy/storagePreflight';

const reading = (quotaBytes: number, usageBytes = 0): StorageEstimateReading => ({ available: true, quotaBytes, usageBytes });

function envWith(range: RangeSource, opts: { storage?: StorageEstimateReading; noOpfs?: boolean } = {}) {
  const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
  const runIndex = vi.fn();
  const env: HeavyLasBridgeEnv = {
    capable: () => true,
    openRange: () => range,
    getOpfsRoot: () => Promise.resolve(opts.noOpfs ? null : opfs.root),
    readStorage: () => Promise.resolve(opts.storage ?? reading(200_000_000_000)),
    runIndex: runIndex as unknown as HeavyLasBridgeEnv['runIndex'],
  };
  return { env, runIndex };
}

describe('heavy open: sample fallback', () => {
  const n = 400_000;

  it('hands the file back as a sample when browser storage is too small, and builds no index', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps, attachStreamingCloud } = makeDeps();
    const { env, runIndex } = envWith(new ArrayBufferRangeSource(buffer), { storage: reading(1_000_000) });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('sample');
    expect(runIndex).not.toHaveBeenCalled();
    // Nothing is attached here: the loader opens the sample as an ordinary scan.
    expect(attachStreamingCloud).not.toHaveBeenCalled();
    if (result.status === 'sample') {
      expect(result.verdict?.outcome).toBe('insufficient-storage');
      // Nothing was on screen, so nothing was asked.
      expect(result.replaced).toBe('none');
      const notice = storageSampleNotice(result.verdict, 'big.las', 2_000_000, 210_887_303);
      expect(notice).toMatch(/^Opened an even sample of 2.0 million of the 210.9 million points in big\.las\./);
      expect(notice).toMatch(/of browser storage/);
      expect(notice).toMatch(/Free disk space and reopen the file/);
      expect(notice).toMatch(/convert it to COPC/i);
    }
  });

  it('hands the file back as a sample when the browser has no storage to write the index to', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps, attachStreamingCloud } = makeDeps();
    const { env, runIndex } = envWith(new ArrayBufferRangeSource(buffer), { noOpfs: true });
    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result).toEqual({ status: 'sample', verdict: null });
    expect(runIndex).not.toHaveBeenCalled();
    expect(attachStreamingCloud).not.toHaveBeenCalled();
  });

  it('hands the file back as a sample when the browser cannot report its storage', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps } = makeDeps();
    const { env } = envWith(new ArrayBufferRangeSource(buffer), { storage: { available: false, reason: 'no estimate' } });
    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('sample');
    if (result.status === 'sample') {
      expect(storageSampleNotice(result.verdict, 'big.las', 10, 20)).toMatch(/does not report how much storage/);
    }
  });

  it('still opens the full index when storage is enough', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps } = makeDeps();
    const env = makeEnv(new ArrayBufferRangeSource(buffer));
    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('attached');
  });
});
