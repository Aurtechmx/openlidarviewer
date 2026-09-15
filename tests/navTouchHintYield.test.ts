/**
 * navTouchHintYield.test.ts
 *
 * The touch-gesture hint gets out of the way once it has been acted on.
 *
 * It used to hide on a 6.5 s timer and nothing else, so someone who read
 * "Drag to rotate" and immediately dragged kept the banner over the scan for
 * the rest of its countdown, the one moment it is provably no longer needed.
 * The hint now also retires shortly after a drag on the scan completes, and the
 * timer stays as the fallback for someone who reads it and does nothing.
 *
 * Drives the real NavBar over a recording DOM stub (the approach toolDock.test
 * uses) so the window listeners under test are the ones the component installs,
 * not a restatement of them.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { FakeEl } from './support/measurePanelDom';

type Handler = (ev: unknown) => void;

/** The window listeners NavBar installs, plus its pending timers. */
const listeners = new Map<string, Handler[]>();
const timers = new Map<number, { fn: () => void; ms: number }>();
let nextTimer = 1;

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    querySelector: () => null,
  };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
  g.window = {
    innerWidth: 390,
    innerHeight: 844,
    addEventListener: (type: string, fn: Handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: () => {},
    setTimeout: (fn: () => void, ms?: number) => {
      timers.set(nextTimer, { fn, ms: ms ?? 0 });
      return nextTimer++;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  g.clearTimeout = (id: number) => { timers.delete(id); };
});

beforeEach(() => {
  listeners.clear();
  timers.clear();
});

function fire(type: string, ev: unknown): void {
  for (const fn of listeners.get(type) ?? []) fn(ev);
}

/** Run every pending timer, shortest delay first. */
function runTimers(): void {
  const due = [...timers.values()].sort((a, b) => a.ms - b.ms);
  timers.clear();
  for (const t of due) t.fn();
}

/** The shortest delay currently pending, which is the one under test. */
function shortestDelay(): number {
  return Math.min(...[...timers.values()].map((t) => t.ms));
}

async function makeNavBar() {
  const { NavBar } = await import('../src/ui/NavBar');
  const noop = (): void => {};
  const bar = new NavBar({
    onModeChange: noop,
    onSpeedChange: noop,
    onToggleOrtho: noop,
    onCameraPreset: noop,
    onStandardView: noop,
  } as never);
  return { bar, hint: bar.touchHint as unknown as FakeEl };
}

/** A press that begins on the scan; anything else answers `closest` truthfully. */
const onScan = { target: { closest: () => null } };
const inNavBar = { target: { closest: (s: string) => (s === '.olv-navbar' ? {} : null) } };

describe('the touch hint yields to a demonstrated gesture', () => {
  it('stays up while nobody has touched the scan', async () => {
    const { bar, hint } = await makeNavBar();
    bar.flashTouchHint();
    expect(hint.classList.contains('olv-visible')).toBe(true);
  });

  it('retires shortly after a drag on the scan completes', async () => {
    const { bar, hint } = await makeNavBar();
    bar.flashTouchHint();
    const fallback = shortestDelay();
    fire('pointerdown', onScan);
    fire('pointerup', {});
    // A shorter timer than the 6.5 s fallback is now pending: the hint waits
    // out a beat rather than vanishing under the finger that just proved it.
    expect(shortestDelay()).toBeLessThan(fallback);
    expect(hint.classList.contains('olv-visible')).toBe(true);
    runTimers();
    expect(hint.classList.contains('olv-visible')).toBe(false);
  });

  it('ignores a press aimed at the navigation bar itself', async () => {
    const { bar, hint } = await makeNavBar();
    bar.flashTouchHint();
    const fallback = shortestDelay();
    fire('pointerdown', inNavBar);
    fire('pointerup', {});
    // Reaching for a control is not a demonstration of orbiting.
    expect(shortestDelay()).toBe(fallback);
    expect(hint.classList.contains('olv-visible')).toBe(true);
  });

  it('does nothing when the hint is not up', async () => {
    const { bar, hint } = await makeNavBar();
    void bar;
    fire('pointerdown', onScan);
    fire('pointerup', {});
    expect(timers.size).toBe(0);
    expect(hint.classList.contains('olv-visible')).toBe(false);
  });

  it('still hides on its own timer when the scan is never touched', async () => {
    const { bar, hint } = await makeNavBar();
    bar.flashTouchHint();
    runTimers();
    expect(hint.classList.contains('olv-visible')).toBe(false);
  });
});
