/**
 * heavyLasStreamReset.test.ts: a heavy local LAS/LAZ that replaces an open
 * COPC, EPT or 3D Tiles stream drops that stream's class tally, report cloud
 * and confidence once its attach commits, and keeps them on cancel or failure.
 * Static layers are not cleared on this path.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { InstrumentedRangeSource } from '../src/io/range/InstrumentedRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { fakeOpfs } from './support/fakeOpfs';
import { buildLocalOocStore } from '../src/io/heavy/localOocBuild';
import {
  openLocalHeavyLas,
  type HeavyLasBridgeDeps,
  type HeavyLasBridgeEnv,
} from '../src/app/openLocalHeavyLas';
import type { OpenStreamingDeps, StreamingReportInput } from '../src/app/openStreaming';
import type { StorageEstimateReading } from '../src/io/heavy/storagePreflight';
import type { Viewer } from '../src/render/Viewer';
import { createStreamingClassLedger } from '../src/app/streamingClassLedger';
import { LoadCancelledError } from '../src/io/loadFile';

const WORLD_MIN = [400000, 5200000, 55] as const;

/** A modest uncompressed LAS with intensity + classification channels. */
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

function spyFile(name: string, size: number): File {
  return { name, size, arrayBuffer: vi.fn(async () => new ArrayBuffer(size)) } as unknown as File;
}

function counting(inner: RangeSource): RangeSource {
  return new InstrumentedRangeSource(inner, () => {});
}

function fakeViewer() {
  const viewer = {
    ready: Promise.resolve(),
    attachStreamingCloud: vi.fn(async () => {}),
    activeBackend: () => 'webgl2' as const,
    availableImageExportModes: vi.fn(() => new Map()),
    setMode: vi.fn(),
    frameAll: vi.fn(),
    clouds: () => [],
    // A stream is already on screen (the COPC scan), so no preview attaches.
    hasStreamingCloud: true,
  };
  return viewer;
}

/** A spy `OpenStreamingDeps` whose reset clears a real class ledger. */
function fakeStreaming(viewer: ReturnType<typeof fakeViewer>) {
  const reportRows = [{ label: 'Points', value: '1', status: 'info' as const }];
  const streamingPanel = {
    setPhase: vi.fn(),
    show: vi.fn(),
    setColorModes: vi.fn(),
    setQuality: vi.fn(),
    setSummary: vi.fn(),
    setSourceUrl: vi.fn(),
  };
  const exportPanel = {
    setImageExportEnabled: vi.fn(),
    setImageExportAvailability: vi.fn(),
    setStreamingMode: vi.fn(),
  };
  const inspector = {
    setStreamingMode: vi.fn(),
    setDetail: vi.fn(),
    setStreamingDetail: vi.fn(),
    setReport: vi.fn(),
    element: { classList: { remove: vi.fn() } },
  };
  const classLegendPanel = {
    setClasses: vi.fn(),
    hide: vi.fn(),
    getVisibility: () => ({ isFiltered: () => false }),
  };
  let lastReport: StreamingReportInput | null = null;
  const runStreamingModules = vi.fn(() => reportRows);
  const prewarmExportStudio = vi.fn();
  const revealAnalysePanel = vi.fn();
  const startStreamingStatusPolling = vi.fn();
  const setLastStreamingReportCloud = vi.fn((c: StreamingReportInput) => { lastReport = c; });
  const ledger = createStreamingClassLedger();
  const resetStreamState = vi.fn(() => { ledger.reset(); });
  const streaming = {
    getViewer: () => viewer as unknown as Viewer,
    getStreamingQuality: () => 'balanced',
    debug: false,
    stage: { hideEmptyState: vi.fn() },
    streamingPanel,
    exportPanel,
    inspector,
    classLegendPanel,
    inspectorCards: {
      refreshProvenanceFromStreaming: vi.fn(),
      refreshDatasetIntelligenceFromStreamingCloud: vi.fn(),
    },
    crsCoordinator: { refreshCrsForStreamingCloud: vi.fn() },
    bookmarks: { clear: vi.fn() },
    hideReclassifyUi: vi.fn(),
    syncInspectClassScope: vi.fn(),
    prewarmExportStudio,
    revealAnalysePanel,
    startStreamingStatusPolling,
    refreshViewsUI: vi.fn(),
    runStreamingModules,
    setLastStreamingReportCloud,
    resetStreamState,
  } as unknown as OpenStreamingDeps;
  return {
    streaming,
    streamingPanel,
    exportPanel,
    inspector,
    classLegendPanel,
    runStreamingModules,
    prewarmExportStudio,
    revealAnalysePanel,
    startStreamingStatusPolling,
    setLastStreamingReportCloud,
    resetStreamState,
    ledger,
    getLastReport: () => lastReport,
  };
}

function makeDeps() {
  const viewer = fakeViewer();
  const s = fakeStreaming(viewer);
  const deps: HeavyLasBridgeDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer as unknown as Viewer,
    isPhone: () => false,
    renderBudget: 2_000_000,
    deviceMemoryGB: () => 0.001,
    dock: {
      setEmpty: vi.fn(),
      setMeasureEnabled: vi.fn(),
      setAnnotateEnabled: vi.fn(),
      setInspectEnabled: vi.fn(),
      setProbeEnabled: vi.fn(),
      setCloseEnabled: vi.fn(),
      setBackend: vi.fn(),
    },
    inspector: { setEmpty: vi.fn() },
    navBar: { element: { classList: { remove: vi.fn() } }, setMode: vi.fn(), flashHelp: vi.fn() },
    stage: { hideEmptyState: vi.fn() },
    body: { classList: { add: vi.fn() } },
    setPhase: vi.fn(),
    debug: false,
    streaming: s.streaming,
  };
  return { deps, viewer, s };
}

function makeEnv(range: RangeSource): HeavyLasBridgeEnv {
  const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
  const reading: StorageEstimateReading = { available: true, quotaBytes: 200_000_000_000, usageBytes: 0 };
  return {
    capable: () => true,
    openRange: () => range,
    getOpfsRoot: async () => opfs.root,
    readStorage: async () => reading,
    async runIndex(req) {
      return buildLocalOocStore(range, opfs.root, req.storeName, {
        pointsPerLeaf: req.pointsPerLeaf,
        memoryBudgetBytes: req.memoryBudgetBytes,
        maxDepth: req.maxDepth,
        batchPoints: 4096,
        signal: req.signal,
        onPhase: req.onPhase,
      });
    },
  };
}

async function openHeavy(attach?: (signal: AbortSignal, ctl: AbortController) => Promise<void>) {
  const range = counting(new ArrayBufferRangeSource(lasBytes(50_000)));
  const { deps, viewer, s } = makeDeps();
  const ctl = new AbortController();
  if (attach) viewer.attachStreamingCloud.mockImplementation(() => attach(ctl.signal, ctl));
  // A COPC stream is open: its node ids and classes are in the tally.
  s.ledger.record('0-0-0-0', new Uint8Array([6, 6, 5]));
  const file = spyFile('heavy.las', 999_999_999);
  const result = await openLocalHeavyLas(file, ctl.signal, deps, makeEnv(range));
  return { result, s };
}

describe('heavy LAS over an open stream', () => {
  it('drops the previous stream state once the attach commits', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');
    expect(s.resetStreamState).toHaveBeenCalledTimes(1);
    // The reset runs before the new scan publishes its report.
    expect(s.resetStreamState.mock.invocationCallOrder[0]).toBeLessThan(
      s.setLastStreamingReportCloud.mock.invocationCallOrder[0],
    );
  });

  it('keeps the previous stream state when the open is cancelled', async () => {
    const { result, s } = await openHeavy(async (_signal, ctl) => {
      ctl.abort();
      throw new LoadCancelledError();
    });
    expect(result.status).toBe('cancelled');
    expect(s.resetStreamState).not.toHaveBeenCalled();
    expect(s.ledger.size()).toBe(1);
  });

  it('keeps the previous stream state when the attach fails', async () => {
    const { result, s } = await openHeavy(async () => {
      throw new Error('attach failed');
    });
    expect(result.status).not.toBe('attached');
    expect(s.resetStreamState).not.toHaveBeenCalled();
    expect(s.ledger.size()).toBe(1);
  });

  it('shows only the heavy file classes in the legend tally after COPC', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');
    // The heavy store reuses the node id the COPC scan used.
    const fresh = s.ledger.record('0-0-0-0', new Uint8Array([2, 2]));
    expect(fresh).not.toBeNull();
    expect([...s.ledger.aggregate()]).toEqual([[2, 2]]);
  });
});
