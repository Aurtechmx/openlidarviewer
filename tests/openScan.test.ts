import { describe, it, expect, vi } from 'vitest';
import {
  openScan,
  layerChipCount,
  shouldResetSavedWork,
  type OpenScanDeps,
} from '../src/app/openScan';
import { COPC_DETECT_MIN_BYTES } from '../src/io/copc/copcDetect';
import type { Viewer } from '../src/render/Viewer';
import type { ClassScope } from '../src/render/class/classScope';

// ─────────────────────────────────────────────────────────────────────────────
// The two pure decisions the extraction exposes — the only load-pipeline logic
// that can be decided without a Viewer, a canvas or the DOM.
// ─────────────────────────────────────────────────────────────────────────────

describe('layerChipCount — the file-total vs display-subset decision', () => {
  it('shows the source total when the display cloud was budget-reduced below it', () => {
    // A 100M-point file rendered at a 4M budget: the Layers chip names the file.
    expect(layerChipCount(100_000_000, 4_000_000)).toBe(100_000_000);
  });

  it('shows the display count when the load was NOT reduced (original === display)', () => {
    expect(layerChipCount(4_000_000, 4_000_000)).toBe(4_000_000);
  });

  it('shows the display count when the source total is unknown (undefined)', () => {
    // No header-declared total — the display count is the only number we have.
    expect(layerChipCount(undefined, 2_500_000)).toBe(2_500_000);
  });

  it('never shows a source total smaller than the display count', () => {
    // Defensive: a smaller "original" is not a reduction, so it must not win.
    expect(layerChipCount(1_000, 4_000)).toBe(4_000);
  });

  it('treats a zero source total as absent', () => {
    expect(layerChipCount(0, 4_000)).toBe(4_000);
  });
});

describe('shouldResetSavedWork — fresh project vs additive open', () => {
  it('resets on the first loaded cloud', () => {
    expect(shouldResetSavedWork(1)).toBe(true);
  });

  it('resets defensively when the scene is somehow empty', () => {
    expect(shouldResetSavedWork(0)).toBe(true);
  });

  it('keeps saved work when a second cloud is added (additive open)', () => {
    expect(shouldResetSavedWork(2)).toBe(false);
    expect(shouldResetSavedWork(5)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The three-way router — session / COPC / static — the decidable dispatch.
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal File stand-in: `openScan` reads only `.name` and `.slice(...).arrayBuffer()`. */
function fakeFile(name: string, head?: ArrayBuffer): File {
  return {
    name,
    slice: () => ({ arrayBuffer: async () => head ?? new ArrayBuffer(0) }),
  } as unknown as File;
}

/** A 589-byte COPC head: "LASF" magic, a "copc" info VLR at 377, record id 1 at 393. */
function copcHead(): ArrayBuffer {
  const buf = new ArrayBuffer(COPC_DETECT_MIN_BYTES);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x4c; u8[1] = 0x41; u8[2] = 0x53; u8[3] = 0x46; // LASF
  u8[377] = 0x63; u8[378] = 0x6f; u8[379] = 0x70; u8[380] = 0x63; // copc
  new DataView(buf).setUint16(393, 1, true); // COPC info VLR record id
  return buf;
}

/**
 * Build an OpenScanDeps wired to spies. `loadLocalSource` rejects by default so
 * the static route stops at the loader without needing a real cloud / GPU — the
 * routing and the loading-flag lifecycle are what these tests observe. A
 * `loading` override starts the one-load-at-a-time guard closed.
 */
function makeDeps(over: { loading?: boolean } = {}) {
  let loading = over.loading ?? false;
  const calls = {
    importSession: vi.fn(async () => {}),
    isLoading: vi.fn(() => loading),
    setLoading: vi.fn((v: boolean) => { loading = v; }),
    showToast: vi.fn(),
    setOpening: vi.fn(),
    setCancelHandler: vi.fn(),
    setProgress: vi.fn(),
    setPreload: vi.fn(),
    setError: vi.fn(),
    openLocalCopc: vi.fn(async () => {}),
    loadLocalSource: vi.fn(async () => { throw new Error('loader not exercised in this test'); }),
    closeStreaming: vi.fn(),
  };

  const deps: OpenScanDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => ({}) as unknown as Viewer,
    importSession: calls.importSession,
    isLoading: calls.isLoading,
    setLoading: calls.setLoading,
    showToast: calls.showToast,
    dropZone: {
      setOpening: calls.setOpening,
      setCancelHandler: calls.setCancelHandler,
      setProgress: calls.setProgress,
      setPreload: calls.setPreload,
      setError: calls.setError,
    },
    openLocalCopc: calls.openLocalCopc,
    loadLocalSource: calls.loadLocalSource,
    renderBudget: 1_000_000,
    isPhone: () => false,
    deviceMemoryGB: () => 8,
    stage: { hideEmptyState: vi.fn() },
    closeStreaming: calls.closeStreaming,
    scans: { setActive: vi.fn(), activeId: null } as unknown as OpenScanDeps['scans'],
    inspector: {} as unknown as OpenScanDeps['inspector'],
    inspectorCards: {} as unknown as OpenScanDeps['inspectorCards'],
    crsCoordinator: {} as unknown as OpenScanDeps['crsCoordinator'],
    dock: {} as unknown as OpenScanDeps['dock'],
    navBar: {} as unknown as OpenScanDeps['navBar'],
    bookmarks: { clear: vi.fn() },
    layerService: { refreshCrsFlags: vi.fn() },
    setLayerVisible: vi.fn(),
    rememberSourceFile: vi.fn(),
    rememberReduced: vi.fn(),
    refreshAnnotationPanel: vi.fn(),
    setCurrentColorMode: vi.fn(),
    loadApplyDisplayProfile: vi.fn(async () => ({ applyDisplayProfile: vi.fn() })),
    runModules: vi.fn(() => []),
    currentClassScope: vi.fn(() => ({}) as unknown as ClassScope),
    prewarmExportStudio: vi.fn(),
    getPendingShareState: () => null,
    clearPendingShareState: vi.fn(),
    applyShareState: vi.fn(),
    bareMode: false,
    showProjectCard: vi.fn(),
    revealAnalysePanel: vi.fn(),
    showInstantAnswer: vi.fn(),
    refreshClassLegend: vi.fn(),
    debug: false,
    benchmark: false,
    getDebugOverlay: () => null,
  };

  return { deps, calls };
}

describe('openScan — the file router', () => {
  it('routes an .olvsession to the session loader UNDER the load guard, never the cloud worker', async () => {
    const { deps, calls } = makeDeps();
    await openScan(fakeFile('survey.olvsession'), deps);
    expect(calls.importSession).toHaveBeenCalledTimes(1);
    // FIX C: the session reroute now runs UNDER the one-load-at-a-time guard.
    // An embed `load-file` is wrapped as a File whose NAME the host controls, so
    // a `x.olvsession` name reaching the session loader unthrottled could stack
    // repeated restores. It still touches no cloud loader, and it claims then
    // releases the flag around the restore.
    expect(calls.isLoading).toHaveBeenCalled();
    expect(calls.setLoading).toHaveBeenNthCalledWith(1, true);
    expect(calls.setLoading).toHaveBeenLastCalledWith(false);
    expect(calls.loadLocalSource).not.toHaveBeenCalled();
    expect(calls.openLocalCopc).not.toHaveBeenCalled();
  });

  it('refuses a second .olvsession while a load is in flight (no stacking)', async () => {
    const { deps, calls } = makeDeps({ loading: true });
    await openScan(fakeFile('survey.olvsession'), deps);
    expect(calls.showToast).toHaveBeenCalledWith(expect.stringContaining('Already loading'));
    expect(calls.importSession).not.toHaveBeenCalled();
    expect(calls.setLoading).not.toHaveBeenCalled(); // guard rejects before claiming the flag
  });

  it('refuses a second load while one is in flight, without starting anything', async () => {
    const { deps, calls } = makeDeps({ loading: true });
    await openScan(fakeFile('scan.laz'), deps);
    expect(calls.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Already loading'),
    );
    expect(calls.importSession).not.toHaveBeenCalled();
    expect(calls.loadLocalSource).not.toHaveBeenCalled();
    expect(calls.setLoading).not.toHaveBeenCalled(); // never claimed the flag
  });

  it('routes a COPC file to the streaming pipeline, not the static loader', async () => {
    const { deps, calls } = makeDeps();
    await openScan(fakeFile('cloud.copc.laz', copcHead()), deps);
    expect(calls.openLocalCopc).toHaveBeenCalledTimes(1);
    expect(calls.loadLocalSource).not.toHaveBeenCalled();
    // The flag is claimed and released around the streaming open.
    expect(calls.setLoading).toHaveBeenNthCalledWith(1, true);
    expect(calls.setLoading).toHaveBeenLastCalledWith(false);
  });

  it('routes a non-COPC file to the static loader and reports a loader failure honestly', async () => {
    const { deps, calls } = makeDeps();
    await openScan(fakeFile('scan.las', new ArrayBuffer(0)), deps);
    expect(calls.loadLocalSource).toHaveBeenCalledTimes(1);
    expect(calls.openLocalCopc).not.toHaveBeenCalled();
    // A failed load surfaces on the drop zone, tidies any half-open stream,
    // and always releases the loading flag in `finally`.
    expect(calls.setError).toHaveBeenCalledTimes(1);
    expect(calls.closeStreaming).toHaveBeenCalledTimes(1);
    expect(calls.setLoading).toHaveBeenNthCalledWith(1, true);
    expect(calls.setLoading).toHaveBeenLastCalledWith(false);
  });
});
