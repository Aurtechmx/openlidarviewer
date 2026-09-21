/**
 * terrainRunnerFallbackStatus.test.ts
 *
 * A successful analysis that ran on the MAIN THREAD because the worker was
 * unavailable used to look identical to one that ran off-thread: the only
 * record was a console.warn and a path marker no user can read. The result is
 * real, but the page blocked while it was computed and the worker is still
 * broken, so the panel now says so.
 *
 * Node has no `Worker`, so the runner's bridge takes the fallback for real
 * here. The status under test is produced by the same code path a browser
 * with a broken worker chunk would take.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';

const FALLBACK_STATUS =
  'Computed on the main thread because the analysis worker was unavailable; the page may have paused. Reload to restore the worker.';

/** A small sloped plane: enough for a real core, cheap enough for a unit test. */
function smallPlane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 10; x += 0.5) {
    for (let y = 0; y < 10; y += 0.5) pts.push(x, y, 0.02 * x + 0.01 * y);
  }
  return Float32Array.from(pts);
}

function harness(positions: Float32Array) {
  const statuses: string[] = [];
  const fakeViewer = {
    gatherTerrainPositions: () => ({
      positions,
      classification: undefined,
      groundIsDerived: false,
      residentOnly: false,
      sampled: false,
      totalPoints: positions.length / 3,
    }),
    clouds: () => ['scan-1'],
    getCloud: () => null,
    // Unplaced: the permit then reads the layer's own frame, as it always did.
    layerProjectOffset: () => null,
    streamingCloud: null,
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: () => true,
    setBusy: vi.fn(),
    setStatus: (t: string) => void statuses.push(t),
    update: vi.fn(),
    setContourFrame: vi.fn(),
  } as unknown as AnalysePanel;
  const fakeCrs = {
    crsRevision: () => 0,
    current: () => null,
    context: () => spatialContextFrom(null),
  } as unknown as CrsService;
  const runner = createTerrainAnalysisRunner({
    getViewer: () => fakeViewer,
    getAnalysePanel: () => fakePanel,
    getActiveId: () => 'scan-1',
    crsService: fakeCrs,
  });
  return { runner, statuses };
}

describe('terrain analysis status after a main-thread fallback', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('names the unavailable worker and the pause it cost', { timeout: 120_000 }, async () => {
    const h = harness(smallPlane());
    await h.runner.run();
    expect(h.statuses).toContain(FALLBACK_STATUS);
  });
});
