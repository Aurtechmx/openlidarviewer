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
    picks: [] as Array<{ x: number; y: number; z: number } | null>,
    ortho: false,
    getCameraState: () => ({ position: camera.position, target: camera.target }),
    get orthographic() { return viewer.ortho; },
    derivedLayerHost: () => host,
    onDrawnFrame: (l: () => void) => { frameListeners.add(l); return () => frameListeners.delete(l); },
    pickPoint: () => viewer.picks.shift() ?? null,
    elevationExtent: () => ({ min: -2.5, max: 40 }),
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
    expect(v.settings.elevation).toBe(-2.5);
    expect(v.readout.join('\n')).toMatch(/Elevation: -2\.500 m \(lowest point in the scan, not ground\)/);
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

  it('fades lines per vertex: the colour alpha channel is written from the camera', () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.setElevation(0);
    const group = [...h.host.objects][0] as THREE.Group;
    const major = group.children.find((c) => c.name === 'olv-reference-plane-major') as THREE.LineSegments;
    const colour = major.geometry.getAttribute('color');
    expect(colour.itemSize).toBe(4);
    const alphas = Array.from({ length: colour.count }, (_, i) => colour.getW(i));
    expect(Math.max(...alphas)).toBeGreaterThan(0.5);
    expect(Math.min(...alphas)).toBe(0); // the patch edge
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

  it('with no shared datum it reads out scene coordinates and says so', () => {
    const h = harness({ datumResolved: false });
    h.controller.setEnabled(true);
    h.controller.beginPick('origin');
    h.viewer.picks.push({ x: 1, y: 2, z: 3 });
    click(h);
    expect(h.controller.view().settings.originH).toEqual([1, 2]);
    expect(h.controller.view().readout).toContain('The open layers share no datum, so these are scene coordinates.');
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
