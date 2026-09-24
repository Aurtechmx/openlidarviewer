/**
 * terrainRunnerWithheldRecovery.test.ts: wiring the Withheld-aware recovery
 * gather into the live analysis path (L26).
 *
 * The display gather stamps withheldExcluded === null when a contributing
 * buffer carries no flags channel, which for a lone static cloud means it was
 * voxel-downsampled at load. `run()` now resolves that cloud's original File
 * through `deps.getRecoverySource`, re-decodes it, and rasterises over the
 * recovered points instead. Snapshot (the run's token/dataset/CRS, already
 * captured), Await (the re-decode), Revalidate (`bail()`), Commit (only the
 * winning run's result reaches the panel).
 *
 * Four properties are pinned: the real path lands an "excluded" DTM built
 * from a real synthetic LAS; a refusal (unparseable source) falls back to
 * today's display-derived DTM, unchanged; a dataset or CRS change while the
 * recovery is in flight discards it; and the run's own cancellation
 * (`abortAndClearCache`, the same mechanism a closed scan already uses)
 * reaches the recovery's AbortSignal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { writeLas } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

const gatherModule = await import('../src/terrain/ground/withheldAwareTerrainGather');

const WITHHELD_FLAG = 0b0100;

/** A small sloped plane: enough for a real core, cheap enough for a unit test. */
function smallPlane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 10; x += 0.5) {
    for (let y = 0; y < 10; y += 0.5) pts.push(x, y, 0.02 * x + 0.01 * y);
  }
  return Float32Array.from(pts);
}

/** A synthetic LAS, built with the repo's own writer, with `withheldOf` of its points marked Withheld. */
function buildLasFile(name: string, n: number, withheldEvery: number): File {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const classification = new Uint8Array(n).fill(2);
  const classificationFlags = new Uint8Array(n);
  let i = 0;
  const side = Math.ceil(Math.sqrt(n));
  for (let r = 0; r < side && i < n; r++) {
    for (let c = 0; c < side && i < n; c++, i++) {
      x[i] = c * 0.5;
      y[i] = r * 0.5;
      z[i] = 0.02 * (c * 0.5) + 0.01 * (r * 0.5);
      if (i % withheldEvery === 0) classificationFlags[i] = WITHHELD_FLAG;
    }
  }
  const g: GlobalPoints = { count: n, x, y, z, classification, classificationFlags };
  const bytes = writeLas(g);
  return new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], name);
}

interface HarnessOpts {
  readonly getActiveId: () => string | null;
  readonly getRecoverySource?: (id: string) => File | null;
  readonly crsRevision?: () => number;
}

function harness(opts: HarnessOpts) {
  const updates: AnalyseContoursResult[] = [];
  const statuses: string[] = [];
  const fakeViewer = {
    gatherTerrainPositions: () => ({
      positions: smallPlane(),
      classification: undefined,
      groundIsDerived: false,
      residentOnly: false,
      sampled: false,
      totalPoints: smallPlane().length / 3,
      // The display path stamped "not recorded": a contributing buffer had
      // no flags channel, as a voxel-downsampled static cloud always does.
      withheldExcluded: null,
      withheldExcludedCount: 0,
    }),
    clouds: () => ['scan-1'],
    getCloud: () => null,
    layerProjectOffset: () => null,
    streamingCloud: null,
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: () => true,
    setBusy: vi.fn(),
    setStatus: (t: string) => { statuses.push(t); },
    update: (r: AnalyseContoursResult) => { updates.push(r); },
    setContourFrame: vi.fn(),
  } as unknown as AnalysePanel;
  const fakeCrs: Pick<CrsService, 'current' | 'context' | 'crsRevision'> = {
    crsRevision: opts.crsRevision ?? (() => 0),
    current: () => null,
    context: () => spatialContextFrom(null),
  };
  const runner = createTerrainAnalysisRunner({
    getViewer: () => fakeViewer,
    getAnalysePanel: () => fakePanel,
    getActiveId: opts.getActiveId,
    crsService: fakeCrs,
    getRecoverySource: opts.getRecoverySource,
  });
  return { runner, updates, statuses };
}

const RECOVERED_STATUS_FRAGMENT = 'excluded from this surface';

describe('the real path: a synthetic over-budget LAS with Withheld points', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('lands a DTM stamped "excluded", through the real gatherWithheldAwareTerrainCore', async () => {
    const file = buildLasFile('big.las', 400, 5); // 400 points, 1 in 5 Withheld
    const { runner, updates, statuses } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: (id) => (id === 'scan-1' ? file : null),
    });
    await runner.run();
    expect(updates).toHaveLength(1);
    expect(updates[0].dtm.withheldExcluded).toBe(true);
    expect(updates[0].dtm.withheldExcludedCount).toBeGreaterThan(0);
    expect(statuses.some((s) => s.includes(RECOVERED_STATUS_FRAGMENT))).toBe(true);
  }, 120_000);

  it('never attempts recovery when no source File is retained for the active cloud', async () => {
    const { runner, updates, statuses } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: () => null,
    });
    await runner.run();
    expect(updates).toHaveLength(1);
    expect(updates[0].dtm.withheldExcluded ?? null).toBeNull();
    expect(statuses.some((s) => s.includes(RECOVERED_STATUS_FRAGMENT))).toBe(false);
  }, 120_000);
});

describe('a refusal falls back to the display-derived DTM, unchanged', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('an unparseable source is refused and the display core lands "not recorded"', async () => {
    const garbage = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'not-a-las.las');
    const { runner, updates, statuses } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: () => garbage,
    });
    await runner.run();
    expect(updates).toHaveLength(1);
    expect(updates[0].dtm.withheldExcluded ?? null).toBeNull();
    expect(statuses.some((s) => s.includes(RECOVERED_STATUS_FRAGMENT))).toBe(false);
  }, 120_000);
});

describe('a change mid-gather discards the recovered result (§18 revalidate)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearTerrainCoreCache();
  });

  it('a dataset change while the recovery is in flight is never committed', async () => {
    let activeId: string | null = 'scan-1';
    const { runner, updates } = harness({
      getActiveId: () => activeId,
      getRecoverySource: () => new File([new Uint8Array(8)], 'irrelevant.las'),
    });
    const spy = vi.spyOn(gatherModule, 'gatherWithheldAwareTerrainCore').mockImplementation(async () => {
      // The dataset changes while this call is in flight, before it resolves.
      queueMicrotask(() => { activeId = 'scan-2'; });
      return { core: {} as never, sample: {} as never, totalPoints: 1 };
    });
    await runner.run();
    expect(updates).toHaveLength(0);
    spy.mockRestore();
  }, 120_000);

  it('a CRS revision change while the recovery is in flight is never committed', async () => {
    let rev = 0;
    const { runner, updates } = harness({
      getActiveId: () => 'scan-1',
      crsRevision: () => rev,
      getRecoverySource: () => new File([new Uint8Array(8)], 'irrelevant.las'),
    });
    const spy = vi.spyOn(gatherModule, 'gatherWithheldAwareTerrainCore').mockImplementation(async () => {
      queueMicrotask(() => { rev += 1; });
      return { core: {} as never, sample: {} as never, totalPoints: 1 };
    });
    await runner.run();
    expect(updates).toHaveLength(0);
    spy.mockRestore();
  }, 120_000);
});

describe('the existing analysis cancellation reaches the recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearTerrainCoreCache();
  });

  it('abortAndClearCache aborts the signal handed to gatherWithheldAwareTerrainCore', async () => {
    let capturedSignal: AbortSignal | undefined;
    const { runner } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: () => new File([new Uint8Array(8)], 'irrelevant.las'),
    });
    const spy = vi.spyOn(gatherModule, 'gatherWithheldAwareTerrainCore')
      .mockImplementation((_buffer, _name, _params, options) => {
        capturedSignal = options?.signal;
        // Cancel once inside the pending call, the same window a scan close
        // already cancels in.
        queueMicrotask(() => { runner.abortAndClearCache(); });
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
    await runner.run();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
    spy.mockRestore();
  }, 120_000);
});
