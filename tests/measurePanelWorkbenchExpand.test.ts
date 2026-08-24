/**
 * measurePanelWorkbenchExpand.test.ts
 *
 * Expand, on a profile row.
 *
 * The control used to have one destination. It now has two: the docked
 * workbench when the host offers one and it opens, and `ResultFocus` on every
 * refusal — a viewport too narrow for a dock, a host that wired no callback,
 * and above all a lazy chunk that failed to arrive. The point of the fallback
 * is that Expand never simply stops working, so the rejected-import path is
 * driven here with a loader that actually rejects.
 *
 * Node environment, per-test recording DOM stub, the convention the other
 * MeasurePanel suites use. `ResultFocus` is mocked because what is being pinned
 * is WHICH surface the panel chose, not what that surface renders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const openResultFocus = vi.fn();
vi.mock('../src/ui/ResultFocus', () => ({
  openResultFocus: (...args: unknown[]) => openResultFocus(...args),
}));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import { createProfileWorkbenchLauncher } from '../src/app/profileWorkbenchLauncher';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';
import type { ProfileWorkbenchHost } from '../src/ui/ProfileWorkbench';
import type { ProfileWorkbenchStage } from '../src/app/profileWorkbenchLauncher';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface MeasurePanel touches. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  textContent = '';
  title = '';
  value = '';
  innerHTML = '';
  open = false;
  tabIndex = 0;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();
  clientHeight = 0;
  offsetWidth = 0;

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  set className(v: string) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (c: string): void => void classes.add(c),
      remove: (c: string): void => void classes.delete(c),
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    };
  }

  get lastElementChild(): FakeEl | null {
    for (let i = this.children.length - 1; i >= 0; i--) {
      if (this.children[i]!.tagName !== '#text') return this.children[i]!;
    }
    return null;
  }

  private _adopt(kid: unknown): FakeEl {
    if (kid instanceof FakeEl) {
      kid.parent = this;
      return kid;
    }
    const t = new FakeEl('#text');
    t.textContent = String(kid);
    t.parent = this;
    return t;
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(this._adopt(k));
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(this._adopt(k));
  }
  remove(): void {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = null;
  }
  contains(node: FakeEl | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }

  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    const at = a.indexOf(fn);
    if (at >= 0) a.splice(at, 1);
  }
  dispatchEvent(evt: { type: string; stopPropagation?: () => void }): boolean {
    for (const fn of [...(this.handlers.get(evt.type) ?? [])]) fn(evt);
    return true;
  }
  focus(): void {}
  blur(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getContext(): null {
    return null;
  }

  private _matches(sel: string): boolean {
    const parts = sel.split('.');
    const tag = parts[0];
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    for (const c of parts.slice(1)) if (!this._classes.has(c)) return false;
    return true;
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) {
      if (c._matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  openResultFocus.mockClear();
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
  g.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.HTMLInputElement;
  delete g.HTMLAnchorElement;
  delete g.ResizeObserver;
});

/** A profile row with enough samples for the chart strip (and its Expand). */
function profileSummary(id = 'p1', name = 'Section A'): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < 8; i++) {
    profileChart.push({ distance: i * 10, height: 100 + i * 0.5, count: 12 });
  }
  return { id, kind: 'profile', name, value: '70.00 m', profileChart };
}

/** Mount a panel and hand back its Expand button and the chart wrapper. */
function mountPanel(
  openProfileWorkbench?: (s: MeasurementSummary) => Promise<boolean>,
): { panel: MeasurePanel; expand: FakeEl; wrap: FakeEl } {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
    ...(openProfileWorkbench ? { openProfileWorkbench } : {}),
  });
  panel.update([profileSummary()]);
  const root = panel.element as unknown as FakeEl;
  const expand = root.querySelector('button.olv-mp-chart-expand');
  expect(expand).not.toBeNull();
  const wrap = root.querySelector('div.olv-mp-chart-wrap');
  expect(wrap).not.toBeNull();
  return { panel, expand: expand!, wrap: wrap! };
}

/** Let the panel's `.then` on the workbench promise run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Expand routes a profile to the workbench when one opens', () => {
  it('opens the workbench and leaves ResultFocus closed', async () => {
    const openProfileWorkbench = vi.fn((_s: MeasurementSummary) => Promise.resolve(true));
    const { expand } = mountPanel(openProfileWorkbench);
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settle();
    expect(openProfileWorkbench).toHaveBeenCalledTimes(1);
    expect(openProfileWorkbench.mock.calls[0]![0]).toMatchObject({ id: 'p1', kind: 'profile' });
    expect(openResultFocus).not.toHaveBeenCalled();
  });

  it('keeps ResultFocus as the only surface when no host wired the callback', () => {
    const { expand } = mountPanel();
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    expect(openResultFocus).toHaveBeenCalledTimes(1);
  });
});

describe('Expand falls back to ResultFocus on every refusal', () => {
  it('falls back when the workbench declines', async () => {
    const { expand } = mountPanel(() => Promise.resolve(false));
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settle();
    expect(openResultFocus).toHaveBeenCalledTimes(1);
    expect(openResultFocus.mock.calls[0]![0]).toMatchObject({ title: 'Section A' });
  });

  it('falls back when the lazy import REJECTS, through the real launcher', async () => {
    // The whole chain, with only the chunk load replaced: a rejected import
    // must reach the panel as a refusal, not as an unhandled rejection and not
    // as a dead control.
    const stage: ProfileWorkbenchStage = {
      host: () =>
        ({
          container: () => new FakeEl('div') as unknown as HTMLElement,
          stageHeight: () => 900,
          onStageResize: () => () => {},
          notifyDockHeight: () => {},
        }) as ProfileWorkbenchHost,
      canDock: () => true,
      release: () => {},
    };
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
      stage,
    });
    const { expand } = mountPanel((s) =>
      launcher.open({ id: s.id, kind: s.kind, name: s.name }),
    );
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settle();
    expect(launcher.handle).toBeNull();
    expect(openResultFocus).toHaveBeenCalledTimes(1);
  });

  it('re-asks on every press, so a chunk that failed once can still succeed', async () => {
    let attempt = 0;
    const openProfileWorkbench = vi.fn((_s: MeasurementSummary) => Promise.resolve(attempt++ > 0));
    const { expand } = mountPanel(openProfileWorkbench);
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settle();
    expect(openResultFocus).toHaveBeenCalledTimes(1);
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settle();
    expect(openProfileWorkbench).toHaveBeenCalledTimes(2);
    expect(openResultFocus).toHaveBeenCalledTimes(1);
  });
});

describe('a rejected open is a refusal, not an unhandled rejection', () => {
  it('falls back to ResultFocus when the host REJECTS', async () => {
    // The host runs the extraction, the colour pass and the render behind this
    // promise. Any of them can throw, and a control that only handled `false`
    // left the user with nothing at all.
    const { expand } = mountPanel(() => Promise.reject(new Error('scene went away')));
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settle();
    expect(openResultFocus).toHaveBeenCalledTimes(1);
    expect(openResultFocus.mock.calls[0]![0]).toMatchObject({ title: 'Section A' });
  });

  it('falls back when the launcher’s own fill throws, and mounts no empty dock', async () => {
    const container = new FakeEl('div');
    const stage: ProfileWorkbenchStage = {
      host: () =>
        ({
          container: () => container as unknown as HTMLElement,
          stageHeight: () => 900,
          onStageResize: () => () => {},
          notifyDockHeight: () => {},
        }) as ProfileWorkbenchHost,
      canDock: () => true,
      release: () => {},
    };
    const launcher = createProfileWorkbenchLauncher({
      load: () =>
        Promise.resolve({
          mountProfileWorkbench: (host) => {
            const element = new FakeEl('section');
            host.container().append(element as unknown as HTMLElement);
            return {
              element: element as unknown as HTMLElement,
              canvas: new FakeEl('canvas') as unknown as HTMLCanvasElement,
              height: () => 300,
              collapsed: () => false,
              setCollapsed: () => {},
              setScope: () => {},
              setStatus: () => {},
              setDetail: () => {},
              close: () => element.remove(),
            };
          },
        }),
      stage,
      present: () => {
        throw new Error('no section to draw');
      },
      onPresentFailure: () => {},
    });
    const { expand } = mountPanel((s) => launcher.open({ id: s.id, kind: s.kind, name: s.name }));
    expand.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settle();
    expect(launcher.handle).toBeNull();
    expect(container.children).toHaveLength(0);
    expect(openResultFocus).toHaveBeenCalledTimes(1);
  });
});

describe('the Expand control names the surface it actually opens', () => {
  it('says a dock on a wide viewport and a focus view otherwise, when one is offered', () => {
    const { expand, wrap } = mountPanel(() => Promise.resolve(true));
    for (const node of [expand, wrap]) {
      const name = node.getAttribute('aria-label')!;
      expect(name).toContain('docked section workbench');
      expect(name).toContain('wide viewport');
      expect(node.title).toContain('docked section workbench');
    }
    // The dock carries neither, so only the focus-view half may promise them.
    expect(wrap.title).toContain('otherwise a focus view with the station table and export');
    expect(wrap.getAttribute('aria-label')).not.toContain('station table');
  });

  it('promises the focus view alone when no host wired a workbench', () => {
    const { expand, wrap } = mountPanel();
    for (const node of [expand, wrap]) {
      expect(node.getAttribute('aria-label')).toBe('Expand profile Section A to a focus view');
      expect(node.title).not.toContain('workbench');
    }
  });
});
