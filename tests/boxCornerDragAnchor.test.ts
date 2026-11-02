/**
 * boxCornerDragAnchor.test.ts
 *
 * A box corner dragged across the opposite corner, one frame at a time. Each
 * frame resized the box as the previous frame had left it, by the corner
 * index the drag began on. Once the drag crossed the anchor the box had been
 * re-normalised, that index named another corner, and the anchor jumped to
 * the previous frame's point: the box shrank to the last step and moved with
 * the pointer, and the release saved that box.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { MeasureController as MC, PickedPoint } from '../src/render/measure/MeasureController';
import { installFakeDom } from './support/measurePanelDom';

const listeners = new Map<string, Set<(e: unknown) => void>>();
const fire = (type: string, e: unknown = {}) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(e); };

beforeAll(() => {
  installFakeDom({ ns: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => { listeners.get(t)?.delete(fn); },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
});

/** A Z-up box from (0,0,0) to (4,4,4), its max corner (6) grabbed; the picker returns `next`. */
async function grabbedBox(): Promise<{ measure: MC; points: () => Vec3[]; pickAt: (p: Vec3) => void; frame: () => void }> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: [0, 0, 1], origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  (measure.overlay as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  const box = { id: 'b', kind: 'box', name: 'b', closed: false, points: [[0, 0, 0], [4, 4, 4]] as Vec3[] } as Measurement;
  measure.loadMeasurements([box]);
  measure.setActive(true);
  let next: Vec3 = [4, 4, 4];
  measure.setPicker(() => ({ point: next, layer: 'a' }) as PickedPoint);
  (measure as unknown as { _handlePointerDown(e: unknown): void })._handlePointerDown({
    target: { dataset: { mid: 'b', vi: '6' } }, preventDefault: () => {}, clientX: 10, clientY: 10, pointerId: 7,
  });
  let x = 10;
  return {
    measure,
    points: () => measure.getMeasurements()[0]!.points,
    pickAt: (p) => { next = p; x += 10; fire('pointermove', { clientX: x, clientY: 10, pointerType: 'mouse', pointerId: 7, buttons: 1 }); },
    frame: () => (measure as unknown as { _applyDrag(): void })._applyDrag(),
  };
}

describe('dragging a box corner across the opposite corner', () => {
  it('keeps the opposite corner fixed on every frame', async () => {
    const { points, pickAt, frame } = await grabbedBox();
    for (const p of [[2, 2, 2], [-1, -1, -1], [-2, -2, -2], [-3, -1, -2]] as Vec3[]) {
      pickAt(p);
      frame();
    }
    expect(points()).toEqual([[-3, -1, -2], [0, 0, 0]]);
  });

  it('saves that box on release', async () => {
    const { points, pickAt, frame } = await grabbedBox();
    pickAt([-1, -1, -1]);
    frame();
    pickAt([-2, -3, -1]);
    fire('pointerup', { clientX: 99, clientY: 10, pointerId: 7 });
    expect(points()).toEqual([[-2, -3, -1], [0, 0, 0]]);
  });

  it('puts the box back when the drag is cancelled', async () => {
    const { measure, points, pickAt, frame } = await grabbedBox();
    pickAt([-1, -1, -1]);
    frame();
    measure.cancelDrag();
    expect(points()).toEqual([[0, 0, 0], [4, 4, 4]]);
  });
});
