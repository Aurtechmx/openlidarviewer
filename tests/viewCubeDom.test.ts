/**
 * viewCubeDom.test.ts — the 3D ViewCube's DOM behaviour.
 *
 * A minimal recording DOM (no jsdom in this suite): the cube must mount once,
 * turn with the camera only when it turned, route faces / edges / corners /
 * Home to the right callbacks, label local scans truthfully, place itself clear
 * of the right rail, and detach everything on dispose.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { CameraOrientation, CubeOrientation, CubeTarget, StandardView } from '../src/render/viewCubeMath';

class FakeStyle {
  cssText = '';
  left = '';
  top = '';
  right = '';
  transformWrites = 0;
  private _transform = '';
  get transform(): string { return this._transform; }
  set transform(v: string) { this._transform = v; this.transformWrites++; }
}

class FakeEl {
  tag: string;
  className = '';
  type = '';
  title = '';
  textContent = '';
  hidden = false;
  tabIndex = 0;
  readonly style = new FakeStyle();
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (c: string, on: boolean): void => { if (on) this.classes.add(c); else this.classes.delete(c); },
  };
  private readonly listeners: Record<string, ((e: { stopPropagation(): void }) => void)[]> = {};
  removed = false;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  appendChild(c: FakeEl): FakeEl { this.children.push(c); return c; }
  addEventListener(t: string, fn: (e: { stopPropagation(): void }) => void): void { (this.listeners[t] ??= []).push(fn); }
  click(): void { for (const fn of this.listeners.click ?? []) fn({ stopPropagation: () => {} }); }
  blur(): void {}
  remove(): void { this.removed = true; }
  getBoundingClientRect(): FakeEl['rect'] { return this.rect; }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  byTestId(id: string): FakeEl {
    const found = this.all().find((e) => e.attrs['data-testid'] === id);
    if (!found) throw new Error(`no ${id}`);
    return found;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const windowListeners = new Map<string, number>();
let observers = 0;
function installDom(coarse = false): void {
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.matchMedia = (q: string) => ({ matches: coarse && q.includes('coarse') });
  g.window = {
    addEventListener: (t: string) => windowListeners.set(t, (windowListeners.get(t) ?? 0) + 1),
    removeEventListener: (t: string) => windowListeners.set(t, (windowListeners.get(t) ?? 0) - 1),
  };
  g.ResizeObserver = class {
    constructor() { observers += 1; }
    observe(): void {}
    disconnect(): void { observers -= 1; }
  };
}
afterEach(() => {
  delete g.document; delete g.matchMedia; delete g.window; delete g.ResizeObserver;
  windowListeners.clear();
  observers = 0;
});

const LEVEL_NORTH: CameraOrientation = { forward: [0, 1, 0], up: [0, 0, 1], upIsZ: true };

async function mount(opts: {
  orientation?: () => CameraOrientation | null;
  geographic?: () => boolean;
  obstacles?: FakeEl[];
  coarse?: boolean;
} = {}) {
  installDom(opts.coarse);
  const { mountViewCube } = await import('../src/ui/viewCube');
  const host = new FakeEl('div');
  host.rect = { left: 0, top: 0, right: 1440, bottom: 800, width: 1440, height: 800 };
  const calls = { views: [] as [StandardView, CubeOrientation][], orients: [] as [CubeTarget, CubeOrientation][], homes: 0 };
  const handle = mountViewCube({
    host: host as unknown as HTMLElement,
    getOrientation: opts.orientation ?? (() => LEVEL_NORTH),
    isGeographic: opts.geographic,
    onView: (v, o) => calls.views.push([v, o]),
    onOrient: (t, o) => calls.orients.push([t, o]),
    onHome: () => { calls.homes += 1; },
    obstacles: () => (opts.obstacles ?? []).map((el) => ({ el: el as unknown as Element })),
  });
  const root = host.children[0];
  const cube = root.all().find((e) => e.className === 'olv-viewcube-cube')!;
  return { handle, host, root, cube, calls };
}

describe('ViewCube DOM', () => {
  it('mounts one widget with 6 faces, 20 edge/corner spots and a Home control', async () => {
    const { host, root } = await mount();
    expect(host.children).toHaveLength(1);
    expect(root.all().filter((e) => e.className === 'olv-viewcube-face')).toHaveLength(6);
    expect(root.all().filter((e) => e.className === 'olv-viewcube-spot')).toHaveLength(20);
    expect(root.byTestId('viewcube-home').attrs['aria-label']).toBe('View cube home: frame all');
  });

  it('faces and Home are buttons in the tab order; spots are pointer shortcuts out of it', async () => {
    const { root } = await mount();
    for (const f of root.all().filter((e) => e.className === 'olv-viewcube-face')) {
      expect(f.tag).toBe('button');
      expect(f.tabIndex).toBe(0);
    }
    for (const s of root.all().filter((e) => e.className === 'olv-viewcube-spot')) expect(s.tabIndex).toBe(-1);
  });

  it('routes a face to onView with its orientation, an edge or corner to onOrient, Home to onHome', async () => {
    const { root, calls } = await mount();
    root.byTestId('viewcube-top').click();
    expect(calls.views.map(([v]) => v)).toEqual(['top']);
    expect(calls.views[0][1].dir[2]).toBeGreaterThan(0.99);
    root.byTestId('viewcube-top-north-east').click();
    root.byTestId('viewcube-south-west').click();
    expect(calls.orients.map(([t]) => t.id)).toEqual(['top-north-east', 'south-west']);
    expect(calls.orients[0][1].dir.every((c) => c > 0)).toBe(true);
    root.byTestId('viewcube-home').click();
    expect(calls.homes).toBe(1);
  });

  it('turns with the camera, writes nothing when it did not turn, and holds on a null orientation', async () => {
    let o: CameraOrientation | null = LEVEL_NORTH;
    const { handle, cube } = await mount({ orientation: () => o });
    const first = cube.style.transform;
    expect(first).toMatch(/^matrix3d\(/);
    const writes = cube.style.transformWrites;
    handle.update();
    expect(cube.style.transformWrites).toBe(writes);
    o = { forward: [0, 0.6, -0.8], up: [0, 0.8, 0.6], upIsZ: true }; // pitched down
    handle.update();
    expect(cube.style.transform).not.toBe(first);
    const pitched = cube.style.transform;
    o = null;
    handle.update();
    expect(cube.style.transform).toBe(pitched);
  });

  it('shows only the near-side edges and corners and marks the squarely faced face', async () => {
    const { root } = await mount({ orientation: () => ({ forward: [0, -1, 0], up: [0, 0, 1], upIsZ: true }) }); // looking south: north face toward us
    expect(root.byTestId('viewcube-top-north').hidden).toBe(false);
    expect(root.byTestId('viewcube-top-south').hidden).toBe(true);
    expect(root.byTestId('viewcube-front').attrs['aria-current']).toBe('true');
    expect(root.byTestId('viewcube-back').attrs['aria-current']).toBeUndefined();
  });

  it('labels a local scan with view names and a georeferenced one with cardinals, flipping live', async () => {
    let geo = false;
    const { handle, root } = await mount({ geographic: () => geo });
    expect(root.byTestId('viewcube-front').textContent).toBe('Front');
    expect(root.byTestId('viewcube-top-north-east').attrs['aria-label']).not.toMatch(/north|east/);
    geo = true;
    handle.update();
    expect(root.byTestId('viewcube-front').textContent).toBe('N');
    expect(root.byTestId('viewcube-left').textContent).toBe('E');
  });

  it('sits top-right, left of an expanded right rail, and moves when the rail goes', async () => {
    const rail = new FakeEl('div');
    rail.rect = { left: 1096, top: 56, right: 1426, bottom: 800, width: 330, height: 744 };
    const obstacles = [rail];
    const { handle, root } = await mount({ obstacles });
    expect(parseFloat(root.style.left) + 120).toBeLessThanOrEqual(1096);
    obstacles.length = 0;
    handle.place();
    expect(root.style.left).toBe(`${1440 - 14 - 120}px`);
  });

  it('is touch-sized on a coarse pointer', async () => {
    const { root } = await mount({ coarse: true });
    expect(root.style.cssText).toContain('width:156px');
    expect(root.byTestId('viewcube-north-east').style.cssText).toContain('width:44px');
  });

  it('detaches its observers and listeners on dispose', async () => {
    const { handle, root } = await mount();
    expect(observers).toBe(1);
    expect(windowListeners.get('resize')).toBe(1);
    handle.dispose();
    expect(root.removed).toBe(true);
    expect(observers).toBe(0);
    expect(windowListeners.get('resize')).toBe(0);
  });
});
