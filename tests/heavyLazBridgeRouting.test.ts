/**
 * heavyLazBridgeRouting.test.ts — a heavy chunked LAZ reaches the out-of-core
 * build, a heavy non-chunkable LAZ fails closed, and a small LAZ opens whole.
 *
 * The chunked-LAZ tile builder (`buildTileStoreFromLaz`) and its PointSource
 * landed fully tested but had no caller: a compressed LAZ always took the
 * whole-file path. These cases pin the routing that sends a `buildThenStream`
 * chunked LAZ to worker -> OPFS -> OlvTileSource, and — the fail-closed half —
 * refuses a heavy LAZ whose chunk table cannot randomly decode rather than
 * letting it fall through to the multi-gigabyte whole-file decode.
 *
 * Fixtures are the ones the builder tests already use: multichunk.laz (PDRF 7,
 * 3 real laszip chunks, 120 000 points) for the chunkable heavy case, and the
 * same file with its laszip VLR compressor flipped to 1 (pointwise) for the
 * no-usable-chunk-table case — heavy by the same header count, but with no
 * chunk table the fast path can address.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { parseLasHeader } from '../src/io/lasHeader';
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

function loadFixture(name: string): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** multichunk.laz with the laszip VLR compressor set to 1 (pointwise): a real
 *  LAZ, still declaring 120 000 points, but with no chunk table to address. The
 *  compressor field sits at byte 429 in this fixture (VLR payload start). */
function pointwiseLaz(): ArrayBuffer {
  const buf = loadFixture('multichunk.laz').slice(0);
  new DataView(buf).setUint16(429, 1, true);
  return buf;
}

function spyFile(name: string, size: number): { file: File; arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(size));
  const file = { name, size, arrayBuffer } as unknown as File;
  return { file, arrayBuffer };
}

function fakeViewer() {
  let attachedSource: unknown;
  const attachStreamingCloud = vi.fn(async (source: unknown) => {
    attachedSource = source;
  });
  const viewer = {
    ready: Promise.resolve(),
    attachStreamingCloud,
    activeBackend: () => 'webgl2' as const,
    availableImageExportModes: () => new Map(),
    setMode: vi.fn(),
    frameAll: vi.fn(),
    hasStreamingCloud: false,
    clouds: () => [],
  };
  return { viewer, attachStreamingCloud, getAttached: () => attachedSource };
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

function makeDeps(over: { deviceMemoryGB?: number } = {}) {
  const { viewer, attachStreamingCloud, getAttached } = fakeViewer();
  const dock = {
    setEmpty: vi.fn(), setMeasureEnabled: vi.fn(), setAnnotateEnabled: vi.fn(),
    setInspectEnabled: vi.fn(), setProbeEnabled: vi.fn(), setCloseEnabled: vi.fn(), setBackend: vi.fn(),
  };
  const navBar = { element: { classList: { remove: vi.fn() } }, setMode: vi.fn(), flashHelp: vi.fn() };
  const inspector = { setEmpty: vi.fn() };
  const deps: HeavyLasBridgeDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer as unknown as Viewer,
    isPhone: () => false,
    renderBudget: 2_000_000,
    deviceMemoryGB: () => over.deviceMemoryGB ?? 0.001,
    dock, inspector, navBar,
    stage: { hideEmptyState: vi.fn() },
    body: { classList: { add: vi.fn() } },
    setPhase: vi.fn(),
    debug: false,
    streaming: fakeStreaming(viewer),
  };
  return { deps, attachStreamingCloud, getAttached };
}

function makeEnv(opts: { buffer: ArrayBuffer; capable?: boolean }): {
  env: HeavyLasBridgeEnv;
  runIndex: ReturnType<typeof vi.fn>;
} {
  const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
  const reading: StorageEstimateReading = { available: true, quotaBytes: 200_000_000_000, usageBytes: 0 };
  const runIndex = vi.fn(async (req: { storeName: string; kind?: 'las' | 'laz'; pointsPerLeaf?: number; memoryBudgetBytes?: number; maxDepth?: number; signal?: AbortSignal; onPhase?: (p: 'indexing' | 'finishing') => void }) => {
    return buildLocalOocStore(new ArrayBufferRangeSource(opts.buffer), opfs.root, req.storeName, {
      kind: req.kind,
      pointsPerLeaf: req.pointsPerLeaf,
      memoryBudgetBytes: req.memoryBudgetBytes,
      maxDepth: req.maxDepth,
      signal: req.signal,
      onPhase: req.onPhase,
    });
  });
  const env: HeavyLasBridgeEnv = {
    capable: () => opts.capable ?? true,
    openRange: () => new ArrayBufferRangeSource(opts.buffer),
    getOpfsRoot: async () => opfs.root,
    readStorage: async () => reading,
    runIndex: runIndex as unknown as HeavyLasBridgeEnv['runIndex'],
  };
  return { env, runIndex };
}

describe('openLocalHeavyLas — chunked LAZ routing', () => {
  it('routes a heavy chunked LAZ to the out-of-core build and attaches it', async () => {
    const buffer = loadFixture('multichunk.laz');
    const { file } = spyFile('multichunk.laz', buffer.byteLength);
    const { deps, attachStreamingCloud, getAttached } = makeDeps();
    const { env, runIndex } = makeEnv({ buffer });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('attached');
    expect(runIndex).toHaveBeenCalledTimes(1);
    expect(runIndex.mock.calls[0][0].kind).toBe('laz');
    expect(attachStreamingCloud).toHaveBeenCalledTimes(1);
    const attached = getAttached() as OlvTileSource;
    expect(attached).toBeInstanceOf(OlvTileSource);
    expect(attached.sourcePointCount).toBe(120_000);
  });

  it('fails closed on a heavy LAZ with no usable chunk table, never dispatching a build', async () => {
    const buffer = pointwiseLaz();
    const { file, arrayBuffer } = spyFile('pointwise.laz', buffer.byteLength);
    const { deps, attachStreamingCloud } = makeDeps();
    const { env, runIndex } = makeEnv({ buffer });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status !== 'not-heavy' && result.status !== 'attached' && result.status !== 'cancelled').toBe(true);
    if (result.status === 'unavailable' || result.status === 'refused' || result.status === 'failed') {
      expect(result.heavy).toBe(true);
    }
    // The chunk-table read decided before any heavy work: no build, no whole read.
    expect(runIndex).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(attachStreamingCloud).not.toHaveBeenCalled();
  });

  it('leaves a small chunked LAZ on the whole-file path (not-heavy)', async () => {
    const buffer = loadFixture('multichunk.laz');
    const { file } = spyFile('multichunk.laz', buffer.byteLength);
    const { deps, attachStreamingCloud } = makeDeps({ deviceMemoryGB: 8 });
    const { env, runIndex } = makeEnv({ buffer });

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);

    expect(result.status).toBe('not-heavy');
    expect(runIndex).not.toHaveBeenCalled();
    expect(attachStreamingCloud).not.toHaveBeenCalled();
  });
});

describe('buildLocalOocStore — the worker build routes by kind', () => {
  it('builds a LAZ store through the chunked-LAZ builder', async () => {
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    const range = new ArrayBufferRangeSource(loadFixture('multichunk.laz'));
    const built = await buildLocalOocStore(range, opfs.root, 'laz-store', { kind: 'laz' });
    expect(built.pointCount).toBe(120_000);
  });

  it('builds a LAS store through the LAS builder', async () => {
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    const range = new ArrayBufferRangeSource(loadFixture('tiny.las'));
    const header = parseLasHeader(loadFixture('tiny.las'));
    const built = await buildLocalOocStore(range, opfs.root, 'las-store', { kind: 'las' });
    expect(built.pointCount).toBe(header.pointCount);
  });

  it('routes by kind: a plain LAS handed to the LAZ builder is refused, not decoded', async () => {
    // An uncompressed LAS has no laszip VLR, so the chunked-LAZ source throws.
    // If kind did not reach the build, the LAS builder would index it silently;
    // the throw proves kind:'laz' actually selected buildTileStoreFromLaz.
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    const range = new ArrayBufferRangeSource(loadFixture('tiny.las'));
    await expect(buildLocalOocStore(range, opfs.root, 'wrong-store', { kind: 'laz' })).rejects.toThrow(
      /chunk table/i,
    );
  });
});
