/**
 * compassController.test.ts
 *
 * Covers the compass life cycle that used to be four module-scope `let`s in
 * main.ts: the preference resolution, the "no scan, no compass" rule, the rAF
 * loop and its visibility pausing, and the open-then-close race the mount-time
 * re-validation exists to stop.
 *
 * No DOM and no renderer: the controller takes its viewer, its ViewCube loader
 * and its platform (rAF / visibility / storage) as structural parameters, so
 * the fakes below are the whole environment.
 */

import { describe, it, expect } from 'vitest';
import {
  createCompassController,
  type CompassPlatform,
  type CompassViewer,
} from '../src/ui/compassController';

function fakeViewer(cloudCount = 1): CompassViewer & { count: number } {
  const v = {
    count: cloudCount,
    clouds: () => ({ length: v.count }),
    cameraHeadingDeg: () => 42,
    setStandardView: () => undefined,
  };
  return v;
}

interface Harness {
  platform: CompassPlatform;
  /** Run the next queued animation frame, if the loop is running. */
  step(): boolean;
  setHidden(hidden: boolean): void;
  frames(): number;
  visListeners(): number;
  stored(): string | null;
}

function harness(initialPref: string | null = null): Harness {
  let pending: (() => void) | null = null;
  let nextHandle = 1;
  let live = 0;
  let hidden = false;
  let pref = initialPref;
  const listeners = new Set<() => void>();
  const platform: CompassPlatform = {
    requestAnimationFrame(cb) {
      pending = cb;
      live += 1;
      return nextHandle++;
    },
    cancelAnimationFrame() {
      pending = null;
      live -= 1;
    },
    isHidden: () => hidden,
    onVisibilityChange: (fn) => void listeners.add(fn),
    offVisibilityChange: (fn) => void listeners.delete(fn),
    readPref: () => pref,
    writePref: (value) => { pref = value; },
  };
  return {
    platform,
    step() {
      const cb = pending;
      if (!cb) return false;
      pending = null;
      live -= 1;
      cb();
      return true;
    },
    setHidden(next) {
      hidden = next;
      for (const fn of [...listeners]) fn();
    },
    frames: () => live,
    visListeners: () => listeners.size,
    stored: () => pref,
  };
}

/** A ViewCube stand-in whose load can be resolved by hand. */
function fakeCube() {
  const state = { mounts: 0, updates: 0, disposes: 0, resolve: (): void => {} };
  const loadCube = (): Promise<() => { update: () => void; dispose: () => void }> =>
    new Promise((res) => {
      state.resolve = () => res(() => {
        state.mounts += 1;
        return {
          update: () => { state.updates += 1; },
          dispose: () => { state.disposes += 1; },
        };
      });
    });
  return { state, loadCube };
}

const host = (): HTMLElement => ({}) as HTMLElement;

function build(
  pref: string | null,
  search = '',
): { c: ReturnType<typeof createCompassController>; h: Harness; cube: ReturnType<typeof fakeCube> } {
  const h = harness(pref);
  const cube = fakeCube();
  const c = createCompassController({
    host,
    urlParams: new URLSearchParams(search),
    platform: h.platform,
    loadCube: cube.loadCube,
  });
  return { c, h, cube };
}

describe('compass preference', () => {
  it('is off by default and on when the stored preference says so', () => {
    expect(build(null).c.isEnabled()).toBe(false);
    expect(build('off').c.isEnabled()).toBe(false);
    expect(build('on').c.isEnabled()).toBe(true);
  });

  it('lets ?viewcube override the stored preference in both directions', () => {
    expect(build('on', '?viewcube=0').c.isEnabled()).toBe(false);
    expect(build(null, '?viewcube=1').c.isEnabled()).toBe(true);
    // Bare `?viewcube` counts as on.
    expect(build('off', '?viewcube').c.isEnabled()).toBe(true);
  });

  it('persists the choice when toggled', () => {
    const { c, h } = build(null);
    c.setEnabled(true);
    expect(h.stored()).toBe('on');
    c.setEnabled(false);
    expect(h.stored()).toBe('off');
  });
});

describe('compass mounting', () => {
  it('does not mount while no scan is open', async () => {
    const { c, cube } = build('on');
    c.attachViewer(fakeViewer(0));
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(0);
  });

  it('mounts once a scan is open and the preference is on', async () => {
    const { c, cube, h } = build('on');
    c.attachViewer(fakeViewer(1));
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(1);
    expect(h.frames()).toBe(1);
    expect(h.visListeners()).toBe(1);
  });

  it('does not mount when the preference is off', async () => {
    const { c, cube } = build('off');
    c.attachViewer(fakeViewer(1));
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(0);
  });

  it('does not mount when the scan closed while the chunk was loading', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    // Scan closes before the lazy chunk resolves — the whole point of the
    // re-validation inside the .then().
    v.count = 0;
    c.refresh();
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(0);
  });

  it('does not mount twice when refresh fires repeatedly', async () => {
    const { c, cube } = build('on');
    c.attachViewer(fakeViewer(1));
    cube.state.resolve();
    await Promise.resolve();
    c.refresh();
    c.refresh();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(1);
  });
});

describe('compass frame loop', () => {
  it('spins the rose and pauses while the tab is hidden', async () => {
    const { c, cube, h } = build('on');
    c.attachViewer(fakeViewer(1));
    cube.state.resolve();
    await Promise.resolve();

    h.step();
    h.step();
    expect(cube.state.updates).toBe(2);
    expect(h.frames()).toBe(1);

    h.setHidden(true);
    expect(h.frames()).toBe(0);
    const updatesWhileHidden = cube.state.updates;
    expect(h.step()).toBe(false);
    expect(cube.state.updates).toBe(updatesWhileHidden);

    h.setHidden(false);
    expect(h.frames()).toBe(1);
    h.step();
    expect(cube.state.updates).toBe(updatesWhileHidden + 1);
  });

  it('tears down the frame, the listener and the widget when disabled', async () => {
    const { c, cube, h } = build('on');
    c.attachViewer(fakeViewer(1));
    cube.state.resolve();
    await Promise.resolve();

    c.setEnabled(false);
    expect(cube.state.disposes).toBe(1);
    expect(h.frames()).toBe(0);
    expect(h.visListeners()).toBe(0);
  });

  it('tears down when the last cloud closes, and comes back when one opens', async () => {
    const { c, cube, h } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    cube.state.resolve();
    await Promise.resolve();

    v.count = 0;
    c.refresh();
    expect(cube.state.disposes).toBe(1);
    expect(h.frames()).toBe(0);

    v.count = 2;
    c.refresh();
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(2);
    expect(h.frames()).toBe(1);
  });
});
