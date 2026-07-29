/**
 * The left rail is its own scroll container and carries `pointer-events: none`
 * so drags in the gaps between panels reach the canvas underneath. A scrollbar
 * belongs to the scroll container, so that same rule makes the scrollbar
 * un-hittable: the pointer passes through it.
 *
 * Nothing caught it because the browsers this project tests on use overlay
 * scrollbars, which take no layout width and are not dragged. Windows uses a
 * classic 15px scrollbar that is meant to be dragged, and the drag did nothing
 * while the wheel kept working, so the rail read as stalled rather than broken.
 *
 * These assertions pin the toggle, not the visual result: the class is present
 * only while the column actually overflows, which is exactly when a scrollbar
 * exists for the user to reach.
 *
 * A recording stub rather than jsdom, matching the other panel suites.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wireRailScrollAffordance } from '../src/ui/panelChrome';

interface ColumnStub {
  scrollHeight: number;
  clientHeight: number;
  readonly classes: Set<string>;
  readonly classList: {
    toggle(name: string, on: boolean): void;
    add(name: string): void;
    contains(name: string): boolean;
  };
}

function makeColumn(scrollHeight: number, clientHeight: number): ColumnStub {
  const classes = new Set<string>();
  return {
    scrollHeight,
    clientHeight,
    classes,
    classList: {
      toggle: (n, on) => void (on ? classes.add(n) : classes.delete(n)),
      add: (n) => void classes.add(n),
      contains: (n) => classes.has(n),
    },
  };
}

const wire = (c: ColumnStub, classic = true): (() => void) =>
  wireRailScrollAffordance(c as unknown as HTMLElement, classic);

/**
 * The node environment has neither observer, and with none attached the
 * function deliberately opts the column in. Installing inert stubs exercises
 * the observed path, which is the one browsers take.
 */
class InertObserver {
  observe(): void {}
  disconnect(): void {}
}

describe('wireRailScrollAffordance', () => {
  const disposers: Array<() => void> = [];
  const saved = {
    resize: globalThis.ResizeObserver,
    mutation: globalThis.MutationObserver,
  };

  beforeEach(() => {
    globalThis.ResizeObserver = InertObserver as unknown as typeof ResizeObserver;
    globalThis.MutationObserver = InertObserver as unknown as typeof MutationObserver;
  });

  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
    globalThis.ResizeObserver = saved.resize;
    globalThis.MutationObserver = saved.mutation;
  });

  it('leaves the column pass-through when its content fits', () => {
    const column = makeColumn(400, 400);
    disposers.push(wire(column));
    expect(column.classes.has('olv-rail-scrollable')).toBe(false);
  });

  it('makes the column hit-testable once its content overflows', () => {
    const column = makeColumn(1200, 400);
    disposers.push(wire(column));
    expect(column.classes.has('olv-rail-scrollable')).toBe(true);
  });

  it('is exact at the boundary, so a column that just fits stays pass-through', () => {
    const fits = makeColumn(400, 400);
    disposers.push(wire(fits));
    expect(fits.classes.has('olv-rail-scrollable')).toBe(false);

    const overByOne = makeColumn(401, 400);
    disposers.push(wire(overByOne));
    expect(overByOne.classes.has('olv-rail-scrollable')).toBe(true);
  });

  it('returns a disposer that can be called safely', () => {
    const dispose = wire(makeColumn(1200, 400));
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });

  it('keeps the scrollbar reachable when no observer exists', () => {
    // Losing pass-through in the gaps is a smaller cost than shipping a
    // scrollbar that cannot be grabbed, so an engine without ResizeObserver
    // gets the hit-testable column rather than the pass-through one.
    // @ts-expect-error removing globals for the span of one assertion
    delete globalThis.ResizeObserver;
    // @ts-expect-error as above
    delete globalThis.MutationObserver;
    const column = makeColumn(400, 400); // fits, and still opts in
    disposers.push(wire(column));
    expect(column.classes.has('olv-rail-scrollable')).toBe(true);
  });

  it('does nothing on an overlay-scrollbar platform', () => {
    // macOS draws no scrollbar to grab, so opting the column in would only
    // take the canvas's pass-through in the gaps between panels.
    const column = makeColumn(1200, 400);
    disposers.push(wire(column, false));
    expect(column.classes.has('olv-rail-scrollable')).toBe(false);
  });
});
