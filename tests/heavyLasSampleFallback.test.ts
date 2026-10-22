/**
 * heavyLasSampleFallback.test.ts: a heavy file the index cannot be built for
 * opens as an even sample instead of being refused.
 *
 * Browser storage that is too small (or absent) used to end the open with a
 * refusal. Now the stratified sample opens as the scan, labelled as a sample,
 * without the surfaces that describe a finished scan.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { fakeOpfs } from './support/fakeOpfs';
import { buildLocalOocStore } from '../src/io/heavy/localOocBuild';
import { PreviewCloudSource } from '../src/io/heavy/OlvTileSource';
import {
  openLocalHeavyLas,
  type HeavyLasBridgeDeps,
  type HeavyLasBridgeEnv,
} from '../src/app/openLocalHeavyLas';
import { storageSampleNotice, type StorageEstimateReading } from '../src/io/heavy/storagePreflight';
import type { Viewer } from '../src/render/Viewer';
import { fakeWork } from './support/heavyLasFakes';

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
    ...fakeWork(),
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
    resetStreamState: vi.fn(),
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
