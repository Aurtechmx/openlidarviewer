/**
 * compassController.test.ts
 *
 * Covers the compass life cycle that used to be four module-scope `let`s in
 * main.ts: the preference resolution, the "no scan, no compass" rule, the
 * subscription to drawn frames, and the open-then-close race the mount-time
 * re-validation exists to stop.
 *
 * No DOM and no renderer: the controller takes its viewer, its ViewCube loader
 * and its platform (storage) as structural parameters, so the fakes below are
 * the whole environment. The rose used to spin on an animation frame of its
 * own, paused by a visibility handler; it now updates after each frame the
 * render loop draws, which already stops when the tab is hidden.
 */

import { describe, it, expect } from 'vitest';
import {
  createCompassController,
  type CompassPlatform,
  type CompassViewer,
} from '../src/ui/compassController';

function fakeViewer(cloudCount = 1): CompassViewer & {
  count: number;
  /** Deliver one drawn frame to whatever is subscribed. */
  draw(): void;
  listeners(): number;
} {
  const subscribed = new Set<() => void>();
  const v = {
    count: cloudCount,
    clouds: () => ({ length: v.count }),
    cameraHeadingDeg: () => 42,
    setStandardView: () => undefined,
    onDrawnFrame: (listener: () => void) => {
      subscribed.add(listener);
      return () => subscribed.delete(listener);
    },
    draw: () => { for (const l of [...subscribed]) l(); },
    listeners: () => subscribed.size,
  };
  return v;
}

interface Harness {
  platform: CompassPlatform;
  stored(): string | null;
}

function harness(initialPref: string | null = null): Harness {
  let pref = initialPref;
  const platform: CompassPlatform = {
    readPref: () => pref,
    writePref: (value) => { pref = value; },
  };
  return { platform, stored: () => pref };
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
    const { c, cube } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(1);
    expect(v.listeners()).toBe(1);
    // Mounting updates once rather than waiting for a frame: on a parked
    // camera the next drawn frame may be a heartbeat away, and the rose must
    // not sit at north until then.
    expect(cube.state.updates).toBe(1);
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

describe('compass frame subscription', () => {
  it('updates once per drawn frame and never between them', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    cube.state.resolve();
    await Promise.resolve();
    const atMount = cube.state.updates;

    v.draw();
    v.draw();
    expect(cube.state.updates).toBe(atMount + 2);
    // Nothing runs on its own: no frames, no updates. The old loop kept
    // spinning here whatever the renderer was doing.
    expect(cube.state.updates).toBe(atMount + 2);
  });

  it('tears down the subscription and the widget when disabled', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    cube.state.resolve();
    await Promise.resolve();

    c.setEnabled(false);
    expect(cube.state.disposes).toBe(1);
    expect(v.listeners()).toBe(0);
    const after = cube.state.updates;
    v.draw();
    expect(cube.state.updates).toBe(after);
  });

  it('tears down when the last cloud closes, and comes back when one opens', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    cube.state.resolve();
    await Promise.resolve();

    v.count = 0;
    c.refresh();
    expect(cube.state.disposes).toBe(1);
    expect(v.listeners()).toBe(0);

    v.count = 2;
    c.refresh();
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(2);
    expect(v.listeners()).toBe(1);
  });
});
