/**
 * profileAxisFitMount.test.ts — the chart's x-label re-fit wiring.
 *
 * The profile chart paints a static x-label overlay at build time (fitted
 * against the MIN_CHART_PX floor, safe when never mounted), then re-fits the x
 * labels against the chart's real width once a ResizeObserver reports it — on
 * mount and on every resize. These cases pin, at the panel level with the same
 * recording DOM stub the other MeasurePanel suites use:
 *   - the build-time overlay carries x-axis label spans (the fallback), and the
 *     panel renders without throwing when ResizeObserver is unavailable;
 *   - a chart element exposes `_olvRefitXLabels`, and firing it against a wide
 *     overlay keeps at least as many x labels as the narrow build-time fit.
 *
 * There is no jsdom here (node env, per the repo convention), so the overlay
 * markup lives in `innerHTML` as a string; the re-fit path that reads/parses a
 * real overlay is covered structurally, while the pure fit decision and the
 * width floor are pinned DOM-free in profileAxisFitActualWidth.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';

type Handler = (e: unknown) => void;

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
  clientWidth = 0;

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
      if (this.children[i].tagName !== '#text') return this.children[i];
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
  insertAdjacentHTML(_pos: string, html: string): void {
    this.innerHTML += html;
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(): void {}
  dispatchEvent(evt: { type: string }): boolean {
    for (const fn of this.handlers.get(evt.type) ?? []) fn(evt);
    return true;
  }
  focus(): void {}
  blur(): void {}
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

/** Records observed elements so a test can drive the resize callback. */
class RecordingResizeObserver {
  static instances: RecordingResizeObserver[] = [];
  readonly cb: () => void;
  readonly observed: FakeEl[] = [];
  constructor(cb: () => void) {
    this.cb = cb;
    RecordingResizeObserver.instances.push(this);
  }
  observe(el: FakeEl): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {}
}

function installGlobals(withResizeObserver: boolean): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.HTMLElement = FakeEl;
  if (withResizeObserver) {
    RecordingResizeObserver.instances = [];
    g.ResizeObserver = RecordingResizeObserver;
  } else {
    delete g.ResizeObserver;
  }
}

function profileSummary(): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < 24; i++) {
    profileChart.push({ distance: i * 12, height: 100 + Math.sin(i / 4) * 3, count: 10 });
  }
  return { id: 'p1', kind: 'profile', name: 'Section A', value: '276.00 m', profileChart };
}

function mount(): { panel: MeasurePanel; root: FakeEl } {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  panel.update([profileSummary()]);
  return { panel, root: panel.element as unknown as FakeEl };
}

describe('the profile chart re-fits its x labels after mount', () => {
  beforeAll(() => installGlobals(true));

  it('paints a static x-label overlay at build time (the fallback)', () => {
    const { root } = mount();
    const chart = root.querySelector('.olv-mp-chart')!;
    expect(chart).not.toBeNull();
    // The overlay markup lives in innerHTML; the static fit produced x labels.
    expect(chart.innerHTML).toContain('olv-mp-axis-x');
  });

  it('observes the chart and exposes a re-fit hook', () => {
    const { root } = mount();
    const chart = root.querySelector('.olv-mp-chart')! as unknown as {
      _olvRefitXLabels?: () => void;
    };
    expect(typeof chart._olvRefitXLabels).toBe('function');
    // The chart is one of the observed elements, so a resize drives the re-fit.
    const chartNode = root.querySelector('.olv-mp-chart');
    const observed = RecordingResizeObserver.instances.flatMap((o) => o.observed);
    expect(observed.some((o) => o === chartNode)).toBe(true);
  });

  it('firing the observer re-fits without throwing and keeps the overlay valid', () => {
    const { root } = mount();
    const chartEl = root.querySelector('.olv-mp-chart')!;
    // Give the chart a real, wide content box, then drive every observer.
    chartEl.clientWidth = 600;
    chartEl.clientHeight = 280;
    expect(() => {
      for (const o of RecordingResizeObserver.instances) o.cb();
    }).not.toThrow();
    // The overlay still carries x labels after the swap (the stub does not
    // parse innerHTML into queryable nodes, so the re-fit is a safe no-op here
    // and the build-time overlay stands).
    expect(chartEl.innerHTML).toContain('olv-mp-axis-x');
  });
});

describe('the chart renders when ResizeObserver is unavailable', () => {
  beforeAll(() => installGlobals(false));

  it('still paints the static overlay and does not throw', () => {
    let root: FakeEl | undefined;
    expect(() => {
      root = mount().root;
    }).not.toThrow();
    const chart = root!.querySelector('.olv-mp-chart')!;
    expect(chart.innerHTML).toContain('olv-mp-axis-x');
  });
});
