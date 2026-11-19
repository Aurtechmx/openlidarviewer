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
 * The last block pins that a CRS change on the routed scan gathers and
 * measures again under the new frame, as a reopen would, and only when the
 * frame's units or its horizontal reference moved.
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
import { settleTerrainGatherFrame, MIXED_FRAME_REASON, MIXED_GLTF_FRAME_REASON, UNPROVEN_FRAME_REASON } from '../src/terrain/gatherUpAxis';
import { spaceContextStillCurrent } from '../src/export/exportScanIdentity';
import { CrsService } from '../src/geo/CrsService';
import { routeUnitFrame } from '../src/app/scanRouteCoordinator';
import type { CrsInfo } from '../src/io/crs';

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
  frame: { unit: number; vert: number; known: boolean; horizontal: boolean; rev: number; target: string | null };
  scheduled: Array<() => void>;
  log: string[];
}

function harness(over: Partial<{ detect: SpaceKind | null; unit: number; vert: number; known: boolean; residentOnly: boolean; log: boolean }> = {}): Harness {
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
  const frame = { unit: over.unit ?? 1, vert: over.vert ?? over.unit ?? 1, known: over.known ?? true, horizontal: false, rev: 3, target: 'scan-1' as string | null };
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
      verticalUnitToMetres: () => frame.vert,
      linearUnitKnown: () => frame.known,
      horizontalCrs: () => frame.horizontal,
      exportTargetId: () => frame.target,
      crsRevision: () => frame.rev,
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

describe('the space or object report follows a CRS change on the routed scan', () => {
  const UNVERIFIED = 'Coordinate units are unverified';
  const lastObject = (h: Harness) => h.view.showObject.mock.calls.at(-1)! as [
    { obb: { lengthM: number } } | null,
    { linearUnit: { known: boolean }; reasons: string[] } | null,
    ScanShape | null,
  ];

  it('an object report moves from source units to metres and back with the CRS', () => {
    const h = harness({ detect: 'object', unit: 1, known: false });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(lastObject(h)[1]!.linearUnit.known).toBe(false);
    expect(lastObject(h)[1]!.reasons.join(' ')).toContain(UNVERIFIED);

    // A metre CRS is chosen in the Inspector.
    h.frame.known = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    expect(h.view.showObject).toHaveBeenCalledTimes(2);
    expect(lastObject(h)[1]!.linearUnit.known).toBe(true);
    expect(lastObject(h)[1]!.reasons.join(' ')).not.toContain(UNVERIFIED);
    expect(lastObject(h)[2]).not.toBeNull();
    expect(c.spaceExport()!.crsRevision).toBe(4);
    expect(c.spaceExport()!.unitKnown).toBe(true);

    // "Use detected" puts the unknown frame back.
    h.frame.known = false;
    h.frame.rev = 5;
    c.remeasureForFrame();
    expect(lastObject(h)[1]!.linearUnit.known).toBe(false);
    expect(lastObject(h)[1]!.reasons.join(' ')).toContain(UNVERIFIED);
    expect(c.spaceExport()!.crsRevision).toBe(5);
    expect(c.spaceExport()!.unitKnown).toBe(false);
  });

  it('the figures scale with the new unit, on a fresh routing gather', () => {
    const h = harness({ detect: 'object', unit: 1, known: true });
    const gather = vi.fn(() => h.geometry.gathered);
    h.deps = { ...h.deps, geometry: { ...h.deps.geometry, gatherForRouting: gather } };
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    const metres = c.spaceExport()!.object!.obb.lengthM;
    h.frame.unit = 0.3048;
    h.frame.vert = 0.3048;
    h.frame.rev = 4;
    c.remeasureForFrame();
    expect(gather).toHaveBeenCalledTimes(2);
    expect(gather).toHaveBeenLastCalledWith(60_000);
    expect(c.spaceExport()!.unitToMetres).toBeCloseTo(0.3048, 6);
    expect(c.spaceExport()!.object!.obb.lengthM).toBeCloseTo(metres * 0.3048, 3);
  });

  it('an interior report re-measures through showSpace', () => {
    const h = harness({ detect: 'interior', unit: 1, known: false });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    h.frame.known = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    expect(h.view.showSpace).toHaveBeenCalledTimes(2);
    expect((h.view.showSpace.mock.calls.at(-1)![0] as { linearUnit: { known: boolean } }).linearUnit.known).toBe(true);
    expect(h.view.showObject).not.toHaveBeenCalled();
  });

  it('a report for another scan, or one already measured under this frame, is left alone', () => {
    const h = harness({ detect: 'object', known: false });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    c.remeasureForFrame(); // same revision
    expect(h.view.showObject).toHaveBeenCalledTimes(1);
    h.frame.target = 'scan-2';
    h.frame.known = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    expect(h.view.showObject).toHaveBeenCalledTimes(1);
    expect(c.spaceExport()!.crsRevision).toBe(3);
  });

  it('a terrain route and a closed scan have no report to re-measure', () => {
    const h = harness({ detect: 'terrain' });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    h.frame.rev = 4;
    c.remeasureForFrame();
    expect(h.view.showObject).not.toHaveBeenCalled();
    expect(h.view.showSpace).not.toHaveBeenCalled();
    const o = harness({ detect: 'object' });
    const co = createScanRouteCoordinator(o.deps);
    co.beginScan(true);
    co.reset();
    o.frame.rev = 4;
    co.remeasureForFrame();
    expect(o.view.showObject).toHaveBeenCalledTimes(1);
  });

  // The viewer's gather settles the up axis from the format and the resolved
  // CRS (gatherUpAxis.ts), so the harness gathers through that same rule.
  const UTM = { kind: 'projected', epsg: 32612, name: 'WGS 84 / UTM zone 12N', linearUnit: 'metre', linearUnitToMetres: 1 } as never;
  /** A 6 x 8 m room, 3 m high, stored Y-up: floor and ceiling are planes in Y. */
  function yUpRoom(W = 6, D = 8, H = 3, step = 0.25): Float32Array {
    const t: number[] = [];
    const push = (x: number, up: number, z: number): void => { t.push(x, up, z); };
    for (let x = 0; x <= W; x += step) for (let z = 0; z <= D; z += step) { push(x, 0, z); push(x, H, z); }
    for (let u = 0; u <= H; u += step) for (let x = 0; x <= W; x += step) { push(x, u, 0); push(x, u, D); }
    for (let u = 0; u <= H; u += step) for (let z = 0; z <= D; z += step) { push(0, u, z); push(W, u, z); }
    return Float32Array.from(t);
  }
  function gatherAs(h: Harness, format: 'glb' | 'ply'): void {
    const stored = yUpRoom();
    let decline: string | null = null;
    h.deps = {
      ...h.deps,
      geometry: {
        ...h.deps.geometry,
        gatherForRouting: () => {
          const p = Float32Array.from(stored);
          const f = settleTerrainGatherFrame([{ format, crs: h.frame.horizontal ? UTM : null, layerPoints: p }], false, p);
          decline = f && !f.ok ? f.reason : null;
          return f?.ok ? { positions: p, residentOnly: false, totalPoints: p.length / 3 } : null;
        },
        declineReason: () => decline,
      },
    };
  }

  it('a glTF that the gather declines under the new CRS shows the empty report and no export', () => {
    const h = harness({ detect: 'object', known: false });
    gatherAs(h, 'glb');
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    expect(c.spaceExport()).not.toBeNull();

    h.frame.known = true;
    h.frame.horizontal = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    expect(h.view.showObject.mock.calls.at(-1)!.slice(0, 3)).toEqual([null, null, null]);
    expect(c.spaceExport()).toBeNull();

    // "Use detected" brings the figures back.
    h.frame.known = false;
    h.frame.horizontal = false;
    h.frame.rev = 5;
    c.remeasureForFrame();
    expect(lastObject(h)[0]).not.toBeNull();
    expect(c.spaceExport()!.crsRevision).toBe(5);
  });

  it('a PLY whose up axis depends on the CRS measures as a reopen under that CRS would', () => {
    const h = harness({ detect: 'interior', known: false });
    gatherAs(h, 'ply');
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    const before = c.spaceExport()!.space.dims;

    h.frame.known = true;
    h.frame.horizontal = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    const reopened = createScanRouteCoordinator(h.deps);
    reopened.beginScan(true);
    const after = c.spaceExport()!.space.dims;
    expect(after).toEqual(reopened.spaceExport()!.space.dims);
    // Rotated before, read as stored now: the height is a different axis.
    expect(after.heightM).not.toBeCloseTo(before.heightM, 3);
  });

  it('the same units and horizontal frame only restamp the export, with no new render', () => {
    const h = harness({ detect: 'object', known: true });
    const gather = vi.fn(() => h.geometry.gathered);
    h.deps = { ...h.deps, geometry: { ...h.deps.geometry, gatherForRouting: gather } };
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    const first = c.spaceExport()!;
    // A layer round trip: another layer, then this one again, each a new revision.
    h.frame.target = 'scan-2';
    h.frame.rev = 4;
    c.remeasureForFrame();
    h.frame.target = 'scan-1';
    h.frame.rev = 5;
    c.remeasureForFrame();
    expect(h.view.showObject).toHaveBeenCalledTimes(1);
    expect(gather).toHaveBeenCalledTimes(1);
    expect(c.spaceExport()!.crsRevision).toBe(5);
    expect(c.spaceExport()!.object).toBe(first.object);
  });

  it('a geographic pick keeps the unit factors but changes the horizontal frame, so it re-measures', () => {
    const h = harness({ detect: 'object', known: false });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    h.frame.horizontal = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    expect(h.view.showObject).toHaveBeenCalledTimes(2);
  });

  it('an export captured before the change is refused; the panel and the new context share one measurement', () => {
    const h = harness({ detect: 'object', known: false });
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    const captured = c.spaceExport()!;
    h.frame.known = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    const live = { targetId: h.frame.target, crsRevision: h.frame.rev };
    expect(spaceContextStillCurrent(captured, live)).toBe(false);
    expect(spaceContextStillCurrent(c.spaceExport()!, live)).toBe(true);
    expect(lastObject(h)[0]).toBe(c.spaceExport()!.object);
    expect(lastObject(h)[1]).toBe(c.spaceExport()!.space);
  });

  it('a declined gather states its reason on the empty report, without the terrain wording', () => {
    const h = harness({ detect: 'object', known: false });
    gatherAs(h, 'glb');
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    h.frame.known = true;
    h.frame.horizontal = true;
    h.frame.rev = 4;
    c.remeasureForFrame();
    const [object, space, shape, reason] = h.view.showObject.mock.calls.at(-1)!;
    expect([object, space, shape]).toEqual([null, null, null]);
    expect(reason).toMatch(/^glTF stores Y as the up axis by specification/);
    expect(reason).not.toMatch(/Terrain analysis/);
  });

  it('a forced object route whose gather declines states the reason too', () => {
    const h = harness({ detect: null });
    h.geometry.gathered = null;
    h.deps = { ...h.deps, geometry: { ...h.deps.geometry, declineReason: () => 'Terrain analysis did not run. The axes disagree.' } };
    const c = createScanRouteCoordinator(h.deps);
    c.beginScan(true);
    c.setTypeOverride('object');
    expect(h.view.showObject).toHaveBeenLastCalledWith(null, null, null, 'The axes disagree.');
  });

  it('a WKT-only CRS the gather treats as horizontal is re-measured after Local, then "Use detected"', () => {
    // The file declares a WKT whose horizontal part did not resolve: its kind
    // is unknown, but the gather still reads it as a horizontal reference.
    const declared: CrsInfo = {
      source: 'wkt', wkt: 'COMPD_CS["custom"]', name: 'custom', linearUnit: 'unknown', linearUnitToMetres: 1,
      isGeographic: false, horizontalUnresolved: true,
    } as CrsInfo;
    const store = new Map<string, never>();
    const service = new CrsService({
      get: (k) => store.get(k),
      set: (k, o) => { store.set(k, { ...o, updatedAt: 1 } as never); },
      clear: (k) => { store.delete(k); },
    });
    service.resolveForScan({ name: 'room.ply', detected: declared, source: 'las-vlr' });
    expect(service.current()?.kind).toBe('unknown');
    const stored = yUpRoom();
    const gather = vi.fn(() => {
      const p = Float32Array.from(stored);
      const f = settleTerrainGatherFrame([{ format: 'ply', crs: service.current(), layerPoints: p }], false, p);
      return f?.ok ? { positions: p, residentOnly: false, totalPoints: p.length / 3 } : null;
    });
    const h = harness({ detect: 'interior' });
    const deps = {
      ...h.deps,
      geometry: { ...h.deps.geometry, gatherForRouting: gather },
      frame: { ...h.deps.frame, ...routeUnitFrame(() => service.context(), () => service.current()), crsRevision: () => service.crsRevision() },
    };
    const c = createScanRouteCoordinator(deps);
    c.beginScan(true);
    const asDeclared = c.spaceExport()!.space.dims;

    service.setOverride({ override: { epsg: null, kind: 'local' }, detected: declared, source: 'las-vlr' });
    c.remeasureForFrame();
    expect(c.spaceExport()!.space.dims).not.toEqual(asDeclared); // rotated by its point layout

    service.setOverride({ override: { epsg: null, kind: 'detected' }, detected: declared, source: 'las-vlr' });
    c.remeasureForFrame();
    expect(gather).toHaveBeenCalledTimes(3);
    expect(c.spaceExport()!.space.dims).toEqual(asDeclared);
  });

  describe('a mixed-layer decline is worded for the report, not for terrain analysis', () => {
    const cases = [
      ['a local mesh beside Z-up layers', MIXED_FRAME_REASON,
        'A mesh layer with no coordinate system reads as Y-up from its point layout, and the other visible layers are Z-up, so they are not in one frame. Hide or lock one side, then choose an option under "Treat scan as" again.'],
      ['a glTF beside Z-up layers', MIXED_GLTF_FRAME_REASON,
        'A glTF or GLB layer is Y-up by specification, and the other visible layers are Z-up, so they are not in one frame. Hide or lock one side, then choose an option under "Treat scan as" again.'],
      ['layers with no proven shared frame', UNPROVEN_FRAME_REASON,
        'The visible layers have not proven they share a frame, so they are not measured together. Hide or lock all but one layer, then choose an option under "Treat scan as" again.'],
    ] as const;

    for (const [name, reason, cause] of cases) {
      it(`${name}: the report states its own cause, and choosing a type again re-gathers`, () => {
        const h = harness({ detect: null });
        h.geometry.gathered = null;
        h.deps = { ...h.deps, geometry: { ...h.deps.geometry, declineReason: () => (h.geometry.gathered ? null : reason) } };
        const c = createScanRouteCoordinator(h.deps);
        c.beginScan(true);
        c.setTypeOverride('object');
        expect(h.view.showObject).toHaveBeenLastCalledWith(null, null, null, cause);
        // The other side is hidden: choosing the type again gathers afresh.
        h.geometry.gathered = { positions: box(), residentOnly: false, totalPoints: 400 };
        h.detect.value = 'object';
        c.setTypeOverride('object');
        expect(lastObject(h)[0]).not.toBeNull();
        expect(c.spaceExport()).not.toBeNull();
      });
    }

    it('the Analyse panel keeps its terrain wording', () => {
      expect(MIXED_FRAME_REASON).toBe(
        'Terrain analysis did not run. A mesh layer with no coordinate system reads as Y-up from its point layout, and the other visible layers are Z-up, so together they describe no single surface. Hide or lock one side, then run.');
      expect(MIXED_GLTF_FRAME_REASON).toBe(
        'Terrain analysis did not run. A glTF or GLB layer is Y-up by specification, and the other visible layers are Z-up, so together they describe no single surface. Hide or lock one side, then run.');
    });
  });
});
