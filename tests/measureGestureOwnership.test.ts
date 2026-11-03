/**
 * measureGestureOwnership.test.ts
 *
 * Who owns a gesture while measuring. A double-click with the tool paused for
 * navigation (hold Space) finished the open measurement, where a single click
 * already went to the camera. A vertex drag answered any pointer's moves and
 * releases, so a second finger could end it; an interrupted touch or a lost
 * window focus left it open with its listeners attached; and turning the tool
 * off mid-drag kept the half-dragged vertex.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { MeasureController as MC, PickedPoint } from '../src/render/measure/MeasureController';
import { doubleClickAction } from '../src/render/touchTapGate';
import { controllerWith, fire, installDragWindow, openListeners as open, pressHandle } from './support/measureDrag';

beforeAll(installDragWindow);

async function dragging(): Promise<{ measure: MC; points: () => Vec3[] }> {
  const measure = await controllerWith({ id: 'd', kind: 'distance', name: 'd', closed: false, points: [[0, 0, 0], [4, 0, 0]] } as Measurement);
  press(measure, 7);
  return { measure, points: () => measure.getMeasurements()[0]!.points };
}

const press = (measure: MC, pointerId: number): void => pressHandle(measure, 'd', 1, pointerId);

/** Move the drag pointer past the slop and stand in for the re-pick that moved the vertex. */
function moveVertex(points: () => Vec3[]): void {
  fire('pointermove', { clientX: 60, clientY: 60, pointerType: 'touch', pointerId: 7 });
  points()[1] = [9, 9, 9];
}

describe('a double-click while measuring', () => {
  it('finishes the measurement only when the tool is not paused', () => {
    expect(doubleClickAction('measure', false)).toBe('finish');
    expect(doubleClickAction('measure', true)).toBe('focus');
  });

  it('focuses with no tool, and belongs to the camera in any paused tool', () => {
    expect(doubleClickAction('none', false)).toBe('focus');
    expect(doubleClickAction('annotate', false)).toBe('none');
    expect(doubleClickAction('annotate', true)).toBe('focus');
    expect(doubleClickAction('inspect', true)).toBe('focus');
  });
});

describe('a vertex drag', () => {
  it('ignores a second pointer: its press starts nothing, its moves and release do not end the drag', async () => {
    const { measure, points } = await dragging();
    press(measure, 8);
    fire('pointermove', { clientX: 90, clientY: 90, pointerType: 'touch', pointerId: 8 });
    fire('pointerup', { clientX: 90, clientY: 90, pointerId: 8 });
    expect(measure.dragging).toBe(true);
    moveVertex(points);
    fire('pointerup', { clientX: 60, clientY: 60, pointerId: 7 });
    expect(measure.dragging).toBe(false);
    expect(points()[1]).toEqual([9, 9, 9]);
    expect(open()).toBe(0);
  });

  it('places the vertex where the pointer was released, before a frame re-picks the last move', async () => {
    const { measure, points } = await dragging();
    measure.setPicker((x, y) => ({ point: [x, y, 1], layer: 'a' }) as PickedPoint);
    fire('pointermove', { clientX: 60, clientY: 60, pointerType: 'touch', pointerId: 7 });
    fire('pointerup', { clientX: 75, clientY: 25, pointerId: 7 });
    expect(measure.dragging).toBe(false);
    expect(points()[1]).toEqual([0.5, 0.5, 1]);
    expect(open()).toBe(0);
  });

  it('keeps the last move when the release lands where nothing is picked', async () => {
    const { measure, points } = await dragging();
    measure.setPicker((x, y) => (x > 0.6 ? null : { point: [x, y, 1], layer: 'a' }) as PickedPoint | null);
    fire('pointermove', { clientX: 60, clientY: 60, pointerType: 'touch', pointerId: 7 });
    fire('pointerup', { clientX: 90, clientY: 60, pointerId: 7 });
    expect(points()[1][0]).toBeCloseTo(0.2, 6);
    expect(points()[1][1]).toBeCloseTo(-0.2, 6);
    expect(open()).toBe(0);
  });

  it('puts the vertex back when the drag pointer is cancelled, and not for another pointer', async () => {
    const { measure, points } = await dragging();
    moveVertex(points);
    fire('pointercancel', { pointerId: 8 });
    expect(measure.dragging).toBe(true);
    fire('pointercancel', { pointerId: 7 });
    expect(measure.dragging).toBe(false);
    expect(points()[1]).toEqual([4, 0, 0]);
    expect(open()).toBe(0);
  });

  it('puts the vertex back when the window loses focus', async () => {
    const { measure, points } = await dragging();
    moveVertex(points);
    fire('blur');
    expect(measure.dragging).toBe(false);
    expect(points()[1]).toEqual([4, 0, 0]);
    expect(open()).toBe(0);
  });

  it('puts the vertex back when the tool is turned off mid-drag, and keeps the measurement', async () => {
    const { measure, points } = await dragging();
    moveVertex(points);
    measure.setActive(false);
    expect(measure.dragging).toBe(false);
    expect(measure.getMeasurements()).toHaveLength(1);
    expect(points()[1]).toEqual([4, 0, 0]);
    expect(open()).toBe(0);
  });

  it('puts back the scans the measurement records it was picked on', async () => {
    const { measure, points } = await dragging();
    const m = measure.getMeasurements()[0]!;
    measure.cancelDrag();
    m.pickLayers = ['a'];
    press(measure, 7);
    moveVertex(points);
    m.pickLayers.push('b');
    fire('blur');
    expect(m.pickLayers).toEqual(['a']);
    expect(open()).toBe(0);
  });

  it('puts the vertex back when Space pauses the tool mid-drag', async () => {
    const { measure, points } = await dragging();
    moveVertex(points);
    measure.setNavigationPaused(true);
    expect(measure.dragging).toBe(false);
    expect(points()[1]).toEqual([4, 0, 0]);
    expect(open()).toBe(0);
    measure.setNavigationPaused(false);
  });

  it('puts the vertex back when a mouse moves with no button held: the release was outside the page', async () => {
    const { measure, points } = await dragging();
    moveVertex(points);
    fire('pointermove', { clientX: 70, clientY: 70, pointerType: 'mouse', pointerId: 7, buttons: 0 });
    expect(measure.dragging).toBe(false);
    expect(points()[1]).toEqual([4, 0, 0]);
    expect(open()).toBe(0);
  });

  it('cannot start while the tool is paused for navigation', async () => {
    const { measure } = await dragging();
    measure.cancelDrag();
    measure.setNavigationPaused(true);
    press(measure, 9);
    expect(measure.dragging).toBe(false);
    expect((measure.overlay as unknown as { classList: { contains(c: string): boolean } }).classList.contains('olv-nav-paused')).toBe(true);
    measure.setNavigationPaused(false);
    press(measure, 9);
    expect(measure.dragging).toBe(true);
    measure.cancelDrag();
    expect(open()).toBe(0);
  });
});

