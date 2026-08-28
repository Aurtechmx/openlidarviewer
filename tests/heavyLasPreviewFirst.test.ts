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
import { describe, it, expect, vi } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource, RangeSourceKind } from '../src/io/range/RangeSource';
import { fakeOpfs } from './support/fakeOpfs';
import { buildLocalOocStore } from '../src/io/heavy/localOocBuild';
import { OlvTileSource, PreviewCloudSource } from '../src/io/heavy/OlvTileSource';
import { buildPreviewSample } from '../src/io/heavy/previewSampler';
import {
  openLocalHeavyLas,
  type HeavyLasBridgeDeps,
  type HeavyLasBridgeEnv,
} from '../src/app/openLocalHeavyLas';
import type { StorageEstimateReading } from '../src/io/heavy/storagePreflight';
import type { Viewer } from '../src/render/Viewer';

const WORLD_MIN = [400000, 5200000, 55] as const;

/** An uncompressed LAS whose points span a wide XY grid, so a stratified sample
 *  across file order is a spread across the footprint. */
function lasBytes(n: number): ArrayBuffer {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = WORLD_MIN[0] + (i % 1000) * 1.5;
    y[i] = WORLD_MIN[1] + Math.floor(i / 1000) * 1.5;
    z[i] = WORLD_MIN[2] + (i % 13) * 0.4;
    intensity[i] = i & 0xffff;
    classification[i] = 2;
  }
  const cloud: GlobalPoints = { count: n, x, y, z, intensity, classification };
  const bytes = writeLas14(cloud);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function spyFile(name: string, size: number): { file: File; arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(size));
  const file = { name, size, arrayBuffer } as unknown as File;
  return { file, arrayBuffer };
}

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

/** A viewer stub recording every attach in order and whether a detach happened. */
function fakeViewer() {
  const attached: unknown[] = [];
  let current: unknown = null;
  const attachStreamingCloud = vi.fn(async (source: unknown) => {
    attached.push(source);
    current = source;
  });
  const detachStreamingCloud = vi.fn(() => {
    current = null;
  });
  const viewer = {
    ready: Promise.resolve(),
    attachStreamingCloud,
    detachStreamingCloud,
    activeBackend: () => 'webgl2' as const,
    availableImageExportModes: () => new Map(),
    setMode: vi.fn(),
    frameAll: vi.fn(),
    hasStreamingCloud: false,
    clouds: () => [],
  };
  return { viewer, attachStreamingCloud, detachStreamingCloud, attached, getCurrent: () => current };
}

function fakeStreaming(viewer: unknown) {
  return {
    getViewer: () => viewer,
    getStreamingQuality: () => 'balanced',
    debug: false,
    stage: { hideEmptyState: vi.fn() },
    streamingPanel: {
      setPhase: vi.fn(), show: vi.fn(), setColorModes: vi.fn(),
      setQuality: vi.fn(), setSummary: vi.fn(), setSourceUrl: vi.fn(),
    },
    exportPanel: { setImageExportEnabled: vi.fn(), setImageExportAvailability: vi.fn(), setStreamingMode: vi.fn() },
    inspector: { setStreamingMode: vi.fn(), setDetail: vi.fn(), setReport: vi.fn(), element: { classList: { remove: vi.fn() } } },
    classLegendPanel: { setClasses: vi.fn(), hide: vi.fn(), getVisibility: () => ({ isFiltered: () => false }) },
    inspectorCards: { refreshProvenanceFromStreaming: vi.fn(), refreshDatasetIntelligenceFromStreamingCloud: vi.fn() },
    crsCoordinator: { refreshCrsForStreamingCloud: vi.fn() },
    bookmarks: { clear: vi.fn() },
    hideReclassifyUi: vi.fn(),
    syncInspectClassScope: vi.fn(),
    prewarmExportStudio: vi.fn(),
    revealAnalysePanel: vi.fn(),
    startStreamingStatusPolling: vi.fn(),
    refreshViewsUI: vi.fn(),
    runStreamingModules: vi.fn(() => []),
    setLastStreamingReportCloud: vi.fn(),
  } as unknown as HeavyLasBridgeDeps['streaming'];
}

function makeDeps() {
  const v = fakeViewer();
  const navBar = { element: { classList: { remove: vi.fn() } }, setMode: vi.fn(), flashHelp: vi.fn() };
  const phases: string[] = [];
  const deps: HeavyLasBridgeDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => v.viewer as unknown as Viewer,
    isPhone: () => false,
    renderBudget: 2_000_000,
    deviceMemoryGB: () => 0.001,
    dock: {
      setEmpty: vi.fn(), setMeasureEnabled: vi.fn(), setAnnotateEnabled: vi.fn(),
      setInspectEnabled: vi.fn(), setProbeEnabled: vi.fn(), setCloseEnabled: vi.fn(), setBackend: vi.fn(),
    },
    inspector: { setEmpty: vi.fn() },
    navBar,
    stage: { hideEmptyState: vi.fn() },
    body: { classList: { add: vi.fn() } },
    setPhase: (p) => phases.push(p),
    debug: false,
    streaming: fakeStreaming(v.viewer),
  };
  return { deps, ...v, phases };
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

/** Wait until `cond` holds, letting the sampler's awaits drain. */
async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor timed out');
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
