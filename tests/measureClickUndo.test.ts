/**
 * measureClickUndo.test.ts
 *
 * The measuring clicks and the delete Undo, on the real MeasureController
 * through the recording DOM stub the other controller tests use:
 *   - a click that ended a drag (an orbit) places nothing;
 *   - a click on an existing vertex handle places a point on that vertex, and a
 *     press that moves still drags the vertex;
 *   - a deleted measurement comes back with its id, name, owner and place;
 *   - a box whose corners sit at one height says why its volume is 0.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Vec3 } from '../src/render/navMath';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ ns: true });
  // The handle press listens for its release on window.
  (globalThis as { window?: unknown }).window ??= { addEventListener: () => {}, removeEventListener: () => {} };
});

interface Internals {
  _lastCanvas: unknown;
  _handlePointerDown(e: unknown): void;
  _handleDragMove(e: unknown): void;
  _endDrag(e?: unknown): void;
  _draft: { points: Vec3[] } | null;
}

async function makeController() {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  const picks: Vec3[] = [];
  let layer: unknown;
  measure.setPicker((x, y) => {
    const p: Vec3 = [x, y, 0];
    picks.push(p);
    return { point: p, layer };
  });
  const inner = measure as unknown as Internals;
  const rect = () => ({ left: 0, top: 0, width: 200, height: 100 });
  inner._lastCanvas = { clientWidth: 200, clientHeight: 100, getBoundingClientRect: rect };
  (measure as unknown as { _draw: { element: { getBoundingClientRect: unknown } } })._draw.element.getBoundingClientRect = rect;
  measure.setActive(true);
  return { measure, inner, picks, pickOn: (l: unknown) => { layer = l; } };
}

/** A press and release on a vertex handle, moving `dx` CSS px between them. */
function pressHandle(inner: Internals, mid: string, vi: number, dx = 0): void {
  const target = { dataset: { mid, vi: String(vi) } };
  inner._handlePointerDown({ target, clientX: 50, clientY: 50, preventDefault: () => {} });
  if (dx) inner._handleDragMove({ clientX: 50 + dx, clientY: 50, pointerType: 'mouse' });
  inner._endDrag({ clientX: 50 + dx, clientY: 50 });
}

describe('a click that ended a drag', () => {
  it('places nothing when the pointer moved more than 4 px', async () => {
    const { measure, inner } = await makeController();
    measure.notePress(100, 50, false);
    measure.clickAt(130, 60);
    expect(inner._draft).toBeNull();
  });

  it('still places a point for a click inside the slop', async () => {
    const { measure, inner } = await makeController();
    measure.notePress(100, 50, false);
    measure.clickAt(103, 50);
    expect(inner._draft?.points).toHaveLength(1);
  });

  it('gives a touch the wider tap slop', async () => {
    const { measure, inner } = await makeController();
    measure.notePress(100, 50, true);
    measure.clickAt(108, 50);
    expect(inner._draft?.points).toHaveLength(1);
  });
});

describe('a click on an existing vertex while placing', () => {
  const A: Vec3 = [4, 2, 100];
  const B: Vec3 = [7, 2, 100];
  const C: Vec3 = [4, 6, 100];

  it('places an angle B-A-C on the vertices of a polyline A-B-C', async () => {
    const { measure, inner } = await makeController();
    measure.setKind('polyline');
    for (const p of [A, B, C]) measure.addPoint(p);
    measure.finishCurrent();
    const poly = measure.getMeasurements()[0];
    expect(poly.kind).toBe('polyline');

    measure.setKind('angle');
    pressHandle(inner, poly.id, 1);
    pressHandle(inner, poly.id, 0);
    pressHandle(inner, poly.id, 2);
    const all = measure.getMeasurements();
    expect(all).toHaveLength(2);
    expect(all[1].kind).toBe('angle');
    expect(all[1].points).toEqual([B, A, C]);
    // The polyline the handles belong to is unchanged.
    expect(poly.points).toEqual([A, B, C]);
  });

  it('still drags the vertex when the press moves past the slop', async () => {
    const { measure, inner } = await makeController();
    measure.setKind('distance');
    measure.addPoint(A);
    measure.addPoint(B);
    const d = measure.getMeasurements()[0];
    pressHandle(inner, d.id, 0, 20);
    expect(inner._draft).toBeNull();
    expect(measure.getMeasurements()).toHaveLength(1);
  });
});

describe('Undo of a delete', () => {
  it('restores the measurement with its id, name, owner and place', async () => {
    const { measure } = await makeController();
    measure.setKind('distance');
    for (let i = 0; i < 3; i++) {
      measure.addPoint([i, 0, 0]);
      measure.addPoint([i, 1, 0]);
    }
    const before = measure.getMeasurements().map((m) => ({ id: m.id, name: m.name }));
    const mid = measure.getMeasurements()[1];
    mid.owner = { sourceId: 'scan-a' } as unknown as typeof mid.owner;
    measure.renameMeasurement(mid.id, 'Kerb run');
    const removed = measure.removeMeasurement(mid.id);
    expect(removed).not.toBeNull();
    expect(measure.getMeasurements()).toHaveLength(2);
    expect(measure.restoreMeasurement(removed!)).toBe(true);
    const after = measure.getMeasurements();
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after[1].name).toBe('Kerb run');
    expect(after[1].owner).toEqual({ sourceId: 'scan-a' });
    // A second restore of the same delete does nothing.
    expect(measure.restoreMeasurement(removed!)).toBe(false);
  });

  it('refuses to restore into a list that was cleared or replaced since', async () => {
    const { measure } = await makeController();
    measure.setKind('distance');
    measure.addPoint([0, 0, 0]);
    measure.addPoint([1, 0, 0]);
    const removed = measure.removeMeasurement(measure.getMeasurements()[0].id)!;
    measure.clear();
    expect(measure.restoreMeasurement(removed)).toBe(false);
    expect(measure.getMeasurements()).toHaveLength(0);
  });
});

describe('a flat box', () => {
  it('says why its volume is 0', async () => {
    const { measure } = await makeController();
    measure.setKind('box');
    measure.addPoint([0, 0, 100]);
    measure.addPoint([4, 4, 100]);
    expect(measure.hint.textContent).toMatch(/flat: both corners are at one height, so its volume is 0/);
  });
});

describe('a canvas click records the scan it picked on', () => {
  it('lists a second scan in pickLayers when a click lands on it', async () => {
    const { measure, pickOn } = await makeController();
    const scanA = { name: 'a' };
    const scanB = { name: 'b' };
    measure.setLayerResolver((l) => (l === scanA ? 'scan-a' : l === scanB ? 'scan-b' : null));
    measure.setKind('distance');
    pickOn(scanA);
    measure.clickAt(20, 20);
    pickOn(scanB);
    measure.clickAt(150, 60);
    const [m] = measure.getMeasurements();
    expect(m).toBeDefined();
    expect(m!.pickLayers).toEqual(['scan-a', 'scan-b']);
  });
});

describe('the delete Undo offer and a new draft', () => {
  it('leaves Ctrl+Z to the draft once a new measurement is being drafted', async () => {
    const { MeasurePanel } = await import('../src/ui/MeasurePanel');
    const listeners: Array<(e: unknown) => void> = [];
    const w = globalThis as unknown as { window: { addEventListener: unknown; removeEventListener: unknown } };
    const saved = { add: w.window.addEventListener, remove: w.window.removeEventListener };
    w.window.addEventListener = (_t: string, fn: (e: unknown) => void) => listeners.push(fn);
    w.window.removeEventListener = (_t: string, fn: (e: unknown) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
    try {
      let drafting = false;
      let undone = 0;
      const host = { _undoOff: null } as unknown as InstanceType<typeof MeasurePanel>;
      MeasurePanel.prototype.offerUndo.call(host, 'Deleted A.', () => undone++, undefined, () => drafting);
      expect(listeners).toHaveLength(1);
      drafting = true;
      let stopped = false;
      let prevented = false;
      const key = {
        key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: null,
        preventDefault: () => { prevented = true; },
        stopImmediatePropagation: () => { stopped = true; },
      };
      listeners[0]!(key);
      expect(undone).toBe(0);
      expect(stopped).toBe(false);
      expect(prevented).toBe(false);
      // The offer is over: a later Ctrl+Z with no draft does not restore either.
      expect(listeners).toHaveLength(0);
    } finally {
      w.window.addEventListener = saved.add;
      w.window.removeEventListener = saved.remove;
    }
  });
});

describe('a point snapped onto another scan\'s measurement records that scan', () => {
  const scanA = { name: 'a' };
  const scanB = { name: 'b' };
  const resolver = (l: unknown) => (l === scanA ? 'scan-a' : l === scanB ? 'scan-b' : null);

  it('a vertex handle from a measurement picked on B adds B to the draft', async () => {
    const { measure, inner } = await makeController();
    measure.setLayerResolver(resolver);
    measure.setKind('distance');
    measure.addPoint([100, 0, 0], scanB);
    measure.addPoint([110, 0, 0], scanB);
    const onB = measure.getMeasurements()[0]!;
    measure.addPoint([0, 0, 0], scanA);
    pressHandle(inner, onB.id, 1);
    const d = measure.getMeasurements()[1]!;
    expect(d.points[1]).toEqual([110, 0, 0]);
    expect(d.pickLayers).toEqual(['scan-a', 'scan-b']);
  });

  it('falls back to the owner when the source has no pick record', async () => {
    const { measure, inner } = await makeController();
    measure.setLayerResolver(resolver);
    measure.setKind('distance');
    measure.addPoint([100, 0, 0]);
    measure.addPoint([110, 0, 0]);
    const src = measure.getMeasurements()[0]!;
    src.owner = { layerId: 'scan-b', frame: 'project' } as unknown as typeof src.owner;
    measure.addPoint([0, 0, 0], scanA);
    pressHandle(inner, src.id, 0);
    expect(measure.getMeasurements()[1]!.pickLayers).toEqual(['scan-a', 'scan-b']);
  });

  it('a geometry snap records the measurement under it, not the cloud clicked', async () => {
    const { measure } = await makeController();
    measure.setLayerResolver(resolver);
    measure.setKind('distance');
    measure.addPoint([100, 0, 0], scanB);
    measure.addPoint([110, 0, 0], scanB);
    measure.addPoint([0, 0, 0], scanA);
    (measure as unknown as { _resolveSnap: () => unknown })._resolveSnap = () => ({ kind: 'midpoint', position: [105, 0, 0], distance: 0.1 });
    measure.addPoint([105, 0.1, 0], scanA);
    const d = measure.getMeasurements()[1]!;
    expect(d.points[1]).toEqual([105, 0, 0]);
    expect(d.pickLayers).toEqual(['scan-a', 'scan-b']);
  });
});
