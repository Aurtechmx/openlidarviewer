/**
 * heavyLasPreviewFirst.test.ts — the heavy open shows a preview before the index.
 *
 * A multi-gigabyte LAS/LAZ takes a long time to index out of core, and until the
 * index returns nothing is on screen. The preview-first path reads a bounded,
 * stratified SAMPLE of the cloud and attaches it immediately through the same
 * `attachStreamingCloud` the real source uses, then replaces it with the full
 * streamed index when the build completes. These cases pin that behaviour:
 *
 *  1. ordering — a preview (a `PreviewCloudSource`, reporting the SAMPLE count)
 *     is attached BEFORE the index build resolves; the full `OlvTileSource` (the
 *     real count) is attached second, replacing it.
 *  2. stratified + bounded — the sample's reads span the whole file and no
 *     whole-file read happens (an instrumented range plus a `File.arrayBuffer`
 *     spy).
 *  3. cancel — cancelling during the preview or the index tears down cleanly:
 *     the preview is detached, no store is left in OPFS.
 *  4. honesty — the preview reports its sample size, not the file total, and its
 *     octree is marked incomplete.
 *
 * The browser seams are the repo's usual fakes: OPFS is `tests/support/fakeOpfs`
 * and the "worker" runs the real build in process. The one addition is a
 * DEFERRED runIndex, so a test can observe the scene while the build is pending.
 */
import { describe, it, expect } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource, RangeSourceKind } from '../src/io/range/RangeSource';
import { fakeOpfs } from './support/fakeOpfs';
import { lasBytes, makeDeps, spyFile } from './support/heavyLasHarness';
import { buildLocalOocStore } from '../src/io/heavy/localOocBuild';
import { OlvTileSource, PreviewCloudSource } from '../src/io/heavy/OlvTileSource';
import { buildPreviewSample } from '../src/io/heavy/previewSampler';
import {
  openLocalHeavyLas,
  type HeavyLasBridgeEnv,
} from '../src/app/openLocalHeavyLas';
import type { StorageEstimateReading } from '../src/io/heavy/storagePreflight';

/** A range source that records each read's absolute offset and length, so a
 *  test can prove the sample spans the file and never reads it whole. */
class RecordingRange implements RangeSource {
  readonly reads: Array<{ offset: number; length: number }> = [];
  private readonly inner: RangeSource;
  constructor(inner: RangeSource) {
    this.inner = inner;
  }
  id(): string {
    return this.inner.id();
  }
  kind(): RangeSourceKind {
    return this.inner.kind();
  }
  size(): Promise<number> {
    return this.inner.size();
  }
  async readRange(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const buf = await this.inner.readRange(offset, length, signal);
    this.reads.push({ offset, length: buf.byteLength });
    return buf;
  }
}

/** A deferred so a test can hold the build pending, then release it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeEnv(opts: {
  range: RangeSource;
  gate?: Promise<void>;
  onBuildStart?: () => void;
}): { env: HeavyLasBridgeEnv; opfs: ReturnType<typeof fakeOpfs> } {
  const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
  const reading: StorageEstimateReading = { available: true, quotaBytes: 200_000_000_000, usageBytes: 0 };
  const env: HeavyLasBridgeEnv = {
    capable: () => true,
    openRange: () => opts.range,
    getOpfsRoot: async () => opfs.root,
    readStorage: async () => reading,
    async runIndex(req) {
      opts.onBuildStart?.();
      if (opts.gate) await opts.gate;
      return buildLocalOocStore(opts.range, opfs.root, req.storeName, {
        pointsPerLeaf: req.pointsPerLeaf,
        memoryBudgetBytes: req.memoryBudgetBytes,
        maxDepth: req.maxDepth,
        batchPoints: 4096,
        signal: req.signal,
        onPhase: req.onPhase,
      });
    },
  };
  return { env, opfs };
}

/**
 * Wait until `cond` holds, letting the sampler's awaits drain.
 *
 * Bounded by elapsed time, not by a count of scheduler turns. The preview
 * sampler yields once per batch, so the number of turns before the condition
 * holds tracks the batch size and the host's scheduling, not whether the code
 * under test is correct — a fixed count expired on the slower Windows runner
 * while the work was still progressing. The budget is well under the 15 s test
 * timeout, so a condition that never holds still fails here with this message.
 */
async function waitFor(cond: () => boolean, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out after ${budgetMs} ms`);
}

describe('heavy open — preview-first attach and swap', () => {
  it('attaches a preview before the index, then replaces it with the full source', async () => {
    const n = 400_000;
    const buffer = lasBytes(n);
    const range = new RecordingRange(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('heavy.las', buffer.byteLength);
    const { deps, attachStreamingCloud, attached } = makeDeps();

    const gate = deferred<void>();
    let buildStarted = false;
    const { env } = makeEnv({ range, gate: gate.promise, onBuildStart: () => (buildStarted = true) });

    const open = openLocalHeavyLas(file, new AbortController().signal, deps, env);

    // The index build has begun (and is gated). The preview must already be up,
    // since the executor attaches it before it calls runIndex.
    await waitFor(() => buildStarted);
    expect(attachStreamingCloud).toHaveBeenCalledTimes(1);
    const preview = attached[0] as PreviewCloudSource;
    expect(preview).toBeInstanceOf(PreviewCloudSource);
    // The preview reports the SAMPLE size — fewer than the file's points.
    expect(preview.sourcePointCount).toBeGreaterThan(0);
    expect(preview.sourcePointCount).toBeLessThanOrEqual(n);
    expect(preview.octree.isComplete).toBe(false);

    // Release the build. The full source attaches second and replaces the preview.
    gate.resolve();
    const result = await open;
    expect(result.status).toBe('attached');
    expect(attachStreamingCloud).toHaveBeenCalledTimes(2);
    const full = attached[1] as OlvTileSource;
    expect(full).toBeInstanceOf(OlvTileSource);
    expect(full.sourcePointCount).toBe(n);
  });

  it('samples across the whole file with bounded reads, never the whole file', async () => {
    const n = 400_000;
    const buffer = lasBytes(n);
    const fileBytes = buffer.byteLength;
    const range = new RecordingRange(new ArrayBufferRangeSource(buffer));
    const { file, arrayBuffer } = spyFile('heavy.las', fileBytes);
    const { deps } = makeDeps();
    const { env } = makeEnv({ range });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('attached');

    // The whole-file read never happened.
    expect(arrayBuffer).not.toHaveBeenCalled();

    // The sample's point-data reads (past the header/VLR region) span the file:
    // the earliest and the latest start far apart, across most of the file.
    const offsetToPointData = 375; // LAS 1.4 minimal header; point reads are well past it.
    const pointReads = range.reads.filter((r) => r.offset >= offsetToPointData);
    const offsets = pointReads.map((r) => r.offset);
    const earliest = Math.min(...offsets);
    const latest = Math.max(...offsets);
    expect(pointReads.length).toBeGreaterThan(8);
    // A front-only sample would put every read near the start; a stratified one
    // reaches into the last third of the file.
    expect(latest - earliest).toBeGreaterThan(fileBytes / 2);

    // No single read approaches the file: the sliced reader's fixed 4 MiB header
    // cap plus at most one stratum batch, independent of the file size.
    const READ_CAP = 4 * 1024 * 1024 + 1 * 1024 * 1024;
    const largest = Math.max(...range.reads.map((r) => r.length));
    expect(largest).toBeLessThanOrEqual(READ_CAP);
    expect(largest).toBeLessThan(fileBytes);
  });

  it('tears down the preview and leaves no store when cancelled during the index', async () => {
    const n = 400_000;
    const buffer = lasBytes(n);
    const range = new RecordingRange(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('heavy.las', buffer.byteLength);
    const { deps, attachStreamingCloud, detachStreamingCloud, attached } = makeDeps();
    const controller = new AbortController();

    const gate = deferred<void>();
    const { env, opfs } = makeEnv({
      range,
      gate: gate.promise,
      onBuildStart: () => {
        // The build has started and the preview is up; cancel now, then let the
        // gated build observe the abort and throw.
        controller.abort();
        gate.resolve();
      },
    });

    const result = await openLocalHeavyLas(file, controller.signal, deps, env);

    expect(result.status).toBe('cancelled');
    // The preview WAS attached, and it WAS detached — no stuck preview.
    expect(attachStreamingCloud).toHaveBeenCalledTimes(1);
    expect(attached[0]).toBeInstanceOf(PreviewCloudSource);
    expect(detachStreamingCloud).toHaveBeenCalledTimes(1);
    // The partial store was discarded.
    expect(opfs.topLevel()).toEqual([]);
    // The preview's attach hid the empty state and revealed the dock and nav
    // bar over an empty viewer; with the preview gone the empty state is back.
    expect(deps.restoreEmptyState).toHaveBeenCalledTimes(1);
  });

  it('restores the empty state when the build fails after the preview on an empty viewer', async () => {
    const n = 400_000;
    const buffer = lasBytes(n);
    const range = new RecordingRange(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('heavy.las', buffer.byteLength);
    const { deps, attachStreamingCloud, detachStreamingCloud } = makeDeps();
    const { env } = makeEnv({ range });
    env.runIndex = async () => { throw new Error('index build failed'); };

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('failed');
    expect(attachStreamingCloud).toHaveBeenCalledTimes(1);
    expect(detachStreamingCloud).toHaveBeenCalledTimes(1);
    expect(deps.restoreEmptyState).toHaveBeenCalledTimes(1);
  });
});

describe('heavy open over a stream that is already on screen', () => {
  // The preview attaches as a stream, and a stream attach disposes the one on
  // screen. A build that then failed or was cancelled detached the preview and
  // left nothing, so the stream the user had was gone for a file that never
  // opened. Over a live stream the open shows no preview.
  it('leaves the stream in place when the open is cancelled during the index', async () => {
    const n = 400_000;
    const buffer = lasBytes(n);
    const range = new RecordingRange(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('heavy.las', buffer.byteLength);
    const { deps, viewer, attachStreamingCloud, detachStreamingCloud } = makeDeps();
    viewer.hasStreamingCloud = true;
    const controller = new AbortController();
    const { env } = makeEnv({
      range,
      onBuildStart: () => controller.abort(),
    });

    const result = await openLocalHeavyLas(file, controller.signal, deps, env);

    expect(result.status).toBe('cancelled');
    expect(attachStreamingCloud).not.toHaveBeenCalled();
    expect(detachStreamingCloud).not.toHaveBeenCalled();
    // The stream the user had is still the scene: nothing to restore.
    expect(deps.restoreEmptyState).not.toHaveBeenCalled();
  });

  it('attaches only the full source when the build completes', async () => {
    const n = 400_000;
    const buffer = lasBytes(n);
    const range = new RecordingRange(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('heavy.las', buffer.byteLength);
    const { deps, viewer, attachStreamingCloud, attached } = makeDeps();
    viewer.hasStreamingCloud = true;
    const { env } = makeEnv({ range });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('attached');
    expect(attachStreamingCloud).toHaveBeenCalledTimes(1);
    expect(attached[0]).toBeInstanceOf(OlvTileSource);
  });
});

describe('buildPreviewSample — stratified, bounded, honest', () => {
  it('reports the sample size, not the file total, and spans the file', async () => {
    const n = 400_000;
    const buffer = lasBytes(n);
    const range = new RecordingRange(new ArrayBufferRangeSource(buffer));

    // A small target so the sample is clearly a fraction of the file.
    const sample = await buildPreviewSample(
      range,
      { format: 'las', offsetToPointData: 375 },
      { targetPoints: 40_000, strata: 32 },
    );
    if (!sample) throw new Error('expected a sample');

    // Honesty: the sample count is well under the file total.
    expect(sample.pointCount).toBeGreaterThan(0);
    expect(sample.pointCount).toBeLessThanOrEqual(40_000);
    expect(sample.pointCount).toBeLessThan(n);

    // A PreviewCloudSource over it claims only the sample and is incomplete.
    const src = new PreviewCloudSource({ id: 'p', name: 'heavy.las', sample });
    expect(src.sourcePointCount).toBe(sample.pointCount);
    expect(src.octree.isComplete).toBe(false);

    // The chunk read rejects on an aborted signal instead of throwing.
    const node = src.octree.nodes().find((x) => x.record.pointCount > 0)!;
    const ctrl = new AbortController();
    ctrl.abort();
    let read: Promise<ArrayBuffer> | undefined;
    expect(() => { read = src.readNodeChunk(node.record, ctrl.signal); }).not.toThrow();
    await expect(read).rejects.toThrow();
    expect((await src.readNodeChunk(node.record)).byteLength).toBe(sample.records.byteLength);

    // Spread: reads reach deep into the file, not just the front.
    const pointReads = range.reads.filter((r) => r.offset >= 375);
    const spread = Math.max(...pointReads.map((r) => r.offset)) - Math.min(...pointReads.map((r) => r.offset));
    expect(spread).toBeGreaterThan(buffer.byteLength / 2);
  });

  it('returns null for a file too small to be worth a preview', async () => {
    const buffer = lasBytes(10_000);
    const range = new ArrayBufferRangeSource(buffer);
    const sample = await buildPreviewSample(range, { format: 'las', offsetToPointData: 375 });
    expect(sample).toBeNull();
  });
});
