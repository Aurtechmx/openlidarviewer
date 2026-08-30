/**
 * heavyOocLeakFree.test.ts — the out-of-core store lifecycle is leak- and
 * collision-free.
 *
 * Every exit path of the heavy-LAS open must end in a coherent state: a
 * committed store recorded in the cache map and retained for reuse, or no store
 * at all. Never a promoted store nobody owns. Since the persistent cache (Phase
 * 4) these cases pin that:
 *
 *  - two opens of the SAME file REUSE one recorded store (the cache hit — a
 *    rebuild is not repeated, and no second directory is created);
 *  - closing a source of a recorded store RETAINS it, so the next open still
 *    finds it (the cache survives a close);
 *  - an abort right AFTER promotion leaves NO store — an uncommitted store is
 *    never recorded, so it is deleted, not stranded;
 *  - an attach failure AFTER promotion leaves NO store (the source's own close
 *    frees the uncommitted store);
 *  - a promotion-copy failure discards the partial (finding #2).
 *
 * The browser-only seams are the repo's usual fakes: OPFS is
 * `tests/support/fakeOpfs.ts`, and the index "worker" runs the real build in
 * process against that fake OPFS.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
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

interface ViewerOptions {
  /** Make `attachStreamingCloud` throw, to model an attach failure. */
  readonly attachThrows?: boolean;
}

function fakeViewer(opts: ViewerOptions = {}) {
  let attachedSource: unknown;
  const attachStreamingCloud = vi.fn(async (source: unknown) => {
    if (opts.attachThrows) throw new Error('attach failed');
    attachedSource = source;
  });
  const viewer = {
    ready: Promise.resolve(),
    attachStreamingCloud,
    detachStreamingCloud: vi.fn(),
    activeBackend: () => 'webgl2' as const,
    availableImageExportModes: () => new Map(),
    setMode: vi.fn(),
    frameAll: vi.fn(),
    hasStreamingCloud: false,
    clouds: () => [],
  };
  return { viewer, getAttached: (): unknown => attachedSource };
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

function makeDeps(opts: ViewerOptions = {}) {
  const { viewer, getAttached } = fakeViewer(opts);
  const deps: HeavyLasBridgeDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer as unknown as Viewer,
    isPhone: () => false,
    renderBudget: 2_000_000,
    deviceMemoryGB: () => 0.001,
    dock: {
      setEmpty: vi.fn(), setMeasureEnabled: vi.fn(), setAnnotateEnabled: vi.fn(),
      setInspectEnabled: vi.fn(), setProbeEnabled: vi.fn(), setCloseEnabled: vi.fn(), setBackend: vi.fn(),
    },
    inspector: { setEmpty: vi.fn() },
    navBar: { element: { classList: { remove: vi.fn() } }, setMode: vi.fn(), flashHelp: vi.fn() },
    stage: { hideEmptyState: vi.fn() },
    body: { classList: { add: vi.fn() } },
    setPhase: vi.fn(),
    debug: false,
    streaming: fakeStreaming(viewer),
  } as unknown as HeavyLasBridgeDeps;
  return { deps, getAttached };
}

interface EnvOptions {
  /** Run after the build promotes, before the executor reads the store. */
  readonly afterBuild?: () => void;
}

function makeEnv(
  range: RangeSource,
  opfs: ReturnType<typeof fakeOpfs>,
  opts: EnvOptions = {},
): HeavyLasBridgeEnv {
  const reading: StorageEstimateReading = { available: true, quotaBytes: 200_000_000_000, usageBytes: 0 };
  return {
    capable: () => true,
    openRange: () => range,
    getOpfsRoot: async () => opfs.root,
    readStorage: async () => reading,
    async runIndex(req) {
      const result = await buildLocalOocStore(range, opfs.root, req.storeName, {
        pointsPerLeaf: req.pointsPerLeaf,
        memoryBudgetBytes: req.memoryBudgetBytes,
        maxDepth: req.maxDepth,
        batchPoints: 4096,
        signal: req.signal,
        onPhase: req.onPhase,
      });
      opts.afterBuild?.();
      return result;
    },
  };
}

// The store directories only — NOT the `ooc-cache-map.json` record, which also
// begins with `ooc-` but is the map, not a store.
const oocDirs = (opfs: ReturnType<typeof fakeOpfs>): string[] =>
  opfs.topLevel().filter((n) => n.startsWith('ooc-') && n !== 'ooc-cache-map.json');

describe('heavy OOC store lifecycle is leak- and collision-free', () => {
  it('reuses ONE recorded store for two opens of the same file (the cache hit)', async () => {
    const buffer = lasBytes(40_000);
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    let builds = 0;

    const openOnce = async () => {
      const file = spyFile('same.las', buffer.byteLength);
      const { deps } = makeDeps();
      const env = makeEnv(new ArrayBufferRangeSource(buffer), opfs, {
        afterBuild: () => {
          builds += 1;
        },
      });
      const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
      expect(result.status).toBe('attached');
    };

    await openOnce();
    await openOnce();

    // The second open matched the fingerprint and reopened the stored index, so
    // there is exactly one store and the index was built only once.
    expect(oocDirs(opfs)).toHaveLength(1);
    expect(builds).toBe(1);
  });

  it('retains the recorded store when a source closes, so a later open still finds it', async () => {
    const buffer = lasBytes(40_000);
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });

    const open = async () => {
      const file = spyFile('same.las', buffer.byteLength);
      const { deps, getAttached } = makeDeps();
      const env = makeEnv(new ArrayBufferRangeSource(buffer), opfs);
      const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
      expect(result.status).toBe('attached');
      return getAttached() as OlvTileSource;
    };

    const first = await open();
    expect(oocDirs(opfs)).toHaveLength(1);

    // Closing the source of a RECORDED store retains it — a recorded index is
    // kept for reuse, not deleted (the pre-cache behaviour).
    await first.close();
    expect(oocDirs(opfs)).toHaveLength(1);

    // A later open of the same file reopens that retained store: still one store,
    // and the second source is live over it.
    const second = await open();
    expect(oocDirs(opfs)).toHaveLength(1);
    expect(second).toBeDefined();
  });

  it('leaves NO store when the open is aborted right after promotion', async () => {
    const buffer = lasBytes(40_000);
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    const controller = new AbortController();
    const file = spyFile('heavy.las', buffer.byteLength);
    const { deps } = makeDeps();
    // Abort the instant the build promotes, before the executor reopens it.
    const env = makeEnv(new ArrayBufferRangeSource(buffer), opfs, {
      afterBuild: () => controller.abort(),
    });

    const result = await openLocalHeavyLas(file, controller.signal, deps, env);
    expect(result.status).toBe('cancelled');
    expect(oocDirs(opfs)).toHaveLength(0);
    expect(opfs.topLevel().some((n) => n.endsWith('.partial'))).toBe(false);
  });

  it('leaves NO store when the attach fails after promotion', async () => {
    const buffer = lasBytes(40_000);
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    const file = spyFile('heavy.las', buffer.byteLength);
    const { deps } = makeDeps({ attachThrows: true });
    const env = makeEnv(new ArrayBufferRangeSource(buffer), opfs);

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('failed');
    expect(oocDirs(opfs)).toHaveLength(0);
    expect(opfs.topLevel().some((n) => n.endsWith('.partial'))).toBe(false);
  });

  it('discards the partial when the promotion copy fails (finding #2)', async () => {
    const buffer = lasBytes(30_000);
    const range = new ArrayBufferRangeSource(buffer);

    // First, a clean build with no move and no quota, to measure the finished
    // store size. The `move`-absent path copies each tile, so its transient
    // peak is store + one tile, which a quota set at the store size trips.
    const measure = fakeOpfs({ syncAccess: true, fileMove: false });
    await buildLocalOocStore(range, measure.root, 'ooc-measure', { batchPoints: 4096 });
    const storeBytes = measure.totalBytes();

    const opfs = fakeOpfs({ syncAccess: true, fileMove: false, quotaBytes: storeBytes });
    await expect(
      buildLocalOocStore(new ArrayBufferRangeSource(buffer), opfs.root, 'ooc-quota', {
        batchPoints: 4096,
      }),
    ).rejects.toBeTruthy();

    // No promoted store, and no partial left behind.
    expect(opfs.topLevel().some((n) => n === 'ooc-quota')).toBe(false);
    expect(opfs.topLevel().some((n) => n.endsWith('.partial'))).toBe(false);
  });
});
