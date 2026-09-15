/**
 * terrainRunnerResultHook.test.ts
 *
 * `onResult` is the runner's one "a run produced something" signal, and the
 * phone shell now hangs a visible consequence off it: the bottom sheet opens on
 * the Analyse tab at the assessment. That makes the hook's firing rule part of
 * the contract rather than an internal detail. It must fire exactly once for a
 * run that lands, and not at all for a run that refuses, or a refusal would
 * throw the sheet open over an empty panel.
 *
 * The success case walks a small plane through the real pipeline on the main
 * thread (Node has no Worker), the same way terrainRunnerDensityWiring does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';
import { spatialContextFrom } from '../src/geo/SpatialContext';

/** A gently sloped plane, 1 m spacing over 20x20 m: 441 points. */
function plane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 20; x += 1) {
    for (let y = 0; y <= 20; y += 1) pts.push(x, y, 0.02 * x + 0.01 * y);
  }
  return Float32Array.from(pts);
}

function fakePanel(): AnalysePanel {
  return {
    isVisible: () => true,
    setBusy: () => {},
    setStatus: () => {},
    update: () => {},
    setContourFrame: () => {},
  } as unknown as AnalysePanel;
}

function fakeCrs(): CrsService {
  return {
    crsRevision: () => 0,
    current: () => null,
    context: () => spatialContextFrom(null),
  } as unknown as CrsService;
}

/** A runner whose gather lands `positions`, or refuses when given none. */
function makeRunner(positions: Float32Array | null, onResult: () => void) {
  const viewer = {
    gatherTerrainPositions: () => (positions
      ? {
        positions,
        classification: undefined,
        groundIsDerived: false,
        residentOnly: false,
        sampled: false,
        totalPoints: positions.length / 3,
      }
      : null),
    clouds: () => (positions ? ['scan-1'] : []),
    getCloud: () => null,
    streamingCloud: null,
  } as unknown as Viewer;
  return createTerrainAnalysisRunner({
    getViewer: () => viewer,
    getAnalysePanel: fakePanel,
    getActiveId: () => 'scan-1',
    crsService: fakeCrs(),
    onResult,
  });
}

// The main-thread fallback is compute-bound, and v8 coverage instrumentation
// makes that compute far slower than the 15 s default allows.
const INSTRUMENTED_COMPUTE_TIMEOUT_MS = 120_000;

describe('terrain runner result hook', { timeout: INSTRUMENTED_COMPUTE_TIMEOUT_MS }, () => {
  // Node has no Worker, so the offload announces its expected fallback on warn.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warnSpy.mockRestore());

  it('fires exactly once for a run that lands', async () => {
    clearTerrainCoreCache();
    const onResult = vi.fn();
    await makeRunner(plane(), onResult).run();
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('never fires for a refused run', async () => {
    clearTerrainCoreCache();
    const onResult = vi.fn();
    await makeRunner(null, onResult).run();
    expect(onResult).not.toHaveBeenCalled();
  });
});
