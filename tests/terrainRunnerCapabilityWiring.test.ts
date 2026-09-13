/**
 * terrainRunnerCapabilityWiring.test.ts
 *
 * The terrain runner hands Contour Studio the scan's coverage and capability
 * verdicts from `ScanFacts`, not from the DTM grid. A strided static read has
 * a grid that reads 'full' and facts that read 'sampled'; the frame must say
 * 'sampled', with the DTM verdict naming it, and must not call the scan
 * streaming. Without facts the frame carries no verdicts, which the permit
 * treats as a shortfall.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ScanFacts } from '../src/process/ProcessPlan';
import type { LaunchFrameContext } from '../src/terrain/contourStudio/contourStudioLaunchStateFromResult';

function plane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 20; x += 1) for (let y = 0; y < 20; y += 1) pts.push(x, y, 0.02 * x + 0.01 * y);
  return Float32Array.from(pts);
}

const resolved = { kind: 'projected', name: 'Test / metre grid', linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1 } as const;

function facts(coverage: ScanFacts['coverage'], kind: ScanFacts['kind'] = 'static'): ScanFacts {
  return {
    kind, coverage,
    crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as ScanFacts['crs'],
    pointCount: 1_000_000, hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
    classification: 'full', classificationProvenance: 'producer', groundClassified: true, hasBuildingClass: false,
  };
}

function runner(onFrame: (f: LaunchFrameContext) => void, getScanFacts?: () => ScanFacts | null) {
  const cloud = {
    sourceOrigin: [500_000, 4_500_000, 0] as [number, number, number],
    bounds: () => ({ min: [0, 0, 0] as [number, number, number], max: [2_000, 2_000, 100] as [number, number, number] }),
  };
  const fakeViewer = {
    gatherTerrainPositions: () => ({ positions: plane(), classification: undefined, groundIsDerived: false, residentOnly: false, sampled: false, totalPoints: plane().length / 3 }),
    getCloud: () => cloud,
    streamingCloud: null,
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: () => true, setBusy: () => {}, setStatus: () => {}, update: () => {},
    setContourFrame: (f: unknown) => onFrame(f as LaunchFrameContext),
  } as unknown as AnalysePanel;
  const context = spatialContextFrom(resolved as unknown as Parameters<typeof spatialContextFrom>[0]);
  const fakeCrs: Pick<CrsService, 'current' | 'context' | 'crsRevision'> = {
    crsRevision: () => 0,
    current: () => resolved as unknown as ReturnType<CrsService['current']>,
    context: () => context,
  };
  return createTerrainAnalysisRunner({ getViewer: () => fakeViewer, getAnalysePanel: () => fakePanel, getActiveId: () => 'scan-1', crsService: fakeCrs, getScanFacts });
}

describe('terrainAnalysisRunner hands the facts to Contour Studio', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warnSpy.mockRestore());

  it('a strided static read is sampled, not streaming, and the DTM verdict names it', async () => {
    clearTerrainCoreCache();
    let frame: LaunchFrameContext | null = null;
    await runner((f) => { frame = f; }, () => facts('sampled')).run();
    const f = frame as unknown as LaunchFrameContext;
    expect(f.coverage).toBe('sampled');
    expect(f.streaming).toBe(false);
    expect(f.capabilities?.dtm?.readiness).toBe('review');
    expect(f.capabilities?.dtm?.reasonCode).toBe('SAMPLED');
    expect(f.capabilities?.contours?.readiness).toBe('review');
  });

  it('a full static read is ready on both products', async () => {
    clearTerrainCoreCache();
    let frame: LaunchFrameContext | null = null;
    await runner((f) => { frame = f; }, () => facts('full')).run();
    const f = frame as unknown as LaunchFrameContext;
    expect(f.coverage).toBe('full');
    expect(f.capabilities?.dtm?.readiness).toBe('ready');
  });

  it('a resident streaming set is streaming and resident-only', async () => {
    clearTerrainCoreCache();
    let frame: LaunchFrameContext | null = null;
    await runner((f) => { frame = f; }, () => facts('resident-only', 'streaming')).run();
    const f = frame as unknown as LaunchFrameContext;
    expect(f.coverage).toBe('resident-only');
    expect(f.streaming).toBe(true);
    expect(f.capabilities?.dtm?.reasonCode).toBe('RESIDENT_ONLY');
  });

  it('without facts the frame carries no verdicts', async () => {
    clearTerrainCoreCache();
    let frame: LaunchFrameContext | null = null;
    await runner((f) => { frame = f; }).run();
    const f = frame as unknown as LaunchFrameContext;
    expect(f.coverage).toBeUndefined();
    expect(f.capabilities).toBeUndefined();
  });
});
