/**
 * heavyLasBridge.test.ts — the out-of-core local LAS open path, made reachable.
 *
 * The out-of-core cluster (sliced reader, indexer, spill store, tile store,
 * OlvTileSource) was fully built and tested but had no caller: opening a large
 * uncompressed LAS took the whole-file loader, which allocates the entire file
 * as one ArrayBuffer. These cases pin the bridge that routes a `buildThenStream`
 * LAS to worker → OPFS → OlvTileSource → streaming attach instead.
 *
 * The INSTRUMENTED case is the one the audit asked for: a range source that
 * counts every read and records the largest single one, and a File whose
 * whole-file `arrayBuffer()` is a spy, so the test can prove the open never
 * materialises the file — the largest read is a bounded batch, far smaller than
 * the file, and `File.arrayBuffer()` is never called.
 *
 * The browser-only seams are faked the way the repo already fakes them: OPFS is
 * `tests/support/fakeOpfs.ts`, and the index "worker" runs the real build
 * in-process against that fake OPFS so the whole path — header peek, plan,
 * preflight, build, reopen, attach — executes under Node. The worker MESSAGE
 * boundary itself (postMessage of a File) is the one part not exercised here; it
 * is a thin transport over the same `buildLocalOocStore` this drives directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { InstrumentedRangeSource } from '../src/io/range/InstrumentedRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { fakeOpfs } from './support/fakeOpfs';
import { buildLocalOocStore } from '../src/io/heavy/localOocBuild';
import { OlvTileSource } from '../src/io/heavy/OlvTileSource';
import {
  openLocalHeavyLas,
  type HeavyLasBridgeDeps,
  type HeavyLasBridgeEnv,
} from '../src/app/openLocalHeavyLas';
import type { StorageEstimateReading } from '../src/io/heavy/storagePreflight';
import type { Viewer } from '../src/render/Viewer';

const WORLD_MIN = [400000, 5200000, 55] as const;

/** A modest uncompressed LAS: a few MB, enough that a bounded batch is a small
 *  fraction of it. */
function lasBytes(n: number): ArrayBuffer {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = WORLD_MIN[0] + (i % 200) * 1.5;
    y[i] = WORLD_MIN[1] + Math.floor(i / 200) * 1.5;
    z[i] = WORLD_MIN[2] + (i % 13) * 0.4;
    intensity[i] = i & 0xffff;
    classification[i] = 2;
  }
  const cloud: GlobalPoints = { count: n, x, y, z, intensity, classification };
  const bytes = writeLas14(cloud);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A File stand-in whose whole-file read is a spy, so a test can prove it is
 *  never called. The bridge reads through a RangeSource, never this. */
function spyFile(name: string, size: number): { file: File; arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(size));
  const file = { name, size, arrayBuffer } as unknown as File;
  return { file, arrayBuffer };
}

/** A range source that records every read's length. */
function counting(inner: RangeSource): { range: RangeSource; reads: number[] } {
  const reads: number[] = [];
  const range = new InstrumentedRangeSource(inner, (bytes) => reads.push(bytes));
  return { range, reads };
}

/** A viewer stub that records the streaming attach. */
function fakeViewer() {
  let attachedSource: unknown;
  const attachStreamingCloud = vi.fn(async (source: unknown) => {
    attachedSource = source;
  });
  const getAttached = (): unknown => attachedSource;
  const viewer = {
    ready: Promise.resolve(),
    attachStreamingCloud,
    activeBackend: () => 'webgl2' as const,
    setMode: vi.fn(),
    frameAll: vi.fn(),
    hasStreamingCloud: false,
    clouds: () => [],
  };
  return { viewer, attachStreamingCloud, getAttached };
}

function fakeDock() {
  return {
    setEmpty: vi.fn(),
    setMeasureEnabled: vi.fn(),
    setAnnotateEnabled: vi.fn(),
    setInspectEnabled: vi.fn(),
    setProbeEnabled: vi.fn(),
    setCloseEnabled: vi.fn(),
    setBackend: vi.fn(),
  };
}

function makeDeps(over: { deviceMemoryGB?: number } = {}) {
  const { viewer, attachStreamingCloud, getAttached } = fakeViewer();
  const dock = fakeDock();
  const navBar = { element: { classList: { remove: vi.fn() } }, setMode: vi.fn(), flashHelp: vi.fn() };
  const inspector = { setEmpty: vi.fn() };
  const phases: string[] = [];
  const deps: HeavyLasBridgeDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer as unknown as Viewer,
    isPhone: () => false,
    renderBudget: 2_000_000,
    deviceMemoryGB: () => over.deviceMemoryGB ?? 0.001,
    dock,
    inspector,
    navBar,
    stage: { hideEmptyState: vi.fn() },
    body: { classList: { add: vi.fn() } },
    setPhase: (p) => phases.push(p),
    debug: false,
  };
  return { deps, viewer, attachStreamingCloud, getAttached, dock, navBar, inspector, phases };
}

/** An env whose OOC seams are fakes: OPFS in memory, the "worker" run in
 *  process against that same OPFS and the same instrumented range. */
function makeEnv(opts: {
  range: RangeSource;
  reading?: StorageEstimateReading;
  batchPoints?: number;
  capable?: boolean;
}): { env: HeavyLasBridgeEnv; opfs: ReturnType<typeof fakeOpfs> } {
  const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
  const reading: StorageEstimateReading = opts.reading ?? {
    available: true,
    quotaBytes: 200_000_000_000,
    usageBytes: 0,
  };
  const env: HeavyLasBridgeEnv = {
    capable: () => opts.capable ?? true,
    openRange: () => opts.range,
    getOpfsRoot: async () => opfs.root,
    readStorage: async () => reading,
    async runIndex(req) {
      // The real build, in process, against the fake OPFS and the same
      // instrumented range the header peek used.
      return buildLocalOocStore(opts.range, opfs.root, req.storeName, {
        pointsPerLeaf: req.pointsPerLeaf,
        memoryBudgetBytes: req.memoryBudgetBytes,
        maxDepth: req.maxDepth,
        batchPoints: opts.batchPoints ?? 4096,
        signal: req.signal,
        onPhase: req.onPhase,
      });
    },
  };
  return { env, opfs };
}

describe('openLocalHeavyLas — the out-of-core local LAS bridge', () => {
  it('opens a heavy LAS through ranged reads only, never the whole file', async () => {
    // A file well past the sliced reader's fixed header cap, so "far smaller
    // than the file" is a real ratio rather than an artefact of a tiny fixture.
    const n = 2_000_000;
    const buffer = lasBytes(n);
    const fileBytes = buffer.byteLength;
    const { range, reads } = counting(new ArrayBufferRangeSource(buffer));
    const { file, arrayBuffer } = spyFile('heavy.las', fileBytes);
    const { deps, attachStreamingCloud, getAttached } = makeDeps();
    const { env } = makeEnv({ range, batchPoints: 4096 });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    // The bridge took the OOC path and attached a streaming source.
    expect(result.status).toBe('attached');
    expect(attachStreamingCloud).toHaveBeenCalledTimes(1);
    const attached = getAttached() as OlvTileSource;
    expect(attached).toBeInstanceOf(OlvTileSource);
    expect(result.status === 'attached' && result.source).toBe(attached);

    // The resulting cloud reports the right point count.
    expect(attached.sourcePointCount).toBe(n);

    // THE AUDIT'S ASSERTION. No whole-file read happened: File.arrayBuffer was
    // never called, and the largest single ranged read is bounded — the sliced
    // reader's fixed header cap plus one batch — so it does NOT scale with the
    // file and is far smaller than it.
    expect(arrayBuffer).not.toHaveBeenCalled();
    const largest = Math.max(...reads);
    expect(reads.length).toBeGreaterThan(1);
    // The fixed header cap is 4 MiB (slicedLasReader.MAX_HEAD_BYTES); a batch of
    // 4096 records adds at most a few hundred KiB.
    const READ_CAP = 4 * 1024 * 1024 + 512 * 1024;
    expect(largest).toBeLessThanOrEqual(READ_CAP);
    expect(largest).toBeLessThan(fileBytes / 10);

    // And it streams: decoding every node yields exactly the source points.
    if (result.status !== 'attached') throw new Error('unreachable');
    const decoder = result.decoder;
    let streamed = 0;
    for (const node of attached.octree.nodes()) {
      if (node.record.pointCount === 0) continue;
      const decoded = await decoder.decode(
        await attached.readNodeChunk(node.record),
        attached.decodeMeta(node.record),
      );
      streamed += decoded.pointCount;
    }
    expect(streamed).toBe(n);
  });

  it('leaves a modest LAS on the whole-file path (not-heavy)', async () => {
    const buffer = lasBytes(40_000);
    const { range } = counting(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('small.las', buffer.byteLength);
    // Plenty of device memory: the plan does not route this file out of core.
    const { deps, attachStreamingCloud } = makeDeps({ deviceMemoryGB: 8 });
    const { env } = makeEnv({ range });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('not-heavy');
    expect(attachStreamingCloud).not.toHaveBeenCalled();
  });

  it('falls back (unavailable) when OPFS or workers are absent', async () => {
    const buffer = lasBytes(160_000);
    const { range } = counting(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('heavy.las', buffer.byteLength);
    const { deps, attachStreamingCloud } = makeDeps();
    const { env } = makeEnv({ range, capable: false });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('unavailable');
    expect(attachStreamingCloud).not.toHaveBeenCalled();
  });

  it('surfaces the preflight refusal and builds nothing when storage cannot be checked', async () => {
    const buffer = lasBytes(160_000);
    const { range } = counting(new ArrayBufferRangeSource(buffer));
    const { file } = spyFile('heavy.las', buffer.byteLength);
    const { deps, attachStreamingCloud } = makeDeps();
    const { env, opfs } = makeEnv({
      range,
      reading: { available: false, reason: 'no navigator.storage in this test' },
    });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.error.message).toContain('heavy.las');
    }
    // Nothing was attached and nothing was written to OPFS.
    expect(attachStreamingCloud).not.toHaveBeenCalled();
    expect(opfs.topLevel()).toEqual([]);
  });
});
