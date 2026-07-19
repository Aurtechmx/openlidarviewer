/**
 * measurePanelStationsLazy.test.ts
 *
 * The Measurements panel renders a per-profile station table inside a collapsed
 * `<details>`. A dense profile has one station row per sample, so building the
 * whole `<tbody>` up front (v0.5 behaviour) spent DOM work on a table most
 * measurements never open. v0.6 perf defers the row build to the first time the
 * disclosure opens (its `toggle` event), then caches it (build exactly once).
 *
 * These tests pin that contract at the DOM level: the `<tbody>` is EMPTY until
 * the `<details>` is opened and POPULATED (one row per sample) afterwards —
 * while the summary count, read from the eagerly-computed row MODEL, is correct
 * from the first render. Reopening never rebuilds or duplicates the rows.
 *
 * Runs in the node environment (the project keeps its unit tests DOM-free for
 * speed), so it drives the real MeasurePanel through a minimal recording DOM
 * stub — the same stub-the-slice approach the other panel tests use, extended
 * with the `<details>.open` / `toggle` / querySelector surface this panel touches.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';

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
  dispatchEvent(evt: { type: string }): boolean {
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
  // el() in dom.ts guards `props.type`/`props.href` with an `instanceof` check;
  // the globals must be defined (as constructors) so the check returns false
  // instead of throwing on an undefined right-hand side.
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.ResizeObserver = FakeResizeObserver;
});

const SAMPLE_COUNT = 40;

/** A profile measurement with a dense, fully-covered station series. */
function profileSummary(): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    profileChart.push({ distance: i * 5, height: 100 + Math.sin(i / 3) * 4, count: 12 });
  }
  return { id: 'p1', kind: 'profile', name: 'Section A', value: '250.00 m', profileChart };
}

interface StationBits {
  panel: MeasurePanel;
  details: FakeEl;
  tbody: FakeEl;
  summary: FakeEl;
}

/** Mount a panel showing a single profile row and return the station-table bits. */
function mountProfilePanel(): StationBits {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  panel.update([profileSummary()]);

  const root = panel.element as unknown as FakeEl;
  const details = root.querySelector('details.olv-mp-stations');
  expect(details).not.toBeNull();
  const tbody = details!.querySelector('tbody');
  const summary = details!.querySelector('summary');
  expect(tbody).not.toBeNull();
  expect(summary).not.toBeNull();
  return { panel, details: details!, tbody: tbody!, summary: summary! };
}

/** Open (or close) the disclosure exactly as a browser does: set state, fire toggle. */
function setOpen(details: FakeEl, open: boolean): void {
  details.open = open;
  details.dispatchEvent({ type: 'toggle' });
}

describe('MeasurePanel — station table rows build lazily on first open', () => {
  it('renders NO station rows until the <details> is opened', () => {
    const { tbody } = mountProfilePanel();
    expect(tbody.querySelectorAll('tr').length).toBe(0);
  });

  it('shows the correct row count in the summary while the body is still unbuilt', () => {
    const { tbody, summary } = mountProfilePanel();
    // The count comes from the eagerly-computed row MODEL, not from the DOM…
    expect(summary.textContent).toContain(`Station table (${SAMPLE_COUNT})`);
    // …while the DOM body is still empty.
    expect(tbody.querySelectorAll('tr').length).toBe(0);
  });

  it('builds one row per sample when the <details> is opened', () => {
    const { details, tbody } = mountProfilePanel();
    setOpen(details, true);
    expect(tbody.querySelectorAll('tr').length).toBe(SAMPLE_COUNT);
    // Each built row carries the five station columns.
    expect(tbody.querySelector('tr')!.querySelectorAll('td').length).toBe(5);
  });

  it('builds the rows exactly once — closing then reopening does not duplicate them', () => {
    const { details, tbody } = mountProfilePanel();
    setOpen(details, true);
    expect(tbody.querySelectorAll('tr').length).toBe(SAMPLE_COUNT);
    setOpen(details, false); // close — cached body stays
    expect(tbody.querySelectorAll('tr').length).toBe(SAMPLE_COUNT);
    setOpen(details, true); // reopen — no rebuild, no duplication
    expect(tbody.querySelectorAll('tr').length).toBe(SAMPLE_COUNT);
  });
});
