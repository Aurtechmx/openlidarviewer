/**
 * heavyLasHarness.ts: the shared fakes for the heavy LAS open tests.
 *
 * An uncompressed LAS writer for a wide XY grid, a File stub, and a viewer and
 * streaming bridge that record what was attached. Used by the preview-first and
 * the sample-fallback tests.
 */
import { vi } from 'vitest';
import { writeLas14 } from '../../src/convert/writeLas';
import type { GlobalPoints } from '../../src/convert/globalPoints';
import type { HeavyLasBridgeDeps } from '../../src/app/openLocalHeavyLas';
import type { Viewer } from '../../src/render/Viewer';
import { fakeWork } from './heavyLasFakes';

export const WORLD_MIN = [400000, 5200000, 55] as const;

/** An uncompressed LAS whose points span a wide XY grid, so a stratified sample
 *  across file order is a spread across the footprint. */
export function lasBytes(n: number): ArrayBuffer {
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

export function spyFile(name: string, size: number): { file: File; arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(size));
  const file = { name, size, arrayBuffer } as unknown as File;
  return { file, arrayBuffer };
}

/** A viewer stub recording every attach in order and whether a detach happened. */
export function fakeViewer() {
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

export function fakeStreaming(viewer: unknown) {
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

export function makeDeps() {
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

