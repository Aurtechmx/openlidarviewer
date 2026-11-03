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
import { controllerWith, fire, installDragWindow, pressHandle } from './support/measureDrag';

beforeAll(installDragWindow);

/** A Z-up box from (0,0,0) to (4,4,4), its max corner (6) grabbed; the picker returns `next`. */
async function grabbedBox(): Promise<{ measure: MC; points: () => Vec3[]; pickAt: (p: Vec3) => void; frame: () => void }> {
  const measure = await controllerWith({ id: 'b', kind: 'box', name: 'b', closed: false, points: [[0, 0, 0], [4, 4, 4]] } as Measurement);
  let next: Vec3 = [4, 4, 4];
  measure.setPicker(() => ({ point: next, layer: 'a' }) as PickedPoint);
  pressHandle(measure, 'b', 6, 7);
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
