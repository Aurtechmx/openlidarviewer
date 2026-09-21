/**
 * terrainRunnerHarness.ts: the doubles the terrain-runner unit tests drive
 * `createTerrainAnalysisRunner` with.
 *
 * A runner test needs four collaborators that are identical every time: a
 * Viewer that gathers one gentle plane, an Analyse panel that records rather
 * than renders, a metre-grid CRS service, and the active-scan id. Only the
 * assertions differ. Holding the doubles here means a change to the runner's
 * dependency shape is one edit, and a test file reads as the property it pins.
 *
 * The panel double RECORDS: `frames` collects every contour frame the runner
 * publishes and `stories` every Dataset Story element it mounts, so a test
 * asserts on what the runner handed the panel rather than on a spy's calls.
 */

import { createTerrainAnalysisRunner, type TerrainAnalysisRunner } from '../../src/app/terrainAnalysisRunner';
import { spatialContextFrom } from '../../src/geo/SpatialContext';
import type { Viewer } from '../../src/render/Viewer';
import type { AnalysePanel } from '../../src/ui/AnalysePanel';
import type { CrsService } from '../../src/geo/CrsService';
import type { ScanFacts } from '../../src/process/ProcessPlan';
import type { ScanStoryInputs } from '../../src/intelligence/scanStory';
import type { LaunchFrameContext } from '../../src/terrain/contourStudio/contourStudioLaunchStateFromResult';

/** A 20x20 lattice on a gentle slope: enough to classify, cheap to analyse. */
export function gentlePlane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 20; x += 1) {
    for (let y = 0; y < 20; y += 1) pts.push(x, y, 0.02 * x + 0.01 * y);
  }
  return Float32Array.from(pts);
}

/** A projected CRS in metres, with no unit or datum ambiguity to reason about. */
export const METRE_GRID = {
  kind: 'projected', name: 'Test / metre grid',
  linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1,
} as const;

/** A `ScanFacts` with the given coverage and kind, everything else benign. */
export function scanFacts(
  coverage: ScanFacts['coverage'],
  kind: ScanFacts['kind'] = 'static',
): ScanFacts {
  return {
    kind, coverage,
    crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as ScanFacts['crs'],
    pointCount: 1_000_000,
    hasRgb: false, hasIntensity: false, hasGpsTime: false,
    hasReturnNumber: false, hasPointSourceId: false,
    classification: 'full', classificationProvenance: 'producer',
    groundClassified: true, hasBuildingClass: false,
  };
}

export interface TerrainRunnerHarness {
  readonly runner: TerrainAnalysisRunner;
  /** Every contour frame the runner published, in order. */
  readonly frames: LaunchFrameContext[];
  /** Every Dataset Story element the runner mounted, in order. */
  readonly stories: unknown[];
}

/**
 * Build a runner over the shared doubles. `getScanFacts` and `buildStoryInputs`
 * are passed straight through, so a test that omits one pins the behaviour of a
 * host that wires nothing.
 */
export function terrainRunnerHarness(opts: {
  getScanFacts?: () => ScanFacts | null;
  buildStoryInputs?: () => ScanStoryInputs;
} = {}): TerrainRunnerHarness {
  const frames: LaunchFrameContext[] = [];
  const stories: unknown[] = [];
  const cloud = {
    sourceOrigin: [500_000, 4_500_000, 0] as [number, number, number],
    bounds: () => ({
      min: [0, 0, 0] as [number, number, number],
      max: [2_000, 2_000, 100] as [number, number, number],
    }),
  };
  const viewer = {
    gatherTerrainPositions: () => ({
      positions: gentlePlane(), classification: undefined, groundIsDerived: false,
      residentOnly: false, sampled: false, totalPoints: gentlePlane().length / 3,
      sourceUpAxis: 'z' as const,
    }),
    getCloud: () => cloud,
    // Unplaced: the permit then reads the layer's own frame, as it always did.
    layerProjectOffset: () => null,
    streamingCloud: null,
    clouds: () => [cloud],
  } as unknown as Viewer;
  const panel = {
    isVisible: () => true, setBusy: () => {}, setStatus: () => {}, update: () => {},
    setContourFrame: (f: unknown) => frames.push(f as LaunchFrameContext),
    setDatasetStory: (e: unknown) => stories.push(e),
  } as unknown as AnalysePanel;
  const context = spatialContextFrom(METRE_GRID as unknown as Parameters<typeof spatialContextFrom>[0]);
  const crsService: Pick<CrsService, 'current' | 'context' | 'crsRevision'> = {
    crsRevision: () => 0,
    current: () => METRE_GRID as unknown as ReturnType<CrsService['current']>,
    context: () => context,
  };
  const runner = createTerrainAnalysisRunner({
    getViewer: () => viewer,
    getAnalysePanel: () => panel,
    getActiveId: () => 'scan-1',
    crsService,
    getScanFacts: opts.getScanFacts,
    buildStoryInputs: opts.buildStoryInputs,
  });
  return { runner, frames, stories };
}
