/**
 * `wireMeasureBarClearance` and `wireDockClearance` each owned observers (and,
 * for the measure bar, a window `resize` handler) but returned nothing, so a
 * torn-down column left them running against detached nodes. `wireDockClearance`
 * additionally discarded the `wireRailScrollAffordance` disposer it created.
 *
 * These assertions pin the disposer contract the sibling `wireRailToggle` and
 * `wireRailScrollAffordance` already hold: every registration is matched by a
 * removal. Recording stubs rather than jsdom, matching the other panel suites —
 * what matters is that a disconnect answers every observe and a removeEventListener
 * answers every addEventListener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wireMeasureBarClearance, wireDockClearance } from '../src/ui/panelChrome';

interface SpyObserver {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

let observers: SpyObserver[];

class SpyResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor() {
    observers.push(this);
  }
}
class SpyMutationObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor() {
    observers.push(this);
  }
}

function makeEl(): HTMLElement {
  const classes = new Set<string>();
  return {
    offsetHeight: 40,
    scrollHeight: 1200,
    clientHeight: 400,
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
    style: { setProperty: (): void => {} },
    classList: {
      toggle: (n: string, on?: boolean): void => void (on ? classes.add(n) : classes.delete(n)),
      add: (n: string): void => void classes.add(n),
      contains: (n: string): boolean => classes.has(n),
    },
  } as unknown as HTMLElement;
}

const saved = {
  resize: globalThis.ResizeObserver,
  mutation: globalThis.MutationObserver,
  window: (globalThis as { window?: unknown }).window,
  document: (globalThis as { document?: unknown }).document,
};

let removeResize: ReturnType<typeof vi.fn>;
let addResize: ReturnType<typeof vi.fn>;

beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
  globalThis.MutationObserver = SpyMutationObserver as unknown as typeof MutationObserver;
  addResize = vi.fn();
  removeResize = vi.fn();
  (globalThis as { window?: unknown }).window = {
    addEventListener: addResize,
    removeEventListener: removeResize,
  };
  // Minimal document so applyClassicScrollbarClass measures a classic (>0)
  // scrollbar and the rail affordance actually attaches observers.
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      style: { cssText: '' },
      offsetWidth: 15,
      clientWidth: 0,
      remove: (): void => {},
    }),
    body: { appendChild: (): void => {} },
    documentElement: { classList: { toggle: (): void => {} } },
  };
});

afterEach(() => {
  globalThis.ResizeObserver = saved.resize;
  globalThis.MutationObserver = saved.mutation;
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { document?: unknown }).document = saved.document;
});

describe('wireMeasureBarClearance teardown', () => {
  it('returns a disposer that disconnects its observer and drops the resize listener', () => {
    const dispose = wireMeasureBarClearance(makeEl(), makeEl());
    expect(typeof dispose).toBe('function');
    expect(observers).toHaveLength(1);
    expect(addResize).toHaveBeenCalledTimes(1);

    dispose();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(removeResize).toHaveBeenCalledTimes(1);
    expect(removeResize.mock.calls[0][0]).toBe('resize');
  });
});

describe('wireDockClearance teardown', () => {
  it('returns a disposer that disconnects the dock observer AND the rail affordance', () => {
    const dispose = wireDockClearance(makeEl(), makeEl());
    expect(typeof dispose).toBe('function');
    // Rail affordance (classic scrollbars) attaches a ResizeObserver + a
    // MutationObserver; the dock clearance attaches its own ResizeObserver.
    expect(observers).toHaveLength(3);

    dispose();
    for (const o of observers) expect(o.disconnect).toHaveBeenCalledTimes(1);
  });
});
