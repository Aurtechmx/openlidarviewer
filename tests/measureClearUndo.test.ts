/**
 * measureClearUndo.test.ts
 *
 * Clear removes every measurement at once and hands them to the `onClearAll`
 * hook as restorable records, so the panel mount can offer one Undo for the
 * whole list. Restoring puts them back in their old order; a second restore,
 * or one after a later clear, is refused.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { MeasureController as MC, RemovedMeasurement } from '../src/render/measure/MeasureController';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

function m(id: string, points: Vec3[]): Measurement {
  return { id, kind: 'distance', name: id, closed: false, points } as Measurement;
}

async function controller(): Promise<MC> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: [0, 0, 1], origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  return measure;
}

const WORK = (): Measurement[] => [
  m('a', [[0, 0, 0], [1, 0, 0]]),
  m('b', [[0, 0, 0], [2, 0, 0]]),
  m('c', [[0, 0, 0], [3, 0, 0]]),
];

describe('Clear with Undo', () => {
  it('empties the list at once and hands every measurement to onClearAll in order', async () => {
    const measure = await controller();
    measure.loadMeasurements(WORK());
    const seen: RemovedMeasurement[][] = [];
    measure.onClearAll = (removed) => seen.push(removed);
    measure.clear();
    expect(measure.getMeasurements()).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((r) => [r.measurement.id, r.index])).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });

  it('restores the whole list in its old order, once', async () => {
    const measure = await controller();
    measure.loadMeasurements(WORK());
    let removed: RemovedMeasurement[] = [];
    measure.onClearAll = (r) => { removed = r; };
    const changes = vi.fn();
    measure.setOnChange(changes);
    measure.clear();
    changes.mockClear();
    const restored = measure.holdChange(() => removed.map((r) => measure.restoreMeasurement(r)).some(Boolean));
    expect(restored).toBe(true);
    expect(measure.getMeasurements().map((x) => x.id)).toEqual(['a', 'b', 'c']);
    // One change for the whole restore, not one per row.
    expect(changes).toHaveBeenCalledTimes(1);
    expect(removed.map((r) => measure.restoreMeasurement(r))).toEqual([false, false, false]);
  });

  it('refuses a restore after a later clear replaced the list', async () => {
    const measure = await controller();
    measure.loadMeasurements(WORK());
    const batches: RemovedMeasurement[][] = [];
    measure.onClearAll = (r) => batches.push(r);
    measure.clear();
    measure.loadMeasurements([m('d', [[0, 0, 0], [4, 0, 0]])]);
    measure.clear();
    expect(batches[0]!.map((r) => measure.restoreMeasurement(r))).toEqual([false, false, false]);
    expect(measure.getMeasurements()).toHaveLength(0);
  });

  it('does not call the hook when there was nothing to clear', async () => {
    const measure = await controller();
    const hook = vi.fn();
    measure.onClearAll = hook;
    measure.clear();
    expect(hook).not.toHaveBeenCalled();
  });
});
