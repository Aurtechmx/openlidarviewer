/**
 * openScanAttachSequence.test.ts — the static attach, driven rather than read.
 *
 * Everything from "Preparing GPU buffers" to the progress teardown used to run
 * in one task. The last natural await is `await viewer.ready`, well above those
 * writes, so both status lines were written and cleared without the browser
 * painting either and the user watched the last decode line freeze through the
 * whole GPU attach. Two `setTimeout` yields now split that task in three.
 *
 * A yield is a real task boundary, which is what makes the rest of this file
 * necessary. A Cancel click queued during the decode's tail is dispatched
 * inside the first gap, so the attach re-reads the abort signal there, and it
 * does so BEFORE hiding the empty state: hiding it on the way out of a
 * cancelled load strands the user on a blank stage, because nothing outside
 * `resetToEmptyState` puts it back. Past `addCloud` the opposite rule holds.
 * The cloud is in the scene and nothing below rolls that back, so the Cancel
 * control is retired there and no abort check follows it — honouring one would
 * abandon a half-revealed scan with no layer row to remove it by and no Close
 * in the dock.
 *
 * The suite drives the real `openScan` over fakes, so a yield that goes away, a
 * check that moves back across `hideEmptyState`, or a cancel that survives the
 * commit boundary shows up as behaviour rather than as a missing line of
 * source. The defect each test catches is named on the test.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

import { openScan, type OpenScanDeps } from '../src/app/openScan';
import type { Viewer } from '../src/render/Viewer';
import type { Inspector } from '../src/ui/Inspector';
import type { PointCloud } from '../src/model/PointCloud';
import type { AnalysisRow } from '../src/analysis/ModuleApi';
import type { LoadCallbacks, LoadResult } from '../src/io/loadFile';

beforeAll(() => {
  // The attach marks the body and fills the Scan Report from an idle callback.
  // Node has neither, so both are stubbed at the seam the shell reads them
  // through. Firing the idle callback immediately is a legal scheduling for it
  // and keeps the report assertion deterministic.
  (globalThis as unknown as { document: unknown }).document = {
    body: { classList: { add: () => {}, remove: () => {} } },
  };
  (globalThis as unknown as { window: unknown }).window = {
    requestIdleCallback: (cb: () => void) => { cb(); return 1; },
  };
});

/** The one report row the fake analysis modules produce. */
const REPORT_ROW: AnalysisRow = { label: 'Points', value: '1,000', status: 'info' };

/** A scan with no colour, class or intensity channel: the elevation fallback. */
function fakeCloud(): PointCloud {
  return {
    name: 'field.las',
    pointCount: 1_000,
    declaredPointCount: 4_000,
    sourceFormat: 'las',
    metadata: { crs: { name: 'UTM 14N', epsg: 32614 } },
    bounds: () => ({ min: [0, 0, 0], max: [10, 10, 2] }),
  } as unknown as PointCloud;
}

/** A minimal File stand-in: `openScan` reads `.name` and the head slice. */
function fakeFile(name = 'field.las'): File {
  return {
    name,
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
  } as unknown as File;
}

interface HarnessOptions {
  /** Runs with the loader's callbacks the moment the static load resolves. */
  readonly onLoaded?: (callbacks: LoadCallbacks) => void;
  /** Runs on every line handed to the drop zone (null is the teardown). */
  readonly onProgressLine?: (line: string | null) => void;
  /** Make the lazily imported display-profile chunk arrive a task later. */
  readonly slowDisplayProfile?: boolean;
  /** Make that chunk fail to import. */
  readonly failDisplayProfile?: boolean;
}

/** Let queued macrotasks (the attach's own yields included) drain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * `openScan` wired to spies over a static load that SUCCEEDS, so the whole
 * attach runs. `trace` is the single ordered sequence the tests read: the
 * status lines, the cancel arming, the cloud landing in the scene, the reveal.
 */
function harness(opts: HarnessOptions = {}) {
  const trace: string[] = [];
  const cloud = fakeCloud();
  const result: LoadResult = { cloud, originalPointCount: 4_000, downsampled: true };
  let activeId: string | null = null;
  /** The last abort the drop zone's Cancel button was wired to. */
  let armed: (() => void) | null = null;

  const calls = {
    setLoading: vi.fn(),
    setError: vi.fn(),
    setPreload: vi.fn(),
    setProgress: vi.fn((line: string | null) => {
      trace.push(line === null ? 'progress:cleared' : `progress:${line}`);
      opts.onProgressLine?.(line);
    }),
    setCancelHandler: vi.fn((fn: (() => void) | null) => {
      if (fn) armed = fn;
      trace.push(fn === null ? 'cancel:retired' : 'cancel:armed');
    }),
    hideEmptyState: vi.fn(() => { trace.push('hideEmptyState'); }),
    closeStreaming: vi.fn(),
    addCloud: vi.fn(() => { trace.push('addCloud'); return 'cloud-1'; }),
    setActive: vi.fn((id: string) => { activeId = id; }),
    ensureStoresWired: vi.fn(),
    bookmarksClear: vi.fn(),
    annotateClear: vi.fn(),
    dockSetEmpty: vi.fn(() => { trace.push('reveal'); }),
    setReport: vi.fn(),
    runModules: vi.fn(() => [REPORT_ROW]),
    applyDisplayProfile: vi.fn(),
    revealAnalysePanel: vi.fn(),
    warn: vi.fn(),
  };

  const viewer = {
    ready: Promise.resolve(),
    hasStreamingCloud: false,
    addCloud: calls.addCloud,
    clouds: () => [cloud],
    measure: {},
    annotate: { clear: calls.annotateClear },
    setCoverageGrid: () => {},
    setMode: () => {},
    frameAll: () => {},
    setColorMode: () => {},
    activeBackend: () => 'webgl',
    elevationExtent: () => ({ min: 0, max: 2 }),
    intensityExtent: () => null,
    availableImageExportModes: () => [],
    pointSize: 2,
    edlEnabled: true,
    edlStrength: 1,
    pointSizeMode: 'fixed',
    antialiasing: true,
    twoFingerTwistEnabled: false,
    splatMode: 'off',
  } as unknown as Viewer;

  const inspector = {
    setCoverageAvailable: vi.fn(),
    setEmpty: vi.fn(),
    addCloud: vi.fn(),
    setColorModes: vi.fn(),
    setDetail: vi.fn(),
    setElevationExtent: vi.fn(),
    setIntensityExtent: vi.fn(),
    setReport: calls.setReport,
    setViews: vi.fn(),
    syncRendering: vi.fn(),
  } as unknown as Inspector;

  const loadApplyDisplayProfile = async () => {
    if (opts.slowDisplayProfile || opts.failDisplayProfile) await settle();
    if (opts.failDisplayProfile) throw new Error('display-profile chunk unavailable');
    return { applyDisplayProfile: calls.applyDisplayProfile };
  };

  const deps: OpenScanDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer,
    importSession: vi.fn(async () => {}),
    isLoading: () => false,
    setLoading: calls.setLoading,
    showToast: vi.fn(),
    dropZone: {
      setOpening: vi.fn(),
      setCancelHandler: calls.setCancelHandler,
      setProgress: calls.setProgress,
      setPreload: calls.setPreload,
      setError: calls.setError,
    },
    openLocalCopc: vi.fn(async () => {}),
    loadLocalSource: vi.fn(async (_file: File, callbacks: LoadCallbacks) => {
      opts.onLoaded?.(callbacks);
      return result;
    }),
    renderBudget: 1_000_000,
    isPhone: () => false,
    deviceMemoryGB: () => 8,
    stage: { hideEmptyState: calls.hideEmptyState },
    closeStreaming: calls.closeStreaming,
    scans: {
      setActive: calls.setActive,
      get activeId(): string | null { return activeId; },
    } as unknown as OpenScanDeps['scans'],
    layerIdentity: { bindOnLoad: vi.fn(() => null), ensureStoresWired: calls.ensureStoresWired, stableIdFor: vi.fn(() => null) },
    inspector,
    exportPanel: {
      setImageExportEnabled: vi.fn(),
      setImageExportAvailability: vi.fn(),
    } as unknown as OpenScanDeps['exportPanel'],
    inspectorCards: {
      refreshProvenance: vi.fn(),
      refreshDatasetIntelligenceFromStaticCloud: vi.fn(),
    } as unknown as OpenScanDeps['inspectorCards'],
    crsCoordinator: { refreshCrsForStaticCloud: vi.fn() } as unknown as OpenScanDeps['crsCoordinator'],
    dock: {
      setBackend: vi.fn(),
      setEmpty: calls.dockSetEmpty,
      setMeasureEnabled: vi.fn(),
      setInspectEnabled: vi.fn(),
      setProbeEnabled: vi.fn(),
      setAnnotateEnabled: vi.fn(),
      setCloseEnabled: vi.fn(),
    } as unknown as OpenScanDeps['dock'],
    navBar: {
      element: { classList: { remove: () => {} } },
      setMode: vi.fn(),
      flashHelp: vi.fn(),
      flashTouchHint: vi.fn(),
    } as unknown as OpenScanDeps['navBar'],
    bookmarks: { clear: calls.bookmarksClear },
    layerService: { refreshCrsFlags: vi.fn() },
    setLayerVisible: vi.fn(),
    rememberSourceFile: vi.fn(),
    rememberReduced: vi.fn(),
    refreshAnnotationPanel: vi.fn(),
    setCurrentColorMode: vi.fn(),
    loadApplyDisplayProfile,
    runModules: calls.runModules as unknown as OpenScanDeps['runModules'],
    currentClassScope: vi.fn(() => ({}) as ReturnType<OpenScanDeps['currentClassScope']>),
    prewarmExportStudio: vi.fn(),
    getPendingShareState: () => null,
    clearPendingShareState: vi.fn(),
    applyShareState: vi.fn(),
    bareMode: false,
    showProjectCard: vi.fn(),
    revealAnalysePanel: calls.revealAnalysePanel,
    showInstantAnswer: vi.fn(),
    refreshClassLegend: vi.fn(),
    debug: false,
    benchmark: false,
    getDebugOverlay: () => null,
  };

  return {
    deps,
    calls,
    trace,
    cloud,
    /** Fire the Cancel the drop zone was last given, retired or not. */
    fireCancel: (): void => { armed?.(); },
    /** Where `needle` sits in the trace, or -1. */
    at: (needle: string): number => trace.indexOf(needle),
  };
}

const UPLOADING = 'progress:Preparing GPU buffers…';
const RENDERING = 'progress:Rendering…';

describe('the attach yields between its status lines', () => {
  it('lets a task queued before the attach run before the empty state is hidden', async () => {
    // The defect: with no yield, everything from "Preparing GPU buffers" to the
    // teardown is one task, so nothing the browser has queued gets in until the
    // attach is over, a paint of those status lines included. A task queued as
    // the decode finishes landing after `progress:cleared` is that defect.
    const h = harness({
      onLoaded: () => { setTimeout(() => { h.trace.push('queued-task'); }, 0); },
    });

    await openScan(fakeFile(), h.deps);

    expect(h.at(UPLOADING)).toBeGreaterThan(-1);
    expect(h.at('queued-task')).toBeGreaterThan(h.at(UPLOADING));
    expect(h.at('queued-task')).toBeLessThan(h.at('hideEmptyState'));
  });

  it('yields again after "Rendering", before framing and the first colour pass', async () => {
    // Same defect on the second line: "Rendering" is written and then framing
    // and the first colour pass run synchronously, so a task queued the instant
    // the line appears must still get in ahead of the teardown.
    const h = harness({
      onProgressLine: (line) => {
        if (line === 'Rendering…') setTimeout(() => { h.trace.push('queued-after-rendering'); }, 0);
      },
    });

    await openScan(fakeFile(), h.deps);

    expect(h.at(RENDERING)).toBeGreaterThan(-1);
    expect(h.at('queued-after-rendering')).toBeGreaterThan(h.at(RENDERING));
    expect(h.at('queued-after-rendering')).toBeLessThan(h.at('progress:cleared'));
  });

  it('forwards the loader stages to the drop zone as they arrive', async () => {
    // The decode's own lines are the only feedback for the seconds before the
    // attach, so a loader stage that never reaches the drop zone reads to the
    // user as a stalled load.
    const h = harness({
      onLoaded: (callbacks) => {
        callbacks.onProgress?.({ stage: 'decoding', detail: '2.1M of 4.0M points', fraction: 0.5 });
        callbacks.onPreload?.(['LAS 1.4', '4.0M points']);
      },
    });

    await openScan(fakeFile(), h.deps);

    expect(h.calls.setProgress).toHaveBeenCalledWith('Decoding points — 2.1M of 4.0M points', 0.5);
    expect(h.calls.setPreload).toHaveBeenCalledWith(['LAS 1.4', '4.0M points']);
  });
});

describe('a Cancel dispatched inside the attach gap', () => {
  it('leaves the empty state on screen and never attaches the cloud', async () => {
    // The defect: `hideEmptyState` ran before the abort was re-read, so a
    // cancel landing in the gap hid the placeholder for a scan that never
    // arrived. Nothing outside `resetToEmptyState` puts it back, so the user
    // was left on a blank stage with no scan and no way to ask for one.
    const h = harness({
      // Queue the cancel as a task before the attach registers its own yield —
      // exactly where a click made during the decode's tail lands.
      onLoaded: () => { setTimeout(() => { h.fireCancel(); }, 0); },
    });

    await openScan(fakeFile(), h.deps);

    expect(h.calls.hideEmptyState).not.toHaveBeenCalled();
    expect(h.calls.addCloud).not.toHaveBeenCalled();
    expect(h.at('reveal')).toBe(-1);
    // A cancelled load is a quiet no-op: the line goes, no error is raised, and
    // the load flag is released for the next open.
    expect(h.calls.setError).not.toHaveBeenCalled();
    expect(h.trace.at(-1)).toBe('progress:cleared');
    expect(h.calls.setLoading).toHaveBeenLastCalledWith(false);
  });

  it('retires the Cancel control once the cloud is in the scene', async () => {
    // The defect: the control stayed armed through the second yield, offering
    // an abort that would abandon a half-revealed scan.
    const h = harness();

    await openScan(fakeFile(), h.deps);

    expect(h.at('addCloud')).toBeGreaterThan(-1);
    expect(h.at('cancel:retired')).toBeGreaterThan(h.at('addCloud'));
    expect(h.at('cancel:retired')).toBeLessThan(h.at(RENDERING));
  });

  it('finishes the reveal even when the signal aborts past the commit boundary', async () => {
    // No abort check follows the commit boundary, on purpose. This fires the
    // retired handler anyway and pins that the scan still reaches the user:
    // dock revealed, Analyse panel offered, progress cleared, no error.
    const h = harness({
      onProgressLine: (line) => { if (line === 'Rendering…') h.fireCancel(); },
    });

    await openScan(fakeFile(), h.deps);

    expect(h.at('reveal')).toBeGreaterThan(h.at('addCloud'));
    expect(h.calls.revealAnalysePanel).toHaveBeenCalledWith('field.las');
    expect(h.calls.setError).not.toHaveBeenCalled();
    expect(h.trace.at(-1)).toBe('progress:cleared');
  });
});

describe('what the completed attach leaves behind', () => {
  it('attaches the cloud, makes it active, and clears saved work on a fresh project', async () => {
    const h = harness();

    await openScan(fakeFile(), h.deps);

    expect(h.calls.hideEmptyState).toHaveBeenCalledTimes(1);
    expect(h.calls.setActive).toHaveBeenCalledWith('cloud-1');
    expect(h.calls.ensureStoresWired).toHaveBeenCalledTimes(1);
    // One cloud in the scene means there is nothing to preserve, so the
    // saved-work reset is the honest call. The additive side of that rule is
    // pinned in tests/additiveOpenKeepsWork.test.ts.
    expect(h.calls.bookmarksClear).toHaveBeenCalledTimes(1);
    expect(h.calls.annotateClear).toHaveBeenCalledTimes(1);
    // Nothing was streaming, so nothing gets torn down.
    expect(h.calls.closeStreaming).not.toHaveBeenCalled();
    expect(h.calls.setLoading).toHaveBeenLastCalledWith(false);
  });

  it('reads the active scan and the layer count at call time, not at wiring time', async () => {
    // `ensureStoresWired` is handed accessors, not snapshots. A snapshot taken
    // during the attach would record "one layer, this id" forever, and every
    // measurement placed after the second scan opened would be stamped with the
    // first scan's ownership.
    const h = harness();

    await openScan(fakeFile(), h.deps);

    const [, getActiveId, getLayerCount] = h.calls.ensureStoresWired.mock.calls[0] as [
      unknown,
      () => string | null,
      () => number,
    ];
    expect(getActiveId()).toBe('cloud-1');
    expect(getLayerCount()).toBe(1);
    h.calls.setActive('cloud-2');
    expect(getActiveId()).toBe('cloud-2');
  });

  it('fills the Scan Report when the main thread goes idle', async () => {
    // The report walks every point several times. Running it inline put ~3 s of
    // that on the attach long-task, blocking first paint and first input.
    const h = harness();

    await openScan(fakeFile(), h.deps);

    expect(h.calls.runModules).toHaveBeenCalledTimes(1);
    expect(h.calls.setReport).toHaveBeenCalledWith([REPORT_ROW]);
  });

  it('applies the display-profile card to the scan that is still active', async () => {
    const h = harness({ slowDisplayProfile: true });

    await openScan(fakeFile(), h.deps);
    await settle();

    expect(h.calls.applyDisplayProfile).toHaveBeenCalledWith(h.cloud, h.deps.inspector);
  });

  it('drops the display-profile card when the scan changed while its chunk loaded', async () => {
    // The card is lazily imported, so its result can arrive after the user has
    // opened something else. Applying it then describes the previous scan on
    // the panel of the current one.
    const h = harness({ slowDisplayProfile: true });

    await openScan(fakeFile(), h.deps);
    h.calls.setActive('cloud-2');
    await settle();

    expect(h.calls.applyDisplayProfile).not.toHaveBeenCalled();
  });

  it('survives a display-profile chunk that fails to load', async () => {
    // The card is additive and the enclosing try/catch is synchronous, so a
    // failed chunk import would otherwise escape as an unhandled rejection
    // while the load itself had already succeeded.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => { rejections.push(err); };
    process.on('unhandledRejection', onRejection);
    const h = harness({ failDisplayProfile: true });

    await openScan(fakeFile(), h.deps);
    await settle();
    await settle();
    process.off('unhandledRejection', onRejection);

    expect(rejections).toEqual([]);
    expect(h.calls.applyDisplayProfile).not.toHaveBeenCalled();
    // The scan is on screen regardless of the card.
    expect(h.at('reveal')).toBeGreaterThan(-1);
    expect(h.trace.at(-1)).toBe('progress:cleared');
  });
});
