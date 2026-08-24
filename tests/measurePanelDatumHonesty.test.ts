/**
 * measurePanelDatumHonesty.test.ts
 *
 * The Measurements panel prints two kinds of height heading for a profile: the
 * summary row labels under the chart, and the station table's height column.
 * Both used to be gated on `profileDatumKnown`, which reports that the loaded
 * clouds share a render origin — not that a vertical datum exists. A cloud with
 * no declared vertical datum therefore had every absolute height printed under
 * the word "Elevation", asserting a sea-level surface the file never carried.
 *
 * These tests drive the real MeasurePanel through the project's recording DOM
 * stub and pin the headings on BOTH surfaces — the in-panel dock row and the
 * `ResultFocus` view — against the reference the app can actually resolve.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const openResultFocus = vi.fn();
vi.mock('../src/ui/ResultFocus', () => ({
  openResultFocus: (...args: unknown[]) => openResultFocus(...args),
}));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileProvenance } from '../src/render/measure/profileProvenance';
import type { ProfileChartSample } from '../src/render/measure/types';
import type { VerticalReference } from '../src/geo/height';

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
  disabled = false;
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
  removeEventListener(): void {
    /* not exercised */
  }
  dispatchEvent(evt: { type: string; stopPropagation?: () => void }): boolean {
    for (const fn of this.handlers.get(evt.type) ?? []) fn(evt);
    return true;
  }
  focus(): void {}
  blur(): void {}

  /** `tag`, `.class`, or `tag.class` — the only selector shapes this panel uses. */
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

/** No-op observer so the panel's resize-persistence path never warns or fires. */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.ResizeObserver = FakeResizeObserver;
});

beforeEach(() => {
  openResultFocus.mockClear();
});

const CHART: ProfileChartSample[] = [
  { distance: 0, height: 10, count: 5 },
  { distance: 10, height: 12, count: 8 },
  { distance: 20, height: 11, count: 3 },
];

/** A provenance record whose only interesting field is the resolved reference. */
function record(reference: VerticalReference): ProfileProvenance {
  return {
    recordVersion: 1,
    method: 'corridor-percentile',
    corridorVersion: 1,
    capturedAt: '2026-08-23T00:00:00.000Z',
    up: [0, 0, 1],
    upDegenerate: false,
    sources: [],
    acceptedCount: 0,
    scope: 'empty',
    residentOnly: false,
    complete: null,
    classPolicy: { excludedClasses: [], availableOnEverySource: false },
    units: { linearUnit: 'metre', verticalReference: reference, verticalMetresPerUnit: 1 },
  };
}

interface Scene {
  /** Origins agree. The pre-fix flag that was read as "a datum exists". */
  datumKnown?: boolean;
  /** What the CRS service resolved, as the host reports it at render time. */
  verticalDatum?: string | null;
  /** The measurement's own provenance record, when it has one. */
  provenance?: ProfileProvenance;
}

function summary(scene: Scene): MeasurementSummary {
  return {
    id: 'p1',
    kind: 'profile',
    name: 'Section A',
    value: '20.00 m',
    profileChart: CHART,
    profileDatumKnown: scene.datumKnown ?? true,
    profileProvenance: scene.provenance,
  };
}

/** Mount a panel over one profile row for the given scene. */
function mount(scene: Scene): FakeEl {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
    getProfileExportContext: () => ({
      crs: 'EPSG:32613 — WGS 84 / UTM zone 13N',
      verticalDatum: scene.verticalDatum ?? null,
    }),
  });
  panel.update([summary(scene)]);
  return panel.element as unknown as FakeEl;
}

/** Render the ResultFocus surface for the same scene and return its container. */
function focusView(scene: Scene): FakeEl {
  openResultFocus.mockClear();
  const root = mount(scene);
  const expand = root
    .querySelectorAll('button')
    .find((b) => (b.getAttribute('aria-label') ?? '').includes('Expand'));
  expect(expand, 'the profile row offers an Expand button').toBeDefined();
  expand!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  expect(openResultFocus).toHaveBeenCalledTimes(1);
  const opts = openResultFocus.mock.calls[0]![0] as { render: (c: unknown) => void };
  const container = new FakeEl('div');
  opts.render(container);
  return container;
}

/** The station table's height column heading, without its unit suffix. */
function heightColumn(scope: FakeEl): string {
  const heads = scope.querySelectorAll('th').map((th) => th.textContent);
  expect(heads.length, 'the station table renders its header row').toBeGreaterThan(0);
  // Station · Chainage · <height> · Points · Grade.
  return heads[2].replace(/\s*\(m\)$/, '');
}

/** Every summary row label under the chart. */
function summaryLabels(scope: FakeEl, cls: string): string[] {
  return scope.querySelectorAll(`dt.${cls}`).map((dt) => dt.textContent);
}

describe('MeasurePanel — the dock row never asserts a datum it does not have', () => {
  it('a cloud with no declared vertical datum gets no elevation heading', () => {
    const root = mount({ datumKnown: true, verticalDatum: null });
    expect(heightColumn(root)).toBe('Height (datum unknown)');
    for (const label of summaryLabels(root, 'olv-mp-summary-label')) {
      expect(label.toLowerCase()).not.toContain('elevation');
    }
  });

  it('agreeing render origins alone do not buy the word elevation', () => {
    // This is the whole defect: `profileDatumKnown` is true here, and true is
    // exactly what used to print "Elevation".
    const root = mount({ datumKnown: true, verticalDatum: null });
    expect(heightColumn(root)).not.toBe('Elevation');
  });

  it('a declared orthometric datum does earn it', () => {
    const root = mount({ datumKnown: true, verticalDatum: 'NAVD88' });
    expect(heightColumn(root)).toBe('Elevation');
    expect(summaryLabels(root, 'olv-mp-summary-label')).toContain('Highest elevation');
  });

  it('an ellipsoidal reference from the provenance record is named as one', () => {
    const root = mount({ provenance: record('ellipsoidal') });
    expect(heightColumn(root)).toBe('Ellipsoidal height');
    expect(summaryLabels(root, 'olv-mp-summary-label')).toContain('Highest ellipsoidal height');
  });

  it('conflicting render origins still degrade to the local frame', () => {
    const root = mount({ datumKnown: false, verticalDatum: 'NAVD88' });
    expect(heightColumn(root)).toBe('Height (local frame)');
  });

  it('a datum name the tables do not recognise is not promoted', () => {
    const root = mount({ verticalDatum: 'Site datum (assumed)' });
    expect(heightColumn(root)).toBe('Height (datum unknown)');
  });
});

describe('MeasurePanel — the focus view carries the same headings as the dock', () => {
  it('a cloud with no declared vertical datum gets no elevation heading', () => {
    const view = focusView({ datumKnown: true, verticalDatum: null });
    expect(heightColumn(view)).toBe('Height (datum unknown)');
    for (const label of summaryLabels(view, 'olv-rf-stat-label')) {
      expect(label.toLowerCase()).not.toContain('elevation');
    }
  });

  it('a declared orthometric datum does earn it', () => {
    const view = focusView({ verticalDatum: 'NAVD88' });
    expect(heightColumn(view)).toBe('Elevation');
    expect(summaryLabels(view, 'olv-rf-stat-label')).toContain('Highest elevation');
  });

  it('conflicting render origins still degrade to the local frame', () => {
    const view = focusView({ datumKnown: false, verticalDatum: 'NAVD88' });
    expect(heightColumn(view)).toBe('Height (local frame)');
  });

  it('the two surfaces agree heading for heading', () => {
    const scene: Scene = { verticalDatum: null };
    expect(heightColumn(focusView(scene))).toBe(heightColumn(mount(scene)));
    expect(summaryLabels(focusView(scene), 'olv-rf-stat-label')).toEqual(
      summaryLabels(mount(scene), 'olv-mp-summary-label'),
    );
  });
});
