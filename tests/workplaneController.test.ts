import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { createWorkplaneController, type WorkplaneCanvas, type WorkplaneViewer, type WorkplaneView } from '../src/app/workplaneController';
import { WorkplaneOverlay } from '../src/render/workplane/WorkplaneOverlay';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { isLightColour } from '../src/app/workplaneMount';

/** A scene host that records membership, as `derivedLayerHost()` would. */
function fakeHost() {
  const objects = new Set<THREE.Object3D>();
  return { objects, add: (o: THREE.Object3D) => objects.add(o), remove: (o: THREE.Object3D) => objects.delete(o), requestFrame: vi.fn() };
}

type Listener = (e: PointerEvent) => void;
function fakeCanvas(): WorkplaneCanvas & { fire(type: 'pointerdown' | 'pointerup', x: number, y: number): void; listeners: Map<string, Set<Listener>> } {
  const listeners = new Map<string, Set<Listener>>();
  return {
    clientWidth: 1000,
    clientHeight: 800,
    listeners,
    addEventListener: (t, l) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(l); },
    removeEventListener: (t, l) => { listeners.get(t)?.delete(l); },
    fire(type, x, y) { for (const l of listeners.get(type) ?? []) l({ button: 0, offsetX: x, offsetY: y } as PointerEvent); },
  };
}

interface Harness {
  readonly viewer: WorkplaneViewer & { frame(): void; picks: Array<{ x: number; y: number; z: number } | null>; ortho: boolean };
  readonly canvas: ReturnType<typeof fakeCanvas>;
  readonly host: ReturnType<typeof fakeHost>;
  readonly views: WorkplaneView[];
  readonly controller: ReturnType<typeof createWorkplaneController>;
}

function harness(opts: { datum?: [number, number, number]; datumResolved?: boolean } = {}): Harness {
  const host = fakeHost();
  const frameListeners = new Set<() => void>();
  const camera = { position: [30, -60, 80] as [number, number, number], target: [30, 30, 0] as [number, number, number] };
  const viewer = {
    cam: camera,
    picks: [] as Array<{ x: number; y: number; z: number } | null>,
    ortho: false,
    getCameraState: () => ({ position: camera.position, target: camera.target }),
    get orthographic() { return viewer.ortho; },
    derivedLayerHost: () => host,
    onDrawnFrame: (l: () => void) => { frameListeners.add(l); return () => frameListeners.delete(l); },
    pickPoint: () => viewer.picks.shift() ?? null,
    mergedVisibleBounds: () => [0, 0, -2.5, 60, 60, 40],
    measure: { worldUp: [0, 0, 1], datumResolved: opts.datumResolved ?? true },
    clouds: () => ['scan'],
    hasStreamingCloud: false,
    frame: () => { for (const l of [...frameListeners]) l(); },
  };
  const canvas = fakeCanvas();
  const views: WorkplaneView[] = [];
  const controller = createWorkplaneController({
    viewer: () => viewer,
    canvas,
    context: () => spatialContextFrom({ source: 'wkt', name: 'UTM', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false }),
    sceneOrigin: () => opts.datum ?? [500000, 4100000, 1000],
    makeDrawing: (h) => new WorkplaneOverlay(h),
    lightBackdrop: () => false,
    onChange: (v) => views.push(v),
  });
  return { viewer, canvas, host, views, controller };
}

const click = (h: Harness, x = 500, y = 400): void => {
  h.canvas.fire('pointerdown', x, y);
  h.canvas.fire('pointerup', x, y);
};

describe('reference plane controller', () => {
  it('is off by default and holds no GPU resources', () => {
    const h = harness();
    expect(h.controller.view().settings.enabled).toBe(false);
    expect(h.controller.view().liveResources).toBe(0);
    expect(h.host.objects.size).toBe(0);
  });

  it('turned on without an elevation, it draws nothing and says what to do', () => {
    const h = harness();
    h.controller.setEnabled(true);
    expect(h.controller.view().drawn).toBe(false);
    expect(h.controller.view().status).toMatch(/Set an elevation/);
    expect(h.host.objects.size).toBe(0);
  });

  it('"use scan minimum" places it at the lowest point and labels that as not ground', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.useScanMinimum();
    const v = h.controller.view();
    expect(v.drawn).toBe(true);
    // The lowest point over every visible layer: scene minimum -2.5 plus the datum's 1000.
    expect(v.settings.elevation).toBe(997.5);
    expect(v.readout.join('\n')).toMatch(/Elevation: 997\.500\u00a0m \(lowest point in the scan, not ground\)/);
    expect(v.readout.join('\n')).toMatch(/Grid \d/);
    expect(h.host.objects.size).toBe(1);
    expect(v.liveResources).toBeGreaterThan(0);
  });

  it('turning it off releases every geometry and material', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(12);
    const group = [...h.host.objects][0] as THREE.Group;
    const disposed: string[] = [];
    group.traverse((o) => {
      if (o instanceof THREE.LineSegments) {
        o.geometry.addEventListener('dispose', () => disposed.push('geometry'));
        (o.material as THREE.Material).addEventListener('dispose', () => disposed.push('material'));
      }
    });
    h.controller.setEnabled(false);
    expect(h.host.objects.size).toBe(0);
    expect(h.controller.view().liveResources).toBe(0);
    expect(disposed.filter((d) => d === 'material')).toHaveLength(3);
    expect(disposed.filter((d) => d === 'geometry').length).toBeGreaterThanOrEqual(3);
  });

  it('reset (scan closed) and dispose (app lifetime) release it too', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(1);
    h.controller.reset();
    expect(h.host.objects.size).toBe(0);
    expect(h.controller.view().settings.enabled).toBe(false);
    h.controller.setEnabled(true);
    h.controller.setElevation(1);
    h.controller.dispose();
    expect(h.host.objects.size).toBe(0);
  });

  it('defaults the horizontal origin to the scan centre rounded to the grid, and says so', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    const v = h.controller.view();
    const major = Number(/Grid ([\d.]+)/.exec(v.readout.join('\n'))![1]);
    expect(v.settings.originH).toBeNull();
    expect(v.originH).toEqual([Math.round(500030 / major) * major, Math.round(4100030 / major) * major]);
    expect(v.readout[1]).toMatch(/\(scan centre, rounded to grid\)$/);
    // The rounded origin is on the lattice, so the axis lines are drawn in the patch.
    const group = [...h.host.objects][0] as THREE.Group;
    const axes = group.children.find((c) => c.name === 'olv-reference-plane-axes') as THREE.LineSegments;
    expect(axes.geometry.getAttribute('position').count).toBeGreaterThan(0);
    // A typed origin replaces it; "Use scan centre" brings it back.
    h.controller.setOriginH(500001, 4100002);
    expect(h.controller.view().readout[1]).not.toMatch(/scan centre/);
    h.controller.useScanCentre();
    expect(h.controller.view().settings.originH).toBeNull();
  });

  it('fades lines per vertex through a one-float fade attribute', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    const group = [...h.host.objects][0] as THREE.Group;
    const major = group.children.find((c) => c.name === 'olv-reference-plane-major') as THREE.LineSegments;
    const fade = major.geometry.getAttribute('fade');
    expect(fade.itemSize).toBe(1);
    const alphas = Array.from(fade.array as Float32Array);
    expect(Math.max(...alphas)).toBeGreaterThan(0.5);
    expect(Math.min(...alphas)).toBe(0); // the patch edge
    // A camera move rewrites the same buffer in place: no new array.
    const before = fade.array;
    (h.viewer as unknown as { cam: { position: number[] } }).cam.position[0] += 3;
    h.viewer.frame();
    expect(major.geometry.getAttribute('fade').array).toBe(before);
  });

  it('a picked point sets origin and elevation in source coordinates (scene + datum)', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.beginPick('origin');
    h.viewer.picks.push({ x: 10.25, y: 20.5, z: 234.5 });
    click(h);
    const s = h.controller.view().settings;
    expect(s.originH).toEqual([500010.25, 4100020.5]);
    expect(s.elevation).toBe(1234.5);
    expect(s.elevationSource).toBe('picked');
    expect(h.canvas.listeners.get('pointerup')?.size ?? 0).toBe(0); // picking ended
  });

  it('a drag is an orbit, not a pick', () => {
    const h = harness();
    h.controller.beginPick('origin');
    h.viewer.picks.push({ x: 1, y: 2, z: 3 });
    h.canvas.fire('pointerdown', 100, 100);
    h.canvas.fire('pointerup', 160, 100);
    expect(h.controller.view().settings.elevation).toBeNull();
    expect(h.controller.view().picking).toBe('origin');
  });

  it('three picks set a plane through them; collinear picks are refused and change nothing', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(5);
    h.controller.beginPick('three-point');
    h.viewer.picks.push({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }, { x: 20, y: 20, z: 20 });
    click(h); click(h); click(h);
    let v = h.controller.view();
    expect(v.settings.orientation).toBe('horizontal');
    expect(v.status).toMatch(/in a line.*not changed/);

    h.controller.beginPick('three-point');
    h.viewer.picks.push({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 4 }, { x: 0, y: 40, z: -2 });
    click(h);
    expect(h.controller.view().status).toMatch(/second point/);
    click(h); click(h);
    v = h.controller.view();
    expect(v.settings.orientation).toBe('three-point');
    expect(v.settings.points?.[1]).toEqual([500040, 4100000, 1004]);
    expect(v.readout[0]).toMatch(/Through 3 picked points, dip \d/);
    expect(v.drawn).toBe(true);
  });

  it('works in perspective, orthographic and Plan (orthographic, top down)', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    expect(h.controller.view().drawn).toBe(true);
    h.viewer.ortho = true;
    h.controller.reframe();
    expect(h.controller.view().drawn).toBe(true);
    expect(h.controller.view().readout.join(' ')).toMatch(/Grid \d+(\.\d+)? m/);
  });

  it('a camera move that keeps the spacing in band does not rebuild the buffers', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    const before = h.views.length;
    h.viewer.frame();
    h.viewer.frame();
    expect(h.views.length).toBe(before);
  });

  it('hides for an image export and states itself in a snapshot only while drawn', async () => {
    const h = harness();
    expect(h.controller.figureNote()).toBeNull();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    expect(h.controller.figureNote()).toMatch(/^Reference plane, not measured terrain\./);
    const group = [...h.host.objects][0] as THREE.Group;
    const seen = await h.controller.without(async () => group.visible);
    expect(seen).toBe(false);
    expect(group.visible).toBe(true);
  });

  it('with no shared datum it draws nothing, refuses picks and the scan minimum, and says why', () => {
    const h = harness({ datumResolved: false });
    h.controller.setEnabled(true);
    h.controller.setElevation(5);
    expect(h.controller.view().drawn).toBe(false);
    expect(h.host.objects.size).toBe(0);
    expect(h.controller.view().status).toMatch(/do not share a datum/);
    h.controller.beginPick('origin');
    expect(h.controller.view().picking).toBeNull();
    h.controller.useScanMinimum();
    expect(h.controller.view().settings.elevation).toBe(5); // unchanged, never reinterpreted
  });

});

describe('backdrop', () => {
  it('reads a light sky as light and the dark skies as dark', () => {
    expect(isLightColour('rgb(235, 226, 210)')).toBe(true);
    expect(isLightColour('#ebe2d2')).toBe(true);
    expect(isLightColour('rgb(7, 11, 22)')).toBe(false);
    expect(isLightColour('')).toBe(false);
  });
});

describe('image exports never carry the plane', () => {
  it('exportImageAction renders inside withoutReferencePlane', async () => {
    const { exportImageAction } = await import('../src/app/exportImageAction');
    const order: string[] = [];
    const viewer = { getCloud: () => ({ name: 'scan.las' }), streamingCloud: null, exportImage: async () => { order.push('render'); return { blob: new Blob(['x']) }; } };
    await exportImageAction('height-map', {
      getViewer: () => viewer as never,
      getProgress: () => ({ setProgress: () => {}, setError: () => {} }),
      scans: { activeId: 'a', activeExportTargetId: () => 'a' },
      baseName: (n) => n,
      currentClassScopeStamp: () => '',
      withoutReferencePlane: async (render) => { order.push('hide'); const r = await render(); order.push('show'); return r; },
    });
    expect(order.slice(0, 3)).toEqual(['hide', 'render', 'show']);
  });
});

describe('picking and other tools', () => {
  it('does not start a pick while another tool owns canvas clicks', () => {
    const h = harness();
    (h.viewer as unknown as { toolActive: boolean }).toolActive = true;
    h.controller.beginPick('origin');
    expect(h.controller.view().picking).toBeNull();
    expect(h.controller.view().status).toMatch(/Another tool/);
  });
});

describe('hostile settings never hang the controller', () => {
  it('a recovery-journal reload with a bad block finishes at once and draws nothing out of range', async () => {
    const { parseSession, serializeSession } = await import('../src/io/session');
    // The recovery journal stores a Save-session JSON and restores it through parseSession.
    const doc = JSON.parse(serializeSession({ upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], measurements: [], annotations: [] })) as Record<string, unknown>;
    doc.referencePlane = { enabled: true, orientation: 'horizontal', originH: [1e17, 1e17], elevation: 0, fixedSpacing: 1e-20 };
    const settings = parseSession(JSON.stringify(doc)).referencePlane!;
    const h = harness();
    const t0 = performance.now();
    h.controller.restore(settings);
    for (let i = 0; i < 5; i++) h.viewer.frame();
    expect(performance.now() - t0).toBeLessThan(500);
    const v = h.controller.view();
    // The fixed spacing is floored to 1e-6 of the scan size and says so.
    expect(v.readout.join(' ')).toMatch(/raised to the floor of 1e-6 of the scan size/);
  });

  it('restore re-checks a block that did not come through the parser', () => {
    const h = harness();
    const t0 = performance.now();
    h.controller.restore({ ...h.controller.view().settings, enabled: true, originH: [1e17, 1e17], elevation: 1e17, fixedSpacing: 10 });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(h.controller.view().settings.originH).toBeNull();
    expect(h.controller.view().settings.elevation).toBeNull();
  });

  it('an origin in range but too far for the spacing is not drawn, and says why', () => {
    const h = harness();
    // A 1 cm scan: the spacing floor (1e-6 of the scan size) is 1e-8, so an
    // origin 9e8 away puts the lattice index near 1e17, past exact integers.
    (h.viewer as unknown as { mergedVisibleBounds: () => number[] }).mergedVisibleBounds = () => [0, 0, 0, 0.01, 0.01, 0.01];
    h.controller.setEnabled(true);
    h.controller.setFixedSpacing(1e-7);
    h.controller.setOriginH(9e8, 9e8);
    h.controller.setElevation(0);
    const v = h.controller.view();
    expect(v.drawn).toBe(false);
    expect(v.status).toMatch(/too far from the scan for this spacing/);
  });

  it('the panel setters refuse out-of-range values', () => {
    const h = harness();
    h.controller.setOriginH(1e17, 0);
    expect(h.controller.view().status).toMatch(/between/);
    h.controller.setElevation(-1e12);
    expect(h.controller.view().settings.elevation).toBeNull();
  });

  it('nested exports keep the plane hidden until the last one ends', async () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    const group = [...h.host.objects][0] as THREE.Group;
    let release!: () => void;
    const first = h.controller.without(() => new Promise<void>((r) => { release = r; }));
    await h.controller.without(async () => { expect(group.visible).toBe(false); });
    expect(group.visible).toBe(false); // the first export is still running
    release();
    await first;
    expect(group.visible).toBe(true);
  });

  it('a saved collinear triple draws nothing and says why', () => {
    const h = harness();
    h.controller.restore({ ...h.controller.view().settings, enabled: true, orientation: 'three-point', points: [[500000, 4100000, 1000], [500010, 4100010, 1010], [500020, 4100020, 1020]] });
    expect(h.controller.view().drawn).toBe(false);
    expect(h.controller.view().status).toMatch(/in a line/);
  });

  it('the snapshot note keeps every readout line, caveats included', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    const v = h.controller.view();
    expect(h.controller.figureNote()).toBe(`Reference plane, not measured terrain. ${v.readout.join('; ')}`);
  });

  it('three-point mode reports the plane elevation at the origin in both the field and the readout', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.beginPick('three-point');
    h.viewer.picks.push({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 4 }, { x: 0, y: 40, z: -2 });
    click(h); click(h); click(h);
    h.controller.useScanCentre();
    const v = h.controller.view();
    expect(v.readout[2]).toContain(v.elevation!.toFixed(3));
  });
});

describe('a layer still placed in the project frame (tile B after closing tile A)', () => {
  // Tiles A and B were mounted: the project origin is A's file origin OA, and
  // B is placed with sourceToProject = OB - OA. A is closed; B stays placed.
  const OA: [number, number, number] = [500000, 4100000, 100];
  const OB: [number, number, number] = [500900, 4100400, 120];
  // B's points span 30 m in source coordinates from OB; its scene coordinates
  // are source - OA, the frame the placed mesh is drawn in.
  const sceneBounds = [OB[0] - OA[0], OB[1] - OA[1], OB[2] - OA[2], OB[0] - OA[0] + 30, OB[1] - OA[1] + 30, OB[2] - OA[2] + 5];

  async function placedHarness(useRawSourceOrigin: boolean) {
    const { sessionImportOrigins } = await import('../src/app/projectFrame');
    const origins = sessionImportOrigins({
      frame: () => ({ projectOrigin: OA }),
      activeId: () => 'B',
      viewerIds: () => ['B'],
      stableIdFor: () => 'layer-b',
      cloud: () => ({ sourceOrigin: OB }),
      placement: () => ({ vertical: true }),
      fallback: () => [0, 0, 0],
    });
    const host = fakeHost();
    const viewer = {
      getCameraState: () => ({ position: [915, 415, 200] as [number, number, number], target: [915, 415, 20] as [number, number, number] }),
      orthographic: false,
      derivedLayerHost: () => host,
      onDrawnFrame: () => () => {},
      pickPoint: () => null,
      mergedVisibleBounds: () => sceneBounds,
      measure: { worldUp: [0, 0, 1], datumResolved: true }, // one layer left: its origin is unanimous
      clouds: () => ['B'],
      hasStreamingCloud: false,
    };
    const views: WorkplaneView[] = [];
    const controller = createWorkplaneController({
      viewer: () => viewer,
      canvas: fakeCanvas(),
      context: () => spatialContextFrom({ source: 'wkt', name: 'UTM', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false }),
      // The fix: the placement-aware origin session import uses. The defect: B's raw file origin.
      sceneOrigin: useRawSourceOrigin ? () => OB : origins.exportOrigin,
      makeDrawing: (h) => new WorkplaneOverlay(h),
      lightBackdrop: () => false,
      onChange: (v) => views.push(v),
    });
    return { controller, host };
  }

  it('the placement-aware origin is the project origin, not the file origin', async () => {
    const { sessionImportOrigins } = await import('../src/app/projectFrame');
    const o = sessionImportOrigins({ frame: () => ({ projectOrigin: OA }), activeId: () => 'B', viewerIds: () => ['B'], stableIdFor: () => 'b', cloud: () => ({ sourceOrigin: OB }), placement: () => ({ vertical: true }), fallback: () => [0, 0, 0] });
    expect(o.exportOrigin()).toEqual(OA);
  });

  for (const raw of [false, true]) {
    it(raw ? 'with the raw file origin (the defect) a typed elevation lands OB - OA off' : 'a typed elevation and the readout are in B\'s true source coordinates', async () => {
      const { controller, host } = await placedHarness(raw);
      controller.setEnabled(true);
      controller.setElevation(123.25);
      const group = [...host.objects][0] as THREE.Group;
      // Where the grid really is, in source coordinates: scene + OA.
      const drawnZ = group.position.z + OA[2];
      const v = controller.view();
      const major = Number(/Grid ([\d.]+)/.exec(v.readout.join(' '))![1]);
      const centreX = Math.round((OB[0] + 15) / major) * major;
      if (raw) {
        expect(Math.abs(drawnZ - 123.25)).toBeCloseTo(Math.abs(OB[2] - OA[2]), 6);
        expect(v.originH![0]).not.toBeCloseTo(centreX, 0);
      } else {
        expect(drawnZ).toBeCloseTo(123.25, 9);
        expect(v.originH![0]).toBeCloseTo(centreX, 9); // the scan centre of B, in source coordinates
        expect(v.readout[1]).toContain(centreX.toFixed(3));
        expect(controller.figureNote()).toContain(`Elevation: 123.250`);
        expect(controller.figureNote()).toContain(centreX.toFixed(3));
      }
    });
  }
});

describe('more refusals', () => {
  it('a three-point pick out of range is refused, not kept in memory', () => {
    const h = harness({ datum: [0, 0, 0] });
    h.controller.setEnabled(true);
    h.controller.beginPick('three-point');
    h.viewer.picks.push({ x: 2e9, y: 0, z: 0 });
    click(h);
    expect(h.controller.view().status).toMatch(/out of range/);
    expect(h.controller.view().settings.points).toBeNull();
  });

  it('a scan minimum out of range is refused', () => {
    const h = harness({ datum: [0, 0, -5e9] });
    h.controller.setEnabled(true);
    h.controller.useScanMinimum();
    expect(h.controller.view().status).toMatch(/out of range/);
    expect(h.controller.view().settings.elevation).toBeNull();
  });

  it('a tool turned on mid-pick takes the click, and the pick stops', () => {
    const h = harness();
    h.controller.beginPick('origin');
    (h.viewer as unknown as { toolActive: boolean }).toolActive = true;
    h.viewer.picks.push({ x: 1, y: 2, z: 3 });
    click(h);
    expect(h.controller.view().settings.elevation).toBeNull();
    expect(h.controller.view().picking).toBeNull();
    expect(h.controller.view().status).toMatch(/another tool/);
  });
});

describe('idle frames', () => {
  it('an idle frame does no rebuild; a camera move does', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(12);
    h.viewer.frame();
    const backdrop = vi.spyOn(WorkplaneOverlay.prototype, 'setBackdrop');
    const update = vi.spyOn(WorkplaneOverlay.prototype, 'update');
    try {
      for (let i = 0; i < 5; i++) h.viewer.frame();
      expect(backdrop).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      (h.viewer as unknown as { cam: { position: number[] } }).cam.position = [30, -90, 120];
      h.viewer.frame();
      expect(backdrop).toHaveBeenCalledTimes(1);
      // The bounds growing (a streaming layer) is not an idle frame either.
      backdrop.mockClear();
      (h.viewer as unknown as { mergedVisibleBounds: () => number[] }).mergedVisibleBounds = () => [0, 0, -2.5, 80, 60, 40];
      h.viewer.frame();
      expect(backdrop).toHaveBeenCalledTimes(1);
    } finally {
      backdrop.mockRestore();
      update.mockRestore();
    }
  });
});
