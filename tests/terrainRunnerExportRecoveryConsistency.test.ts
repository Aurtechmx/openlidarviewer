/**
 * terrainRunnerExportRecoveryConsistency.test.ts: an export must never state
 * a different Withheld outcome than the analysis the user saw.
 *
 * `buildResultForExport`/`buildResultAtInterval` (the DTM export and the PDF
 * report path both build through them) used to re-derive their core through
 * the fingerprint cache, keyed on the DISPLAY gather's params. That cache can
 * never hit a core `run()` built through the Withheld-aware recovery, whose
 * params (withheldExcluded, classification, points) differ, so an export
 * built right after a recovered run silently rebuilt from the display
 * sample and reported "not recorded" for a scan the panel had just called
 * "excluded".
 *
 * The runner now remembers the last WINNING run's core against the dataset
 * and CRS revision it was committed for, and an export build for that exact
 * identity reuses it verbatim.
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

const WITHHELD_FLAG = 0b0100;

function smallPlane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 10; x += 0.5) {
    for (let y = 0; y < 10; y += 0.5) pts.push(x, y, 0.02 * x + 0.01 * y);
  }
  return Float32Array.from(pts);
}

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

function harness(opts: { getActiveId: () => string | null; getRecoverySource?: (id: string) => File | null }) {
  const updates: AnalyseContoursResult[] = [];
  const fakeViewer = {
    gatherTerrainPositions: () => ({
      positions: smallPlane(),
      classification: undefined,
      groundIsDerived: false,
      residentOnly: false,
      sampled: false,
      totalPoints: smallPlane().length / 3,
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
    setStatus: vi.fn(),
    update: (r: AnalyseContoursResult) => { updates.push(r); },
    setContourFrame: vi.fn(),
  } as unknown as AnalysePanel;
  const fakeCrs: Pick<CrsService, 'current' | 'context' | 'crsRevision'> = {
    crsRevision: () => 0,
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
  return { runner, updates };
}

const bytesOf = (a: Float32Array | Uint32Array | Uint8Array): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

describe('after a recovered run', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('the export build carries withheldExcluded === true and the analysed core\'s cells', async () => {
    const file = buildLasFile('big.las', 400, 5);
    const { runner, updates } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: (id) => (id === 'scan-1' ? file : null),
    });
    await runner.run();
    expect(updates).toHaveLength(1);
    expect(updates[0].dtm.withheldExcluded).toBe(true);

    const exported = await runner.buildResultForExport({ intervalM: 1, shapeStyle: 'smooth' });
    expect(exported.dtm.withheldExcluded).toBe(true);
    expect(exported.dtm.withheldExcludedCount).toBe(updates[0].dtm.withheldExcludedCount);
    expect(bytesOf(exported.dtm.z)).toEqual(bytesOf(updates[0].dtm.z));
    expect(bytesOf(exported.dtm.counts)).toEqual(bytesOf(updates[0].dtm.counts));
  }, 120_000);

  it('buildResultAtInterval (the report path) agrees too', async () => {
    const file = buildLasFile('big.las', 400, 5);
    const { runner, updates } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: (id) => (id === 'scan-1' ? file : null),
    });
    await runner.run();
    const reported = await runner.buildResultAtInterval(2);
    expect(reported.dtm.withheldExcluded).toBe(true);
    expect(bytesOf(reported.dtm.z)).toEqual(bytesOf(updates[0].dtm.z));
  }, 120_000);
});

describe('after a fallback run (no recovery source, or a refusal)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('both the export and the report still carry null', async () => {
    const { runner, updates } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: () => null,
    });
    await runner.run();
    expect(updates[0].dtm.withheldExcluded ?? null).toBeNull();

    const exported = await runner.buildResultForExport({ intervalM: 1, shapeStyle: 'smooth' });
    expect(exported.dtm.withheldExcluded ?? null).toBeNull();
    const reported = await runner.buildResultAtInterval(2);
    expect(reported.dtm.withheldExcluded ?? null).toBeNull();
  }, 120_000);

  it('an unparseable recovery source refuses, and the export still agrees with the fallback run', async () => {
    const garbage = new File([new Uint8Array([1, 2, 3, 4])], 'not-a-las.las');
    const { runner, updates } = harness({
      getActiveId: () => 'scan-1',
      getRecoverySource: () => garbage,
    });
    await runner.run();
    expect(updates[0].dtm.withheldExcluded ?? null).toBeNull();
    const exported = await runner.buildResultForExport({ intervalM: 1, shapeStyle: 'smooth' });
    expect(exported.dtm.withheldExcluded ?? null).toBeNull();
  }, 120_000);
});

describe('a different dataset never reuses another scan\'s remembered core', () => {
  it('an export for a scan that never ran through run() resolves its own core, not scan-1\'s', async () => {
    const file = buildLasFile('big.las', 400, 5);
    let activeId = 'scan-1';
    const { runner, updates } = harness({
      getActiveId: () => activeId,
      getRecoverySource: (id) => (id === 'scan-1' ? file : null),
    });
    await runner.run();
    expect(updates[0].dtm.withheldExcluded).toBe(true);

    activeId = 'scan-2'; // a different scan is now active; no File retained for it
    const exported = await runner.buildResultForExport({ intervalM: 1, shapeStyle: 'smooth' });
    expect(exported.dtm.withheldExcluded ?? null).toBeNull();
  }, 120_000);
});
