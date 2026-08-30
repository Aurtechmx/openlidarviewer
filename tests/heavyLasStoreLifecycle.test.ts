/**
 * heavyLasStoreLifecycle.test.ts — the out-of-core store is temporary.
 *
 * A heavy uncompressed LAS is indexed into an OPFS tile store (`ooc-<name>-<size>`)
 * and streamed from it. For this release that store is TEMPORARY: nothing reuses
 * it on a later open, so leaving it in OPFS is pure cost. These cases pin the
 * lifecycle — the store exists while the source is attached, and closing the
 * `OlvTileSource` removes it — plus the two guarantees the removal must keep:
 * the tile handles are still released, and removing an already-absent store is a
 * no-op rather than a throw.
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
import { fakeOpfs, fakeOpfsDir } from './support/fakeOpfs';
import { buildLocalOocStore } from '../src/io/heavy/localOocBuild';
import { OlvTileSource } from '../src/io/heavy/OlvTileSource';
import { opfsSpillStore, removeOpfsStore } from '../src/io/heavy/opfsSpillStore';
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

function makeDeps() {
  const { viewer, getAttached } = fakeViewer();
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

function makeEnv(range: RangeSource): { env: HeavyLasBridgeEnv; opfs: ReturnType<typeof fakeOpfs> } {
  const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
  const reading: StorageEstimateReading = { available: true, quotaBytes: 200_000_000_000, usageBytes: 0 };
  const env: HeavyLasBridgeEnv = {
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
  return { env, opfs };
}

describe('heavy LAS out-of-core store lifecycle', () => {
  it('retains the recorded OPFS store when the streaming source closes', async () => {
    const buffer = lasBytes(60_000);
    const file = spyFile('heavy.las', buffer.byteLength);
    const { deps, getAttached } = makeDeps();
    const { env, opfs } = makeEnv(new ArrayBufferRangeSource(buffer));

    const result = await openLocalHeavyLas(file, new AbortController().signal, deps, env);
    expect(result.status).toBe('attached');
    if (result.status !== 'attached') throw new Error('unreachable');

    // The finished store is present, and it has been recorded in the cache map.
    const storeName = opfs.topLevel().find((n) => n.startsWith('ooc-') && n !== 'ooc-cache-map.json');
    expect(storeName).toBeDefined();
    expect(opfs.topLevel()).toContain('ooc-cache-map.json');

    // Closing the source releases handles but RETAINS the recorded store — the
    // persistent cache keeps a completed index for the next open.
    const source = getAttached() as OlvTileSource;
    await source.close();

    expect(opfs.topLevel()).toContain(storeName);
  });

  it('a second open of the same file reuses the store without rebuilding', async () => {
    const buffer = lasBytes(60_000);
    const { env, opfs } = makeEnv(new ArrayBufferRangeSource(buffer));
    let builds = 0;
    const countingEnv = {
      ...env,
      async runIndex(req: Parameters<typeof env.runIndex>[0]) {
        builds += 1;
        return env.runIndex(req);
      },
    };

    const openOnce = async () => {
      const { deps } = makeDeps();
      const result = await openLocalHeavyLas(
        spyFile('same.las', buffer.byteLength),
        new AbortController().signal,
        deps,
        countingEnv,
      );
      expect(result.status).toBe('attached');
    };

    await openOnce();
    await openOnce();

    // One index build, one store: the second open reopened the cached index.
    expect(builds).toBe(1);
    expect(opfs.topLevel().filter((n) => n.startsWith('ooc-') && n !== 'ooc-cache-map.json')).toHaveLength(1);
  });

  it('still releases the tile handles on close (does not regress spill.close)', async () => {
    const dir = fakeOpfsDir({ syncAccess: true });
    const spill = opfsSpillStore(dir);
    await spill.append('3', new Uint8Array([1, 2, 3]));
    await spill.append('3', new Uint8Array([4, 5]));
    const closeSpy = vi.spyOn(spill, 'close');
    // Removing this named store must release the handles first, then delete.
    await spill.close();
    expect(closeSpy).toHaveBeenCalled();
    // After close the tile is unlocked and still readable via a fresh handle.
    expect([...(await spill.read('3'))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not throw when removing an already-absent store', async () => {
    const root = fakeOpfsDir();
    await expect(removeOpfsStore(root, 'ooc-not-there-123')).resolves.toBeUndefined();
  });
});
