/**
 * measurePanelWorkbenchDock.test.ts
 *
 * The docked workbench as the Measurements-panel mount actually wires it: a
 * real MeasurePanel, the real launcher, the real dock, and a scene seam over a
 * stand-in profile seam.
 *
 * Two things are pinned that no smaller piece can pin on its own.
 *
 *   - The mount hands the presenter the corridor GENERATOR. Running the walk
 *     to completion instead freezes the app with the dock already mounted and
 *     empty, and that is invisible to anything that only checks the result.
 *   - The dock is closed on the two events that make its plot a picture of a
 *     scene nobody is looking at any more: the measurement is deleted, and a
 *     scan is loaded. A dock left behind keeps its `calc(100% - Npx)` claim on
 *     the stage over an unrelated scene.
 *
 * Node environment, per-test recording DOM stub, the convention the other
 * MeasurePanel suites use. No jsdom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createMeasurePanelMount } from '../src/app/measurePanelMount';
import { SLICE_BUDGET_MS } from '../src/app/profileWorkbenchSection';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface these modules touch. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  textContent = '';
  title = '';
  value = '';
  innerHTML = '';
  open = false;
  tabIndex = 0;
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { height: string } = { height: '' };
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  get parentElement(): FakeEl | null {
    return this.parent;
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
      add: (...c: string[]): void => void c.forEach((n) => classes.add(n)),
      remove: (...c: string[]): void => void c.forEach((n) => classes.delete(n)),
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

/** Frames the presenter asked for, run only when a test says so. */
let frames: (() => void)[] = [];

beforeEach(() => {
  frames = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  g.requestAnimationFrame = (fn: () => void): number => frames.push(fn);
  g.window = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
  };
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'document',
    'HTMLInputElement',
    'HTMLAnchorElement',
    'ResizeObserver',
    'requestAnimationFrame',
    'window',
  ]) {
    delete g[key];
  }
});

/** A section over a handful of returns, enough to describe and draw. */
function tinySection(count = 32): ProfileSectionResult {
  const chainage = new Float32Array(count);
  const height = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    chainage[i] = i;
    height[i] = i * 0.25;
  }
  return {
    points: {
      count,
      chainage,
      height,
      lateralOffset: new Float32Array(count),
      sourceSlot: new Uint16Array(count),
      pointIndex: new Uint32Array(count),
      channelPresence: new Uint8Array(count),
    },
    frame: null as never,
    band: 1.5,
    scope: 'static' as never,
    scopeLabel: 'One loaded layer.',
    classificationOnEverySource: true,
    streamingComplete: null,
    sources: [],
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
  };
}

/** A profile row with enough samples for the chart strip (and its Expand). */
function profileSummary(id = 'p1', name = 'Section A'): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < 8; i++) {
    profileChart.push({ distance: i * 10, height: 100 + i * 0.5, count: 12 });
  }
  return { id, kind: 'profile', name, value: '70.00 m', profileChart };
}

interface Rig {
  readonly mount: ReturnType<typeof createMeasurePanelMount>;
  readonly appRoot: FakeEl;
  readonly stageEl: FakeEl;
  readonly section: ReturnType<typeof vi.fn>;
  readonly sectionChunks: ReturnType<typeof vi.fn>;
  readonly removed: string[];
  /** Chunks the fake seam has been asked for. */
  chunks(): number;
}

/**
 * The mount, wired to a stand-in scene.
 *
 * `chunkCount` chunks are yielded, each holding the thread past the slice
 * budget, so a walk that is genuinely spread across frames cannot finish
 * inside the first slice and a walk that is not, does.
 */
function rig(chunkCount = 2): Rig {
  const appRoot = new FakeEl('div');
  appRoot.clientHeight = 900;
  const stageEl = new FakeEl('div');
  appRoot.append(stageEl);

  let pulled = 0;
  const section = vi.fn(() => tinySection());
  const sectionChunks = vi.fn(function* (): Generator<number, ProfileSectionResult | null, void> {
    for (let i = 0; i < chunkCount; i++) {
      const from = Date.now();
      // Past the budget, deterministically: the presenter must hand the thread
      // back rather than carry on to the end of the scene.
      while (Date.now() - from <= SLICE_BUDGET_MS) {
        /* hold the slice */
      }
      pulled++;
      yield pulled * 1000;
    }
    return tinySection();
  });

  const removed: string[] = [];
  const measurements = [
    { id: 'p1', kind: 'profile', name: 'Section A', points: [[0, 0, 0], [70, 0, 0]] },
  ];
  const viewer = {
    measure: {
      datumResolved: false,
      worldUp: [0, 0, 1],
      unitToMetres: 1,
      verticalUnitToMetres: 1,
      unitSystem: 'metric',
      getMeasurements: () => measurements,
      getSummaries: () => [profileSummary()],
      removeMeasurement: (id: string) => void removed.push(id),
      renameMeasurement: () => {},
      resampleProfile: () => {},
      setHoveredStation: () => false,
    },
    measureMode: false,
    clouds: () => [{}],
    profileSeam: { section, sectionChunks },
    requestFrame: () => {},
  };

  const mount = createMeasurePanelMount({
    getViewer: () => viewer as never,
    crsService: {
      context: () => ({ linearUnitKnown: true, linearUnitToMetres: 1 }),
      current: () => null,
    } as never,
    getExportPanel: () => ({ refresh: () => {} }),
    exportSession: () => {},
    handleFile: () => {},
    recordUsage: () => {},
    workbenchStage: { root: stageEl as unknown as HTMLElement },
  });

  return { mount, appRoot, stageEl, section, sectionChunks, removed, chunks: () => pulled };
}

/**
 * Wait for `done`, one macrotask at a time.
 *
 * Expand answers through two chained dynamic imports, and the panel's own
 * handler is fire-and-forget, so there is no promise a caller can await.
 */
async function settleUntil(done: () => boolean, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) await new Promise((r) => setTimeout(r, 0));
}

const dockOf = (r: Rig): FakeEl | null => r.appRoot.querySelector('section.olv-workbench');

/** Mount the panel, press Expand on its profile row, and let the dock mount. */
async function openDock(r: Rig): Promise<void> {
  await r.mount.ensure();
  const panel = r.mount.panel!;
  const expand = (panel.element as unknown as FakeEl).querySelector('button.olv-mp-chart-expand');
  expect(expand).not.toBeNull();
  expand!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  await settleUntil(() => dockOf(r) !== null);
  expect(dockOf(r)).not.toBeNull();
}
const statusOf = (r: Rig): string =>
  dockOf(r)?.querySelector('div.olv-workbench-status')?.textContent ?? '';

describe('the mount hands the presenter the corridor generator', () => {
  it('walks the corridor in chunks and never calls the run-to-completion seam', async () => {
    const r = rig(2);
    await openDock(r);

    expect(r.sectionChunks).toHaveBeenCalledTimes(1);
    expect(r.section).not.toHaveBeenCalled();
    const request = r.sectionChunks.mock.calls[0]![0] as { chunkSize: number; signal: unknown };
    expect(request.chunkSize).toBeGreaterThan(0);
    expect(request.signal).toBeDefined();

    // The dock is mounted, sized and saying what it is doing, with the walk
    // still outstanding: the extraction did not run to the end in one pass.
    expect(dockOf(r)).not.toBeNull();
    expect(r.stageEl.style.height).toMatch(/^calc\(100% - \d+px\)$/);
    expect(r.chunks()).toBe(1);
    expect(frames).toHaveLength(1);
    expect(statusOf(r)).toBe('Reading the returns inside this corridor.');

    while (frames.length > 0) frames.shift()!();
    expect(r.chunks()).toBe(2);
    expect(statusOf(r)).toBe('Showing 32 returns.');
  });
});

describe('the dock does not outlive what it is a section of', () => {
  it('closes when the measurement it plots is deleted, and hands the stage back', async () => {
    const r = rig(1);
    await openDock(r);
    while (frames.length > 0) frames.shift()!();
    expect(dockOf(r)).not.toBeNull();

    const del = (r.mount.panel!.element as unknown as FakeEl).querySelector('button.olv-mp-del');
    expect(del).not.toBeNull();
    del!.dispatchEvent({ type: 'click' });

    expect(r.removed).toEqual(['p1']);
    expect(dockOf(r)).toBeNull();
    expect(r.stageEl.style.height).toBe('');
  });

  it('closes on a scan load, which is the call every reveal makes', async () => {
    const r = rig(1);
    await openDock(r);
    while (frames.length > 0) frames.shift()!();
    expect(dockOf(r)).not.toBeNull();

    await r.mount.ensure();
    expect(dockOf(r)).toBeNull();
    expect(r.stageEl.style.height).toBe('');
  });

  it('closes when the session resets to the empty state', async () => {
    const r = rig(1);
    await openDock(r);
    while (frames.length > 0) frames.shift()!();
    r.mount.hide();
    expect(dockOf(r)).toBeNull();
    expect(r.stageEl.style.height).toBe('');
  });
});
