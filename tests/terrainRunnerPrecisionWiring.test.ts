/**
 * terrainRunnerPrecisionWiring.test.ts — the APP-LAYER half of the wide-area
 * precision policy.
 *
 * `precisionExportRefusal.test.ts` proves the gate refuses when it is handed a
 * refused permit. That is worth nothing on its own: a tested model with no
 * production caller is exactly the gap §19 was written to close. This test
 * proves the terrain-analysis RUNNER measures the live scan and pushes the
 * result into the Contour Studio launch frame, which is where the export permit
 * reads it from.
 *
 * The gathered points and the scan's frame are deliberately different objects:
 * the analysis runs over a small plane so the test is fast, while the cloud the
 * runner reads the frame from spans a continent. If the runner ever measured
 * the gather instead of the loaded cloud, the assertion below flips.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import type { PrecisionPermit } from '../src/geo/inMemoryPrecision';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';
import { spatialContextFrom } from '../src/geo/SpatialContext';

/** A small sloped plane — enough for the pipeline, cheap to analyse. */
function plane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 20; x += 1) {
    for (let y = 0; y < 20; y += 1) pts.push(x, y, 0.02 * x + 0.01 * y);
  }
  return Float32Array.from(pts);
}

type Frame = { precision: PrecisionPermit | null };

/**
 * Build a runner whose active cloud spans `span` source units about a metre
 * projected CRS, and capture the launch frame it pushes.
 */
function runnerOver(span: number, onFrame: (f: Frame) => void) {
  const cloud = {
    sourceOrigin: [500_000, 4_500_000, 0] as [number, number, number],
    bounds: () => ({
      min: [0, 0, 0] as [number, number, number],
      max: [span, span, span / 20] as [number, number, number],
    }),
  };
  const fakeViewer = {
    gatherTerrainPositions: () => ({
      positions: plane(),
      classification: undefined,
      groundIsDerived: false,
      residentOnly: false,
      sampled: false,
      totalPoints: plane().length / 3,
    }),
    getCloud: () => cloud,
    streamingCloud: null,
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: () => true,
    setBusy: () => {},
    setStatus: () => {},
    update: () => {},
    setContourFrame: (f: unknown) => onFrame(f as Frame),
  } as unknown as AnalysePanel;
  // The runner reads `current()` AND `context()`. Deriving the context here the
  // way the service itself does — one `spatialContextFrom` call over the same
  // resolved CRS — keeps the double honest: a context assembled by hand could
  // state a unit or a datum its own `current()` contradicts, which is the
  // divergence this whole migration removes.
  //
  // Typed as the subset the runner actually uses rather than `as unknown as
  // CrsService`. That double cast is why this double silently fell behind the
  // interface: it defeats the compiler, so adding `context()` to the service
  // broke the test at runtime with nothing failing at build time.
  const resolved = {
    kind: 'projected',
    name: 'Test / metre grid',
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    verticalUnitToMetres: 1,
  } as const;
  const context = spatialContextFrom(resolved as unknown as Parameters<typeof spatialContextFrom>[0]);
  const fakeCrs: Pick<CrsService, 'current' | 'context' | 'crsRevision'> = {
  // The frame revision the run is pinned to; constant in these doubles.
  crsRevision: () => 0,
    current: () => resolved as unknown as ReturnType<CrsService['current']>,
    context: () => context,
  };
  return createTerrainAnalysisRunner({
    getViewer: () => fakeViewer,
    getAnalysePanel: () => fakePanel,
    getActiveId: () => 'scan-1',
    crsService: fakeCrs,
  });
}

describe('terrainAnalysisRunner — in-memory precision wiring', () => {
  // Node has no Worker; the runner announces its expected main-thread fallback.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('pushes a granted permit for a normal survey extent', async () => {
    clearTerrainCoreCache();
    let frame: Frame | null = null;
    await runnerOver(2_000, (f) => {
      frame = f;
    }).run();
    expect(frame).not.toBeNull();
    expect((frame as unknown as Frame).precision).not.toBeNull();
    expect((frame as unknown as Frame).precision?.ok).toBe(true);
  });

  it('pushes a REFUSED permit when the loaded scan is over budget', async () => {
    clearTerrainCoreCache();
    let frame: Frame | null = null;
    await runnerOver(400_000, (f) => {
      frame = f;
    }).run();
    const permit = (frame as unknown as Frame).precision;
    expect(permit).not.toBeNull();
    expect(permit?.ok).toBe(false);
    if (!permit || permit.ok) return;
    expect(permit.reasons.join(' ').toLowerCase()).toContain('copc');
  });
});
