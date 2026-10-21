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

function fakeViewer(cloudCount = 1, streaming = false): CompassViewer & {
  count: number;
  /** Whether a streamed scan is open, beside any static layers. */
  streaming: boolean;
  /** Deliver one drawn frame to whatever is subscribed. */
  draw(): void;
  listeners(): number;
} {
  const subscribed = new Set<() => void>();
  const v = {
    count: cloudCount,
    streaming,
    clouds: () => ({ length: v.count }),
    get hasStreamingCloud() { return v.streaming; },
    cameraOrientation: () => ({ forward: [0, -1, 0] as const, up: [0, 0, 1] as const, upIsZ: true }),
    setStandardView: () => undefined,
    orientView: () => true,
    frameAll: () => undefined,
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

function harness(initialPref: string | null = null, phone = false): Harness {
  let pref = initialPref;
  const platform: CompassPlatform = {
    readPref: () => pref,
    writePref: (value) => { pref = value; },
    isPhone: () => phone,
  };
  return { platform, stored: () => pref };
}

/** A ViewCube stand-in whose load can be resolved by hand. */
function fakeCube() {
  const state = { mounts: 0, updates: 0, disposes: 0, resolve: (): void => {} };
  const loadCube = (): Promise<() => { update: () => void; place: () => void; dispose: () => void }> =>
    new Promise((res) => {
      state.resolve = () => res(() => {
        state.mounts += 1;
        return {
          update: () => { state.updates += 1; },
          place: () => {},
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
  it('is on by default and respects an explicit stored choice either way', () => {
    expect(build(null).c.isEnabled()).toBe(true);
    expect(build('off').c.isEnabled()).toBe(false);
    expect(build('on').c.isEnabled()).toBe(true);
  });

  it('stays off by default on a phone, but a stored ON or ?viewcube=1 still wins', () => {
    const phone = (pref: string | null, search = ''): boolean => {
      const h = harness(pref, true);
      return createCompassController({ host, urlParams: new URLSearchParams(search), platform: h.platform, loadCube: fakeCube().loadCube }).isEnabled();
    };
    expect(phone(null)).toBe(false);
    expect(phone('on')).toBe(true);
    expect(phone(null, '?viewcube=1')).toBe(true);
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

describe('compass face routing (spec 1.4)', () => {
  async function mountWith(onView?: (v: string) => void) {
    const h = harness('on');
    let captured: { onView: (v: never) => void } | null = null;
    const viewerCalls: string[] = [];
    const v = { ...fakeViewer(1), setStandardView: (view: string) => { viewerCalls.push(view); return true; } };
    const c = createCompassController({
      host,
      urlParams: new URLSearchParams(''),
      platform: h.platform,
      onView,
      loadCube: () => Promise.resolve((o) => {
        captured = o as unknown as { onView: (v: never) => void };
        return { update: () => {}, place: () => {}, dispose: () => {} };
      }),
    });
    c.attachViewer(v);
    await Promise.resolve(); await Promise.resolve();
    return { click: (view: string) => captured!.onView(view as never), viewerCalls };
  }

  it('routes a face click through the supplied NavBar callback, not the viewer', async () => {
    const routed: string[] = [];
    const { click, viewerCalls } = await mountWith((v) => routed.push(v));
    click('back');
    expect(routed).toEqual(['back']);
    expect(viewerCalls).toEqual([]);
  });

  it('falls back to the viewer when no route is supplied', async () => {
    const { click, viewerCalls } = await mountWith();
    click('left');
    expect(viewerCalls).toEqual(['left']);
  });
});

describe('cube edge, corner and Home routing', () => {
  type Captured = { onOrient: (t: unknown, o: { dir: readonly number[] }) => void; onHome: () => void; isGeographic: () => boolean };
  async function mount(opts: { onOrient?: (t: unknown, o: { dir: readonly number[] }) => void; onHome?: () => void; geographic?: boolean; upIsZ?: boolean }) {
    const h = harness('on');
    let captured: Captured | null = null;
    const calls: string[] = [];
    const v = {
      ...fakeViewer(1),
      cameraOrientation: () => ({ forward: [0, -1, 0] as const, up: [0, 0, 1] as const, upIsZ: opts.upIsZ ?? true }),
      orientView: (dir: readonly number[]) => { calls.push(`orient ${dir.join(',')}`); return true; },
      frameAll: () => { calls.push('frameAll'); },
    };
    const c = createCompassController({
      host,
      urlParams: new URLSearchParams(''),
      platform: h.platform,
      onOrient: opts.onOrient as never,
      onHome: opts.onHome,
      cardinalsAreGeographic: () => opts.geographic ?? false,
      loadCube: () => Promise.resolve((o) => {
        captured = o as unknown as Captured;
        return { update: () => {}, place: () => {}, dispose: () => {} };
      }),
    });
    c.attachViewer(v);
    await Promise.resolve(); await Promise.resolve();
    return { cube: captured!, calls };
  }

  it('routes edges and corners through the supplied callback, and falls back to orientView', async () => {
    const routed: string[] = [];
    const a = await mount({ onOrient: (_t, o) => routed.push(o.dir.join(',')) });
    a.cube.onOrient({}, { dir: [1, 0, 0] });
    expect(routed).toEqual(['1,0,0']);
    expect(a.calls).toEqual([]);
    const b = await mount({});
    b.cube.onOrient({}, { dir: [0, 1, 0] });
    expect(b.calls).toEqual(['orient 0,1,0']);
  });

  it('Home calls the supplied Fit, else frameAll', async () => {
    let homes = 0;
    (await mount({ onHome: () => { homes += 1; } })).cube.onHome();
    expect(homes).toBe(1);
    const b = await mount({});
    b.cube.onHome();
    expect(b.calls).toEqual(['frameAll']);
  });

  it('shows cardinals only for a known CRS on a Z-up scene', async () => {
    expect((await mount({ geographic: true })).cube.isGeographic()).toBe(true);
    expect((await mount({ geographic: false })).cube.isGeographic()).toBe(false);
    // A Y-up scan's horizontal axes are not a map grid, CRS or not.
    expect((await mount({ geographic: true, upIsZ: false })).cube.isGeographic()).toBe(false);
  });
});

describe('rapid open / close during the lazy load', () => {
  it('leaves no widget and no subscription after open-close-open-close before the chunk lands', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    v.count = 0; c.refresh();
    v.count = 1; c.refresh();
    v.count = 0; c.refresh();
    cube.state.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(cube.state.mounts).toBe(0);
    expect(v.listeners()).toBe(0);
  });

  it('mounts exactly one widget with one subscription when the last state is open', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(1);
    c.attachViewer(v);
    v.count = 0; c.refresh();
    v.count = 1; c.refresh();
    cube.state.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(cube.state.mounts).toBe(1);
    expect(v.listeners()).toBe(1);
  });
});

describe('compass on a streamed scan', () => {
  it('mounts for a stream with no static layer, which the layer list does not hold', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(0, true);
    c.attachViewer(v);
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(1);
    expect(v.listeners()).toBe(1);
  });

  it('follows a stream opening after the viewer attached, and closing', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(0, false);
    c.attachViewer(v);
    expect(cube.state.mounts).toBe(0);

    v.streaming = true; // the Viewer's onStreamingChange calls refresh
    c.refresh();
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(1);

    v.streaming = false;
    c.refresh();
    expect(cube.state.disposes).toBe(1);
    expect(v.listeners()).toBe(0);
  });

  it('stays up when one of a static layer and a stream closes and the other remains', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(1, true);
    c.attachViewer(v);
    cube.state.resolve();
    await Promise.resolve();
    v.streaming = false;
    c.refresh();
    expect(cube.state.disposes).toBe(0);
    v.count = 0;
    c.refresh();
    expect(cube.state.disposes).toBe(1);
  });

  it('does not mount when the stream closed while the chunk was loading', async () => {
    const { c, cube } = build('on');
    const v = fakeViewer(0, true);
    c.attachViewer(v);
    v.streaming = false;
    cube.state.resolve();
    await Promise.resolve();
    expect(cube.state.mounts).toBe(0);
  });
});
