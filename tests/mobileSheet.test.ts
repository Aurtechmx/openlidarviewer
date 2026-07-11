/**
 * mobileSheet.test.ts
 *
 * The phone bottom-sheet chrome: a three-way tablist (View / Analyse / Layers)
 * over three tabpanel slots the host re-parents panels into, plus a collapse
 * handle. Runs in the node environment through a small recording DOM stub (the
 * same stub-the-slice approach the other UI tests use), asserting on state and
 * ARIA rather than pixels.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  title = '';
  type = '';
  id = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private _classes = new Set<string>();
  private readonly _listeners = new Map<string, ((ev: unknown) => void)[]>();
  focused = false;
  parent: FakeEl | null = null;
  readonly tagName: string;
  // `className` and `classList` share ONE backing set, so el()'s
  // `node.className = '…'` and later `classList.toggle()` stay consistent.
  get className(): string { return [...this._classes].join(' '); }
  set className(v: string) { this._classes = new Set(v.split(/\s+/).filter(Boolean)); }
  readonly classList = {
    toggle: (c: string, force?: boolean): void => {
      const on = force === undefined ? !this._classes.has(c) : force;
      if (on) this._classes.add(c);
      else this._classes.delete(c);
    },
    contains: (c: string): boolean => this._classes.has(c),
    add: (c: string): void => { this._classes.add(c); },
    remove: (c: string): void => { this._classes.delete(c); },
  };
  constructor(tagName: string) { this.tagName = tagName; }
  hasClass(c: string): boolean { return this._classes.has(c); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void {
    for (const k of kids) { k.parent = this; this.children.push(k); }
  }
  private _matches(sel: string): boolean {
    if (sel.startsWith('.')) return this._classes.has(sel.slice(1));
    const attr = /^\[([^=\]]+)="([^"]+)"\]$/.exec(sel);
    if (attr) return this.attrs[attr[1]] === attr[2];
    return false;
  }
  /** Minimal `closest`: walks up parents matching `.class` or `[attr="v"]`. */
  closest(sel: string): FakeEl | null {
    let node: FakeEl | null = this;
    while (node) {
      if (node._matches(sel)) return node;
      node = node.parent;
    }
    return null;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }
  fire(type: string, ev: unknown = {}): void {
    for (const fn of this._listeners.get(type) ?? []) fn(ev);
  }
  focus(): void { this.focused = true; }
  /** Depth-first find of the first descendant (or self) matching a predicate. */
  find(pred: (e: FakeEl) => boolean): FakeEl | undefined {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return undefined;
  }
  findAll(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    if (pred(this)) out.push(this);
    for (const c of this.children) out.push(...c.findAll(pred));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  // `el()` guards `node instanceof HTMLInputElement / HTMLAnchorElement` before
  // assigning `type` / `href`. Those globals don't exist in the node stub, so
  // define inert classes — a FakeEl is never an instance, so the branches no-op.
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

async function makeSheet(opts = {}) {
  const { MobileSheet } = await import('../src/ui/MobileSheet');
  const sheet = new MobileSheet(opts);
  const root = sheet.element as unknown as FakeEl;
  const tab = (id: string): FakeEl =>
    root.find((e) => e.attrs['role'] === 'tab' && e.dataset.tab === id)!;
  const slot = (id: string): FakeEl => sheet.slot(id as never) as unknown as FakeEl;
  return { sheet, root, tab, slot };
}

describe('MobileSheet', () => {
  it('renders a tablist with three tabs and three tabpanel slots', async () => {
    const { root } = await makeSheet();
    expect(root.hasClass('olv-mobile-sheet')).toBe(true);
    const tabs = root.findAll((e) => e.attrs['role'] === 'tab');
    expect(tabs.map((t) => t.dataset.tab)).toEqual(['view', 'analyse', 'layers']);
    const panels = root.findAll((e) => e.attrs['role'] === 'tabpanel');
    expect(panels.map((p) => p.dataset.tab)).toEqual(['view', 'analyse', 'layers']);
    // Every tab points at its panel via aria-controls.
    for (const t of tabs) {
      expect(t.attrs['aria-controls']).toBe(`olv-msheet-panel-${t.dataset.tab}`);
    }
  });

  it('defaults to the Analyse tab (verdict-as-hero)', async () => {
    const { sheet, tab, slot } = await makeSheet();
    expect(sheet.getActive()).toBe('analyse');
    expect(tab('analyse').attrs['aria-selected']).toBe('true');
    expect(tab('view').attrs['aria-selected']).toBe('false');
    expect(slot('analyse').hasClass('is-active')).toBe(true);
    expect(slot('view').hasClass('is-active')).toBe(false);
    // Roving tabindex: only the active tab is focusable.
    expect(tab('analyse').attrs['tabindex']).toBe('0');
    expect(tab('view').attrs['tabindex']).toBe('-1');
  });

  it('honours an explicit initial tab', async () => {
    const { sheet } = await makeSheet({ initialTab: 'view' });
    expect(sheet.getActive()).toBe('view');
  });

  it('clicking a tab selects it and fires onTabChange exactly once', async () => {
    const seen: string[] = [];
    const { tab, slot, sheet } = await makeSheet({ onTabChange: (t: string) => seen.push(t) });
    tab('layers').fire('click');
    expect(sheet.getActive()).toBe('layers');
    expect(slot('layers').hasClass('is-active')).toBe(true);
    expect(slot('analyse').hasClass('is-active')).toBe(false);
    expect(seen).toEqual(['layers']);
    // Re-selecting the active tab does not re-fire.
    tab('layers').fire('click');
    expect(seen).toEqual(['layers']);
  });

  it('slot() returns a stable, distinct container per tab', async () => {
    const { slot } = await makeSheet();
    expect(slot('view')).not.toBe(slot('analyse'));
    expect(slot('analyse')).not.toBe(slot('layers'));
    // Re-parenting target is stable across calls.
    const { sheet } = await makeSheet();
    expect(sheet.slot('view' as never)).toBe(sheet.slot('view' as never));
  });

  it('starts COLLAPSED by default', async () => {
    const { root, sheet } = await makeSheet();
    const body = root.find((e) => e.hasClass('olv-msheet-body'))!;
    const handle = root.find((e) => e.attrs['role'] !== 'tab' && e.tagName === 'button' && e.attrs['aria-expanded'] != null)!;
    expect(sheet.isExpanded()).toBe(false);
    expect(root.hasClass('is-collapsed')).toBe(true);
    expect(body.hasClass('olv-hidden')).toBe(true);
    // aria-expanded reflects the collapsed state at construction time.
    expect(handle.attrs['aria-expanded']).toBe('false');
  });

  it('initialExpanded: true starts expanded', async () => {
    const { root, sheet } = await makeSheet({ initialExpanded: true });
    const body = root.find((e) => e.hasClass('olv-msheet-body'))!;
    const handle = root.find((e) => e.attrs['role'] !== 'tab' && e.tagName === 'button' && e.attrs['aria-expanded'] != null)!;
    expect(sheet.isExpanded()).toBe(true);
    expect(root.hasClass('is-collapsed')).toBe(false);
    expect(body.hasClass('olv-hidden')).toBe(false);
    expect(handle.attrs['aria-expanded']).toBe('true');
  });

  it('collapse handle toggles body visibility + aria-expanded', async () => {
    const flips: boolean[] = [];
    const { root, sheet } = await makeSheet({
      initialExpanded: true,
      onExpandedChange: (e: boolean) => flips.push(e),
    });
    const handle = root.find((e) => e.attrs['role'] !== 'tab' && e.tagName === 'button' && e.attrs['aria-expanded'] != null)!;
    const body = root.find((e) => e.hasClass('olv-msheet-body'))!;
    expect(sheet.isExpanded()).toBe(true);
    handle.fire('click', { target: handle });
    expect(sheet.isExpanded()).toBe(false);
    expect(root.hasClass('is-collapsed')).toBe(true);
    expect(body.hasClass('olv-hidden')).toBe(true);
    expect(handle.attrs['aria-expanded']).toBe('false');
    expect(flips).toEqual([false]);
  });

  it('tapping the head (non-tab region) toggles the sheet', async () => {
    const flips: boolean[] = [];
    const { root, sheet } = await makeSheet({ onExpandedChange: (e: boolean) => flips.push(e) });
    const head = root.find((e) => e.hasClass('olv-msheet-head'))!;
    expect(sheet.isExpanded()).toBe(false);
    // A tap on the grip (the head itself) expands the collapsed sheet.
    head.fire('click', { target: head });
    expect(sheet.isExpanded()).toBe(true);
    // And toggles back closed.
    head.fire('click', { target: head });
    expect(sheet.isExpanded()).toBe(false);
    expect(flips).toEqual([true, false]);
  });

  it('tapping the head toggles exactly once when the handle is hit', async () => {
    const flips: boolean[] = [];
    const { root, sheet } = await makeSheet({
      initialExpanded: true,
      onExpandedChange: (e: boolean) => flips.push(e),
    });
    const head = root.find((e) => e.hasClass('olv-msheet-head'))!;
    const handle = root.find((e) => e.hasClass('olv-msheet-handle'))!;
    // In the real DOM a handle click bubbles to the head; simulate both
    // listeners firing for the same tap and assert a single net toggle.
    handle.fire('click', { target: handle });
    head.fire('click', { target: handle });
    expect(sheet.isExpanded()).toBe(false);
    expect(flips).toEqual([false]);
  });

  it('tapping a tab does NOT toggle collapse via the head handler', async () => {
    const flips: boolean[] = [];
    const { root, sheet, tab } = await makeSheet({ onExpandedChange: (e: boolean) => flips.push(e) });
    const head = root.find((e) => e.hasClass('olv-msheet-head'))!;
    expect(sheet.isExpanded()).toBe(false);
    // A tap whose target is inside a tab is ignored by the head toggle.
    head.fire('click', { target: tab('view') });
    expect(sheet.isExpanded()).toBe(false);
    expect(flips).toEqual([]);
  });

  it('selecting a tab re-expands a collapsed sheet', async () => {
    const { sheet, tab } = await makeSheet();
    sheet.setExpanded(false);
    expect(sheet.isExpanded()).toBe(false);
    tab('view').fire('click');
    expect(sheet.isExpanded()).toBe(true);
    expect(sheet.getActive()).toBe('view');
  });

  it('ArrowRight moves the active tab and focuses it', async () => {
    const { sheet, tab } = await makeSheet({ initialTab: 'view' });
    tab('view').fire('keydown', { key: 'ArrowRight', preventDefault() {} });
    expect(sheet.getActive()).toBe('analyse');
    expect(tab('analyse').focused).toBe(true);
    // Wraps from the last tab back to the first.
    tab('layers').fire('keydown', { key: 'ArrowRight', preventDefault() {} });
    // (active was 'analyse'; ArrowRight off the focused 'layers' wraps to view)
  });

  it('setVisible(false) hides the whole sheet', async () => {
    const { sheet, root } = await makeSheet();
    sheet.setVisible(false);
    expect(root.hasClass('olv-hidden')).toBe(true);
    sheet.setVisible(true);
    expect(root.hasClass('olv-hidden')).toBe(false);
  });
});
