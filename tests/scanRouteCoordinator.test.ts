/**
 * scanRouteCoordinator.test.ts
 *
 * The scan route over fake ports: detection routes the panels, a manual
 * override wins and pins, a streaming re-evaluation only rescues an interior
 * or object misread on a sparse frame, the settled one-shot spends only on a
 * landed verdict, and the run-terrain hatch fires for the explicit override
 * alone. The classifier is injected, so each case names its verdict outright.
 * Metrics run on a small real box of points. The routing service is the real
 * one over a bare context, with its timer replaced by a queue the test drains.
 * Nothing here touches a panel or the Viewer. A view spy per port method
 * records what the route asked for. Each case reads the last call it cares about.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createScanRouteCoordinator,
  treatAsDisabledFor,
  type RouteGeometry,
  type ScanRouteCoordinatorDeps,
  type ScanRouteViewPort,
} from '../src/app/scanRouteCoordinator';
import { createScanRouteService } from '../src/app/ScanRouteService';
import type { AppContext } from '../src/app/appContext';
import type { ScanShape, SpaceKind } from '../src/terrain/scanShape';

function box(n = 400): Float32Array {
  const p = new Float32Array(n * 3);
  let s = 7;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
  for (let i = 0; i < n; i++) {
    p[i * 3] = rnd() * 10;
    p[i * 3 + 1] = rnd() * 8;
    p[i * 3 + 2] = rnd() * 3;
  }
  return p;
}

const shapeFor = (verdict: SpaceKind): ScanShape =>
  ({
    nonTerrain: verdict !== 'terrain',
    spaceKind: verdict,
    up: 'z',
    aspect: 1,
    overhangFraction: 0,
    wallCoverage: 0,
    floorCoverage: 0,
    ceilingCoverage: 0,
    topVegFraction: 0,
  }) as unknown as ScanShape;

interface Harness {
  deps: ScanRouteCoordinatorDeps;
  view: { [K in keyof ScanRouteViewPort]: ReturnType<typeof vi.fn> };
  verdict: { value: SpaceKind | null };
  detect: { value: SpaceKind | null; throws?: boolean };
  geometry: { resident: number; gathered: RouteGeometry | null };
  frame: { unit: number; known: boolean };
  scheduled: Array<() => void>;
  log: string[];
}

function harness(over: Partial<{ detect: SpaceKind | null; unit: number; known: boolean; residentOnly: boolean; log: boolean }> = {}): Harness {
  const ctx = { scanRoute: { overridden: false, typeOverride: 'auto' } } as unknown as AppContext;
  const routing = createScanRouteService(ctx);
  const scheduled: Array<() => void> = [];
  routing.schedule = (run) => { scheduled.push(run); };
  routing.cancelScheduled = () => { scheduled.length = 0; };
  const verdict = { value: null as SpaceKind | null };
  const detect = { value: over.detect === undefined ? 'terrain' : over.detect, throws: false };
  const geometry = {
    resident: 1000,
    gathered: { positions: box(), residentOnly: over.residentOnly ?? false, totalPoints: 1000 } as RouteGeometry | null,
  };
  const frame = { unit: over.unit ?? 1, known: over.known ?? true };
  const view = {
    setObjectScanType: vi.fn(), setAnalyseScanType: vi.fn(), showSpace: vi.fn(), showObject: vi.fn(),
    setObjectVisible: vi.fn(), setAnalyseVisible: vi.fn(), setDockAnalyse: vi.fn(), expandAnalyseAndRunTerrain: vi.fn(),
  };
  const log: string[] = [];
  const deps: ScanRouteCoordinatorDeps = {
    routing,
    geometry: {
      gatherForRouting: () => geometry.gathered,
      residentPointTotal: () => geometry.resident,
      hasRgb: () => false,
    },
    frame: {
      linearUnitToMetres: () => frame.unit,
      linearUnitKnown: () => frame.known,
      exportTargetId: () => 'scan-1',
      crsRevision: () => 3,
      basename: () => 'tile',
    },
    verdict: { get: () => verdict.value, set: (v) => { verdict.value = v; } },
    view,
    log: over.log ? (line) => log.push(line) : undefined,
    classify: () => {
      if (detect.throws) throw new Error('classifier failed');
      if (detect.value === null) throw new Error('undecidable');
      return shapeFor(detect.value);
    },
  };
  return { deps, view, verdict, detect, geometry, frame, scheduled, log };
}

describe('scan route coordinator', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('terrain detected: Analyse shown, Object hidden, no terrain run', () => {
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(h.verdict.value).toBe('terrain');
    expect(h.view.setAnalyseVisible).toHaveBeenLastCalledWith(true);
    expect(h.view.setObjectVisible).toHaveBeenLastCalledWith(false);
    expect(h.view.setDockAnalyse).toHaveBeenLastCalledWith(true, true);
    expect(h.view.expandAnalyseAndRunTerrain).not.toHaveBeenCalled();
    expect(c.spaceExport()).toBeNull();
  });

  it('interior detected: space report shown, Terrain segment disabled with its reason', () => {
    h = harness({ detect: 'interior' });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(h.view.showSpace).toHaveBeenCalledTimes(1);
    expect(h.view.setObjectVisible).toHaveBeenLastCalledWith(true);
    expect(h.view.setAnalyseVisible).toHaveBeenLastCalledWith(false);
    const [override, effective, disabled, committed] = h.view.setAnalyseScanType.mock.calls.at(-1)![0];
    expect(override).toBe('auto');
    expect(effective).toBe('interior');
    expect(disabled?.terrain).toMatch(/reads as an interior/);
    expect(committed).toBe(true); // settled at open: soft-committed
    const ctx = c.spaceExport();
    expect(ctx?.spaceKind).toBe('interior');
    expect(ctx?.object).toBeNull();
    expect(ctx?.targetId).toBe('scan-1');
    expect(ctx?.basename).toBe('tile');
  });

  it('object detected: object metrics and a copied export context', () => {
    h = harness({ detect: 'object' });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(h.view.showObject).toHaveBeenCalledTimes(1);
    const ctx = c.spaceExport()!;
    expect(ctx.spaceKind).toBe('object');
    expect(ctx.object).not.toBeNull();
    expect(ctx.positions).not.toBe(h.geometry.gathered!.positions);
    expect(ctx.positions).toEqual(h.geometry.gathered!.positions);
  });

  it('unknown detection at open: Analyse stays available, nothing committed', () => {
    h = harness({ detect: null });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(h.verdict.value).toBeNull();
    expect(h.view.setAnalyseVisible).toHaveBeenLastCalledWith(true);
    expect(c.detectionCommitted()).toBe(false);
  });

  it('a throwing classifier is treated as undecided, never as a crash', () => {
    h.detect.throws = true;
    const c = createScanRouteCoordinator(h.deps);
    expect(() => c.beginScan(true)).not.toThrow();
    expect(h.view.setAnalyseVisible).toHaveBeenLastCalledWith(true);
  });

  it('manual terrain override on an interior: runs terrain and pins', () => {
    h = harness({ detect: 'interior' });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    c.setTypeOverride('terrain');
    expect(h.verdict.value).toBe('terrain');
    expect(h.view.expandAnalyseAndRunTerrain).toHaveBeenCalledTimes(1);
    expect(h.deps.routing.pinned).toBe(true);
    expect(c.detectionCommitted()).toBe(false);
    // Pinned: a streaming re-route is a no-op.
    h.geometry.resident = 1_000_000;
    c.onStreamingNodeReady();
    expect(h.scheduled).toHaveLength(0);
  });

  it('manual object and interior overrides route by themselves with no detection', () => {
    h = harness({ detect: null });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    c.setTypeOverride('object');
    expect(h.view.showObject).toHaveBeenCalledTimes(1);
    expect(h.verdict.value).toBe('object');
    c.setTypeOverride('interior');
    expect(h.view.showSpace).toHaveBeenCalledTimes(1);
    expect(h.verdict.value).toBe('interior');
  });

  it('a forced non-terrain route with no geometry keeps the panel alive, empty', () => {
    h = harness({ detect: null });
    h.geometry.gathered = null;
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    c.setTypeOverride('interior');
    expect(h.view.showSpace).toHaveBeenLastCalledWith(null, null);
    expect(h.view.setObjectVisible).toHaveBeenLastCalledWith(true);
    expect(c.spaceExport()).toBeNull();
  });

  it('streaming re-route: growth-gated and debounced, rescues an interior misread', () => {
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false); // sparse early frame read as terrain
    expect(h.verdict.value).toBe('terrain');
    h.geometry.resident = 1200; // below the growth factor
    c.onStreamingNodeReady();
    expect(h.scheduled).toHaveLength(0);
    h.geometry.resident = 2000;
    h.detect.value = 'interior';
    c.onStreamingNodeReady();
    expect(h.scheduled).toHaveLength(1);
    h.scheduled[0]();
    expect(h.verdict.value).toBe('interior');
    expect(h.view.showSpace).toHaveBeenCalledTimes(1);
  });

  it('a streaming re-route never flips the session TO terrain', () => {
    h = harness({ detect: 'interior' });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    h.detect.value = 'terrain';
    h.geometry.resident = 5000;
    c.onStreamingNodeReady();
    h.scheduled[0]();
    expect(h.verdict.value).toBe('interior');
  });

  it('settled one-shot: soft-commits the standing verdict once, then stays spent', () => {
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    expect(c.detectionCommitted()).toBe(false);
    const facts = { hierarchyDepth: 3, residentPointCount: 4000, residentAtDepth: () => true };
    c.onStreamingSettled(facts);
    expect(c.detectionCommitted()).toBe(true);
    const calls = h.view.setAnalyseScanType.mock.calls.length;
    c.onStreamingSettled({ ...facts, residentPointCount: 9000 });
    expect(h.view.setAnalyseScanType.mock.calls.length).toBe(calls);
  });

  it('settled poll waits for the depth gate', () => {
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    c.onStreamingSettled({ hierarchyDepth: 3, residentPointCount: 4000, residentAtDepth: () => false });
    expect(c.detectionCommitted()).toBe(false);
  });

  it('a refused settled verdict keeps the one-shot armed until the geometry changes', () => {
    h = harness({ detect: 'interior' });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    h.detect.value = 'terrain'; // a ceiling-heavy frame against a standing interior route: refused
    const facts = { hierarchyDepth: 2, residentPointCount: 4000, residentAtDepth: () => true };
    c.onStreamingSettled(facts);
    expect(c.detectionCommitted()).toBe(false);
    c.onStreamingSettled(facts); // same resident set: no retry
    h.detect.value = 'interior';
    c.onStreamingSettled({ ...facts, residentPointCount: 8000 });
    expect(c.detectionCommitted()).toBe(true);
  });

  it('an undecidable settled frame retries on the very next poll', () => {
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    h.detect.value = null;
    const facts = { hierarchyDepth: 2, residentPointCount: 4000, residentAtDepth: () => true };
    c.onStreamingSettled(facts);
    expect(c.detectionCommitted()).toBe(false);
    h.detect.value = 'terrain';
    c.onStreamingSettled(facts); // identical resident count, but the last frame was undecided
    expect(c.detectionCommitted()).toBe(true);
  });

  it('RGB and unit facts reach the metrics, and feet convert for the object measure', () => {
    h = harness({ detect: 'object', unit: 0.3048, known: true });
    h.deps = { ...h.deps, geometry: { ...h.deps.geometry, hasRgb: () => true } };
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    const ctx = c.spaceExport()!;
    expect(ctx.unitToMetres).toBeCloseTo(0.3048, 6);
    expect(ctx.unitKnown).toBe(true);
    const metres = createScanRouteCoordinator(harness({ detect: 'object', unit: 1, known: true }).deps);
    metres.beginScan(true);
    // Feet scaled to metres shrink the measured extent against the metre run.
    expect(ctx.object!.longestDimensionM).toBeLessThan(metres.spaceExport()!.object!.longestDimensionM);
    expect(ctx.object!.longestDimensionM).toBeCloseTo(metres.spaceExport()!.object!.longestDimensionM * 0.3048, 3);
  });

  it('an unknown unit is carried as unknown, never dressed as metres', () => {
    h = harness({ detect: 'interior', unit: 1, known: false });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(c.spaceExport()!.unitKnown).toBe(false);
  });

  it('a resident-only gather is recorded on the metrics', () => {
    h = harness({ detect: 'interior', residentOnly: true });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    expect(c.spaceExport()!.space.reasons.join(' ')).toMatch(/streamed-in/i);
  });

  it('reset forgets the scan: verdict, export context, pending re-route', () => {
    h = harness({ detect: 'object' });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(false);
    h.geometry.resident = 5000;
    c.onStreamingNodeReady();
    expect(h.scheduled).toHaveLength(1);
    c.reset();
    expect(h.scheduled).toHaveLength(0);
    expect(c.spaceExport()).toBeNull();
    expect(h.verdict.value).toBeNull();
    expect(h.deps.routing.typeOverride).toBe('auto');
  });

  it('the debug line names the verdict and the sample', () => {
    h = harness({ log: true });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(h.log[0]).toMatch(/^\[scan-type\] open verdict=terrain .* sampled=400 resident=1000$/);
  });

  it('treatAsDisabledFor names the detected kind and the hatch', () => {
    expect(treatAsDisabledFor('terrain')).toBeUndefined();
    expect(treatAsDisabledFor(null)).toBeUndefined();
    expect(treatAsDisabledFor('object')!.terrain).toMatch(/compact object.*Run terrain contours anyway/);
  });
});
