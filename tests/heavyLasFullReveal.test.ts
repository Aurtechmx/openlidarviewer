/**
 * heavyLasFullReveal.test.ts — a committed out-of-core LAS opens with the full
 * streaming surface, not just the dock and inspector chrome.
 *
 * The bridge (`#657`) attached an `OlvTileSource` and turned on the dock, the
 * nav bar and the `olv-has-scan` body class through `revealStreamingScanChrome`,
 * but stopped there: the streaming panel never showed, the Inspector kept its
 * static layout, image export stayed dark, the Analyse rail never opened and no
 * streaming Scan Report was published. COPC, EPT and 3D Tiles all reveal those
 * after their commit. These cases pin that an out-of-core LAS now reveals the
 * same surfaces, routed through the shared helpers, and — the anti-blind-copy
 * guard — that the two surfaces this source cannot honestly fill are omitted.
 *
 * The build path is faked exactly as `heavyLasBridgeStreaming.test.ts` fakes it:
 * a real in-process build against `fakeOpfs`, driven through a counting range.
 * The streaming reveal deps are spies, so each reveal call is asserted directly.
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
  };
  return viewer;
}

/** A spy `OpenStreamingDeps`: every surface the reveal touches is a spy so the
 *  reveal's calls (and its deliberate omissions) can be asserted directly. */
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

async function openHeavy(n = 200_000) {
  const range = counting(new ArrayBufferRangeSource(lasBytes(n)));
  const { deps, s } = makeDeps();
  const file = spyFile('heavy.las', 999_999_999);
  const result = await openLocalHeavyLas(file, new AbortController().signal, deps, makeEnv(range));
  return { result, s, n };
}

describe('heavy-LAS full streaming reveal', () => {
  it('reveals the streaming panel and publishes a streaming Scan Report', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');

    // The streaming panel is shown with its live controls populated.
    expect(s.streamingPanel.show).toHaveBeenCalledTimes(1);
    expect(s.streamingPanel.setColorModes).toHaveBeenCalledTimes(1);
    expect(s.streamingPanel.setQuality).toHaveBeenCalledTimes(1);

    // The Inspector and Export panel switch to streaming layout and image
    // export opens.
    expect(s.inspector.setStreamingMode).toHaveBeenCalledWith(true);
    expect(s.exportPanel.setStreamingMode).toHaveBeenCalledWith(true);
    expect(s.exportPanel.setImageExportEnabled).toHaveBeenCalledWith(true);
    expect(s.exportPanel.setImageExportAvailability).toHaveBeenCalled();

    // A streaming Scan Report is built and published for THIS scan.
    expect(s.runStreamingModules).toHaveBeenCalledTimes(1);
    expect(s.inspector.setReport).toHaveBeenCalledTimes(1);
    expect(s.setLastStreamingReportCloud).toHaveBeenCalledTimes(1);

    // The Analyse rail, export pre-warm and status poll all start.
    expect(s.revealAnalysePanel).toHaveBeenCalledTimes(1);
    expect(s.prewarmExportStudio).toHaveBeenCalledTimes(1);
    expect(s.startStreamingStatusPolling).toHaveBeenCalledTimes(1);
  });

  it('states the REAL point total in the Scan Report and the detail row', async () => {
    const { result, s, n } = await openHeavy();
    expect(result.status).toBe('attached');

    // Unlike a 3D Tiles tileset (which states no total), an OlvTileSource states
    // its tile-store total, so the report cloud carries the measured count and
    // the Inspector detail row shows it — not "not stated by the source".
    const report = s.getLastReport();
    expect(report).not.toBeNull();
    expect(report?.sourcePointCount).toBe(n);
    expect(report?.sourcePointCount).not.toBeNull();
    // The total is the SOURCE figure. What is resident is a separate count off
    // the same store, so the readout can state residency instead of claiming
    // the whole store is on the GPU.
    expect(s.inspector.setStreamingDetail).toHaveBeenCalledWith({
      residentPointCount: 0,
      sourcePointCount: n,
      sourcePointCountKnown: true,
    });
    expect(s.inspector.setDetail).not.toHaveBeenCalled();
  });

  it('omits the two surfaces a local out-of-core store cannot honestly fill', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');

    // No publisher URL: the store is built from a LOCAL file, so the credited
    // Source row is not offered (COPC guards the same call behind http-range).
    expect(s.streamingPanel.setSourceUrl).not.toHaveBeenCalled();

    // No honest format tag: the panel's summary vocabulary is copc|ept|3dtiles,
    // none of which names a decoded out-of-core LAS store, so the summary row is
    // omitted rather than mislabelled. The real count still reaches the user via
    // the Scan Report and the detail row.
    expect(s.streamingPanel.setSummary).not.toHaveBeenCalled();
  });

  it('resets the classification UI as a fillable legend, not an inapplicable one', async () => {
    // Classification IS a real channel on an out-of-core store (every tile record
    // carries it by layout), so the reset is the empty-and-waiting COPC case,
    // seeded lazily as classified nodes stream in.
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');
    expect(s.classLegendPanel.setClasses).toHaveBeenCalledTimes(1);
    expect(s.classLegendPanel.hide).toHaveBeenCalledTimes(1);
  });
});
