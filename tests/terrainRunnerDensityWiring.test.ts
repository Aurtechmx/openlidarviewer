/**
 * terrainRunnerDensityWiring.test.ts — the APP-LAYER half of the strided-gather
 * density honesty path (v0.4.5 wiring).
 *
 * `densitySampleScale.test.ts` proves the pipeline scales densities when
 * `samplePointScale` is supplied; this test proves the terrain-analysis RUNNER
 * actually supplies it — `totalPoints / sampledPoints` from the gather result —
 * so a strided gather reports the SCAN's density through the real run path.
 * Exercises the worker bridge's main-thread fallback (no Worker in Node).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { analyseContours, type AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';

/** Gently sloped plane sampled at exactly 4 pts/m² (0.5 m grid) over 30×30 m. */
function densePlane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 30; x += 0.5) {
    for (let y = 0; y < 30; y += 0.5) {
      pts.push(x, y, 0.02 * x + 0.01 * y);
    }
  }
  return Float32Array.from(pts);
}

/** Every `stride`-th point — the same uniform subsample the gather takes. */
function strided(full: Float32Array, stride: number): Float32Array {
  const n = full.length / 3;
  const out: number[] = [];
  for (let i = 0; i < n; i += stride) {
    out.push(full[i * 3], full[i * 3 + 1], full[i * 3 + 2]);
  }
  return Float32Array.from(out);
}

/** Build a runner over stubbed deps whose gather returns `positions` + `totalPoints`. */
function makeRunner(
  positions: Float32Array,
  totalPoints: number,
  onResult: (r: AnalyseContoursResult) => void,
) {
  const fakeViewer = {
    gatherTerrainPositions: () => ({
      positions,
      classification: undefined,
      residentOnly: false,
      sampled: totalPoints > positions.length / 3,
      totalPoints,
    }),
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: () => true,
    setBusy: () => {},
    setStatus: () => {},
    update: () => {},
    setContourFrame: () => {},
  } as unknown as AnalysePanel;
  const fakeCrs = { current: () => null } as unknown as CrsService;
  return createTerrainAnalysisRunner({
    getViewer: () => fakeViewer,
    getAnalysePanel: () => fakePanel,
    getActiveId: () => 'scan-1',
    crsService: fakeCrs,
    onResult,
  });
}

describe('terrainAnalysisRunner density wiring (samplePointScale)', () => {
  // Node has no Worker, so the runner's terrain-core offload announces its
  // (expected) fallback on console.warn before computing on the main thread.
  // Silenced — the assertions here read density figures, not the console.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  const full = densePlane(); // 3600 points, 4 pts/m² by construction
  const quarter = strided(full, 4); // 900 points reach the analysis
  // The runner derives cellSizeM = max(0.25, extent / 256) — reproduce it so
  // the reference pipeline run below shares the exact grid.
  const extent = Math.max(29.5, 29.5, 1);
  const cellSizeM = Math.max(0.25, extent / 256);

  it('a strided gather reports the SCAN density, 4× the unscaled run', async () => {
    clearTerrainCoreCache();
    let got: AnalyseContoursResult | null = null;
    const runner = makeRunner(quarter, full.length / 3, (r) => {
      got = r;
    });
    await runner.run();
    expect(got).not.toBeNull();
    // Reference: the same subsample through the pipeline WITHOUT the scale.
    const unscaled = analyseContours(quarter, { cellSizeM });
    const scaled = (got as unknown as AnalyseContoursResult).cellMetrics.meanDensity;
    expect(scaled).toBeCloseTo(unscaled.cellMetrics.meanDensity * 4, 6);
  });

  it('an un-strided gather (totalPoints == sampled) scales by exactly 1', async () => {
    clearTerrainCoreCache();
    let got: AnalyseContoursResult | null = null;
    const runner = makeRunner(quarter, quarter.length / 3, (r) => {
      got = r;
    });
    await runner.run();
    expect(got).not.toBeNull();
    const unscaled = analyseContours(quarter, { cellSizeM });
    expect((got as unknown as AnalyseContoursResult).cellMetrics.meanDensity).toBeCloseTo(
      unscaled.cellMetrics.meanDensity,
      6,
    );
  });

  it('a degenerate totalPoints (0 / NaN) falls back to scale 1, never 0', async () => {
    clearTerrainCoreCache();
    let got: AnalyseContoursResult | null = null;
    const runner = makeRunner(quarter, Number.NaN, (r) => {
      got = r;
    });
    await runner.run();
    expect(got).not.toBeNull();
    const unscaled = analyseContours(quarter, { cellSizeM });
    expect((got as unknown as AnalyseContoursResult).cellMetrics.meanDensity).toBeCloseTo(
      unscaled.cellMetrics.meanDensity,
      6,
    );
  });
});
