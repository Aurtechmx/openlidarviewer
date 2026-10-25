/**
 * Shared fakes for the heavy-LAS bridge tests: a small LAS, a fake viewer, spy
 * streaming deps whose reset clears a real class ledger, and an in-process
 * build env over a fake OPFS.
 */
import { vi } from 'vitest';
import { writeLas14 } from '../../src/convert/writeLas';
import type { GlobalPoints } from '../../src/convert/globalPoints';
import { InstrumentedRangeSource } from '../../src/io/range/InstrumentedRangeSource';
import type { RangeSource } from '../../src/io/range/RangeSource';
import { fakeOpfs } from './fakeOpfs';
import { buildLocalOocStore } from '../../src/io/heavy/localOocBuild';
import type {
  HeavyLasBridgeDeps,
  HeavyLasBridgeEnv,
} from '../../src/app/openLocalHeavyLas';
import type { OpenStreamingDeps, StreamingReportInput } from '../../src/app/openStreaming';
import type { StorageEstimateReading } from '../../src/io/heavy/storagePreflight';
import type { Viewer } from '../../src/render/Viewer';
import { createStreamingClassLedger } from '../../src/app/streamingClassLedger';


export const WORLD_MIN = [400000, 5200000, 55] as const;

/** A modest uncompressed LAS with intensity + classification channels, laid
 *  out as a grid `width` points wide. */
export function lasBytes(n: number, width = 200): ArrayBuffer {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = WORLD_MIN[0] + (i % width) * 1.5;
    y[i] = WORLD_MIN[1] + Math.floor(i / width) * 1.5;
    z[i] = WORLD_MIN[2] + (i % 13) * 0.4;
    intensity[i] = i & 0xffff;
    classification[i] = 2;
  }
  const cloud: GlobalPoints = { count: n, x, y, z, intensity, classification };
  const bytes = writeLas14(cloud);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function spyFile(name: string, size: number): File {
  return { name, size, arrayBuffer: vi.fn(async () => new ArrayBuffer(size)) } as unknown as File;
}

export function counting(inner: RangeSource): RangeSource {
  return new InstrumentedRangeSource(inner, () => {});
}

/** One saved item as the work stores hold it. */
export interface FakeWorkItem {
  id: string;
  owner?: { layerId: string; frame: 'project' };
  pickLayers?: string[];
}

/**
 * Measurement and annotation stores with the calls the replace path makes:
 * list, remove one, clear all, and stamp the unowned with an owner.
 */
export function fakeWork() {
  const store = (items: FakeWorkItem[], stampPicks: boolean) => ({
    items,
    clear: vi.fn(() => { items.length = 0; }),
    claimUnowned: vi.fn((layerId: string) => {
      for (const i of items) {
        if (!i.owner) i.owner = { layerId, frame: 'project' };
        if (stampPicks && !i.pickLayers) i.pickLayers = [layerId];
      }
    }),
    removeOne: (id: string) => {
      const at = items.findIndex((i) => i.id === id);
      if (at >= 0) items.splice(at, 1);
    },
  });
  const m = store([], true);
  const a = store([], false);
  return {
    measure: {
      clear: m.clear,
      claimUnowned: m.claimUnowned,
      getMeasurements: () => m.items,
      removeMeasurement: vi.fn((id: string) => { m.removeOne(id); return null; }),
    },
    annotate: {
      clear: a.clear,
      reset: a.clear,
      resetHistory: vi.fn(),
      claimUnowned: a.claimUnowned,
      getAnnotations: () => a.items,
      remove: vi.fn((id: string) => { a.removeOne(id); }),
    },
  };
}

export function fakeViewer(opts: { hasStreamingCloud?: boolean } = {}) {
  const viewer = {
    ...fakeWork(),
    ready: Promise.resolve(),
    attachStreamingCloud: vi.fn((_source: unknown) => Promise.resolve()),
    detachStreamingCloud: vi.fn(),
    activeBackend: () => 'webgl2' as const,
    availableImageExportModes: vi.fn(() => new Map()),
    setMode: vi.fn(),
    frameAll: vi.fn(),
    clouds: (): string[] => [],
    ...(opts.hasStreamingCloud ? { hasStreamingCloud: true } : {}),
  };
  return viewer;
}

/** A spy `OpenStreamingDeps` whose reset clears a real class ledger. */
export function fakeStreaming(viewer: ReturnType<typeof fakeViewer>) {
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

export function makeDeps(opts: { hasStreamingCloud?: boolean } = {}) {
  const viewer = fakeViewer(opts);
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
    restoreEmptyState: vi.fn(),
    debug: false,
    streaming: s.streaming,
  };
  return { deps, viewer, s };
}

export function makeEnv(
  range: RangeSource,
  opfs: ReturnType<typeof fakeOpfs> = fakeOpfs({ syncAccess: true, fileMove: true }),
): HeavyLasBridgeEnv {
  const reading: StorageEstimateReading = { available: true, quotaBytes: 200_000_000_000, usageBytes: 0 };
  return {
    capable: () => true,
    openRange: () => range,
    getOpfsRoot: async () => opfs.root,
    readStorage: async () => reading,
    async runIndex(req) {
      return buildLocalOocStore(range, opfs.root, req.storeName, {
        kind: req.kind,
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
