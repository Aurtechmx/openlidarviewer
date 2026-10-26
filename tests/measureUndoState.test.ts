/**
 * measureUndoState.test.ts
 *
 * The measure bar's Undo removes a drafted point and nothing else. With nothing
 * drafted the button is disabled, its tooltip says why, and the keyboard route
 * writes the "nothing to undo" hint instead of falling through. A vertex drag
 * keeps its start point, and Esc during the drag puts it back without leaving
 * the tool.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

const listeners = new Map<string, Set<(e: unknown) => void>>();

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

async function controller(): Promise<MC> {
  const { MeasureController, NOTHING_TO_UNDO_HINT } = await import('../src/render/measure/MeasureController');
  void NOTHING_TO_UNDO_HINT;
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: [0, 0, 1], origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  (measure.overlay as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  return measure;
}

const undoButton = (measure: MC): FakeEl => (measure.hint as unknown as FakeEl).querySelectorAll('.olv-measure-undo')[0]!;
const hintText = (measure: MC): string => (measure.hint as unknown as FakeEl).querySelectorAll('.olv-measure-hint-text')[0]!.textContent;

describe('the Undo button', () => {
  it('is disabled with nothing drafted and says so, and enables once a point is placed', async () => {
    const measure = await controller();
    measure.setActive(true);
    const undo = undoButton(measure);
    expect(undo.disabled).toBe(true);
    expect(undo.title).toBe('Undo last point (Backspace or Ctrl/Cmd+Z). Nothing to undo: the shape is finished.');
    measure.addPoint([0, 0, 0]);
    expect(undo.disabled).toBe(false);
    expect(undo.title).toBe('Remove the last point you placed (or press Backspace, or Ctrl/Cmd+Z).');
    measure.undoLastPoint();
    expect(undo.disabled).toBe(true);
  });

  it('writes the nothing-to-undo hint when asked with nothing drafted', async () => {
    const { NOTHING_TO_UNDO_HINT } = await import('../src/render/measure/MeasureController');
    const measure = await controller();
    measure.setActive(true);
    measure.undoLastPoint();
    expect(hintText(measure)).toBe(NOTHING_TO_UNDO_HINT);
    expect(NOTHING_TO_UNDO_HINT).toBe(
      'Nothing to undo here. To remove a finished measurement, use Delete on its result card or × in the Measurements list.',
    );
  });
});

describe('a vertex drag', () => {
  function pointerDown(measure: MC, id: string, vi: number): void {
    const target = { dataset: { mid: id, vi: String(vi) } };
    (measure as unknown as { _handlePointerDown(e: unknown): void })._handlePointerDown({
      target, preventDefault: () => {}, clientX: 10, clientY: 10,
    });
  }

  it('keeps the start point, and Esc puts the vertex back without leaving the tool', async () => {
    const measure = await controller();
    const onExit = vi.fn();
    (measure as unknown as { _cb: { onExit: () => void } })._cb = { onExit };
    const line = { id: 'd', kind: 'distance', name: 'd', closed: false, points: [[0, 0, 0], [4, 0, 0]] as Vec3[] } as Measurement;
    measure.loadMeasurements([line]);
    measure.setActive(true);
    pointerDown(measure, 'd', 1);
    expect(measure.dragging).toBe(true);
    // The drag has moved and re-picked the vertex somewhere else.
    for (const fn of listeners.get('pointermove') ?? []) fn({ clientX: 60, clientY: 60, pointerType: 'mouse' });
    measure.getMeasurements()[0]!.points[1] = [9, 9, 9];
    const esc = { key: 'Escape', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    for (const fn of [...(listeners.get('keydown') ?? [])]) fn(esc);
    expect(measure.dragging).toBe(false);
    expect(measure.getMeasurements()[0]!.points[1]).toEqual([4, 0, 0]);
    expect(esc.stopImmediatePropagation).toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(measure.active).toBe(true);
    // The Esc listener leaves with the drag.
    expect(listeners.get('keydown')?.size ?? 0).toBe(0);
  });

  it('cancelDrag reports whether a drag was open', async () => {
    const measure = await controller();
    expect(measure.cancelDrag()).toBe(false);
  });
});
