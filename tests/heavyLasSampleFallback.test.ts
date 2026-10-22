/**
 * heavyLasSampleFallback.test.ts: a heavy file the index cannot be built for
 * opens as an even sample instead of being refused.
 *
 * Browser storage that is too small (or absent) used to end the open with a
 * refusal. Now the stratified sample opens as the scan, labelled as a sample,
 * without the surfaces that describe a finished scan.
 */
import { describe, it, expect, vi } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { fakeOpfs } from './support/fakeOpfs';
import { lasBytes, makeDeps, spyFile } from './support/heavyLasHarness';
import { buildLocalOocStore } from '../src/io/heavy/localOocBuild';
import { PreviewCloudSource } from '../src/io/heavy/OlvTileSource';
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
    getOpfsRoot: async () => (opts.noOpfs ? null : opfs.root),
    readStorage: async () => opts.storage ?? reading(200_000_000_000),
    runIndex: runIndex as unknown as HeavyLasBridgeEnv['runIndex'],
  };
  return { env, runIndex };
}

describe('heavy open: sample fallback', () => {
  const n = 400_000;

  it('opens a sample when browser storage is too small, and builds no index', async () => {
    const buffer = lasBytes(n);
    const range = new ArrayBufferRangeSource(buffer);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps, attached, attachStreamingCloud } = makeDeps();
    const { env, runIndex } = envWith(range, { storage: reading(1_000_000) });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('sampled');
    expect(runIndex).not.toHaveBeenCalled();
    expect(attachStreamingCloud).toHaveBeenCalledTimes(1);
    const source = attached[0] as PreviewCloudSource;
    expect(source).toBeInstanceOf(PreviewCloudSource);
    expect(source.sourcePointCount).toBeGreaterThan(0);
    expect(source.sourcePointCount).toBeLessThanOrEqual(n);
    if (result.status === 'sampled') {
      expect(result.notice).toMatch(/^Opened (a sample of|all) /);
      expect(result.notice).toMatch(/of browser storage/);
      expect(result.notice).toMatch(/Free disk space and reopen the file/);
      expect(result.notice).toMatch(/convert it to COPC/i);
    }
  });

  it('does not publish the surfaces of a finished scan for the sample', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps } = makeDeps();
    const { env } = envWith(new ArrayBufferRangeSource(buffer), { storage: reading(1_000_000) });
    await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    const s = deps.streaming as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>> | ReturnType<typeof vi.fn>>;
    expect((s.inspectorCards as Record<string, ReturnType<typeof vi.fn>>).refreshProvenanceFromStreaming).not.toHaveBeenCalled();
    expect((s.crsCoordinator as Record<string, ReturnType<typeof vi.fn>>).refreshCrsForStreamingCloud).not.toHaveBeenCalled();
    expect(s.revealAnalysePanel as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // The previous stream's state is still cleared, as for any committed scan.
    expect(s.resetStreamState as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('opens a sample when the browser has no storage to write the index to', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps, attached } = makeDeps();
    const { env, runIndex } = envWith(new ArrayBufferRangeSource(buffer), { noOpfs: true });
    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('sampled');
    expect(runIndex).not.toHaveBeenCalled();
    expect(attached[0]).toBeInstanceOf(PreviewCloudSource);
  });

  it('opens a sample when the browser cannot report its storage', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps } = makeDeps();
    const { env } = envWith(new ArrayBufferRangeSource(buffer), { storage: { available: false, reason: 'no estimate' } });
    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('sampled');
    if (result.status === 'sampled') expect(result.notice).toMatch(/does not report how much storage/);
  });

  it('still opens the full index when storage is enough', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps } = makeDeps();
    const range = new ArrayBufferRangeSource(buffer);
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    const env: HeavyLasBridgeEnv = {
      capable: () => true,
      openRange: () => range,
      getOpfsRoot: async () => opfs.root,
      readStorage: async () => reading(200_000_000_000),
      async runIndex(req) {
        return buildLocalOocStore(range, opfs.root, req.storeName, {
          pointsPerLeaf: req.pointsPerLeaf, memoryBudgetBytes: req.memoryBudgetBytes, maxDepth: req.maxDepth,
          batchPoints: 4096, signal: req.signal, onPhase: req.onPhase,
        });
      },
    };
    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('attached');
  });

  it('is cancelled, not refused, when the open is cancelled while sampling', async () => {
    const buffer = lasBytes(n);
    const { file } = spyFile('big.las', buffer.byteLength);
    const { deps, attachStreamingCloud } = makeDeps();
    const { env } = envWith(new ArrayBufferRangeSource(buffer), { storage: reading(1_000_000) });
    const controller = new AbortController();
    controller.abort();
    const result = await openLocalHeavyLas(file, controller.signal, deps, env);
    expect(['cancelled', 'not-heavy']).toContain(result.status);
    expect(attachStreamingCloud).not.toHaveBeenCalled();
  });
});

describe('storageSampleNotice', () => {
  it('does not call the whole file a sample', () => {
    const v = { outcome: 'insufficient-storage', proceed: false, requiredBytes: 3e6, availableBytes: 1e6, reservedBytes: 0, freeBytes: 1e6, quotaBytes: 1e6, usageBytes: 0, message: '', pointCount: 120_000 } as const;
    const text = storageSampleNotice(v, 'small.las', 120_000, 120_000);
    expect(text).toContain('Opened all 120,000 points of small.las without its streaming index.');
    expect(text).not.toContain('sample');
  });

  it('states the figures, that it is a sample, and the two ways out', () => {
    const text = storageSampleNotice(
      { outcome: 'insufficient-storage', proceed: false, requiredBytes: 6.3e9, availableBytes: 1.7e9, reservedBytes: 0, freeBytes: 1.7e9, quotaBytes: 2e9, usageBytes: 0, message: '', pointCount: 210_900_000 },
      'scan.laz', 2_000_000, 210_900_000,
    );
    expect(text).toContain('Opened a sample of 2.0 million points of 210.9 million points from scan.laz');
    expect(text).toContain('not the whole file');
    expect(text).toMatch(/needs about .* of browser storage and about .* is available/);
    expect(text).toMatch(/Free disk space and reopen the file/);
  });
});
