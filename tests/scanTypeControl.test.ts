/**
 * scanTypeControl.test.ts
 *
 * The reusable "Treat as" control wired into both the Object/Space panel and
 * the terrain Analyse panel. It renders the four options (Auto / Terrain /
 * Object / Interior), reflects the current override state, surfaces a subtle
 * "(manual)" note when overridden, and fires a change callback.
 *
 * Runs in the node environment (no DOM), so it drives the builder through a
 * minimal recording DOM stub — the same stub-the-slice approach used in
 * tests/objectPanelSpace.test.ts, extended with the `<select>`/`<option>`
 * surface (value + a fireChange helper) the control touches.
 */

import { describe, it, expect, beforeAll } from 'vitest';

type ChangeHandler = () => void;

/** A tiny fake element supporting only the surface the control touches. */
class FakeEl {
  title = '';
  value = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  private readonly _classes = new Set<string>();
  private readonly _changeHandlers: ChangeHandler[] = [];
  readonly tagName: string;
  readonly classList = {
    toggle: (cls: string, force?: boolean): void => {
      const on = force === undefined ? !this._classes.has(cls) : force;
      if (on) this._classes.add(cls); else this._classes.delete(cls);
    },
    contains: (cls: string): boolean => this._classes.has(cls),
  };
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  // `className =` (whitespace-separated) is the canonical source for the class
  // set so `classList.contains` and `find` see classes set either way.
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string { return [...this._classes].join(' '); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(type: string, fn: ChangeHandler): void {
    if (type === 'change') this._changeHandlers.push(fn);
  }
  /** Test helper: simulate the user picking `value` and firing 'change'. */
  fireChange(value: string): void {
    this.value = value;
    for (const fn of this._changeHandlers) fn();
  }
  /** Find the first descendant (or self) with the given class. */
  find(cls: string): FakeEl | null {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) {
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe('createScanTypeControl', () => {
  it('renders the four options Auto / Terrain / Object / Interior', async () => {
    const { createScanTypeControl } = await import('../src/ui/scanTypeControl');
    const control = createScanTypeControl({ onChange: () => { /* noop */ } });
    const root = control.element as unknown as FakeEl;
    const select = root.find('olv-scan-type-select');
    expect(select).not.toBeNull();
    const labels = select!.children.map((o) => o.textContent);
    expect(labels).toEqual(['Auto', 'Terrain', 'Object', 'Interior']);
    expect(root.textContent).toContain('Treat as');
  });

  it('reflects the current override and shows "(manual)" only when overridden', async () => {
    const { createScanTypeControl } = await import('../src/ui/scanTypeControl');
    const control = createScanTypeControl({ onChange: () => { /* noop */ } });
    const root = control.element as unknown as FakeEl;
    const select = root.find('olv-scan-type-select')!;
    const note = root.find('olv-scan-type-note')!;

    // Default: auto, no manual note.
    control.set('auto', 'object');
    expect(select.value).toBe('auto');
    expect(note.classList.contains('olv-hidden')).toBe(true);

    // Overridden: value reflects the choice, manual note is shown.
    control.set('interior', 'interior');
    expect(select.value).toBe('interior');
    expect(note.classList.contains('olv-hidden')).toBe(false);
    expect(note.textContent).toContain('manual');
  });

  it('fires the change callback with the picked override', async () => {
    const { createScanTypeControl } = await import('../src/ui/scanTypeControl');
    const seen: string[] = [];
    const control = createScanTypeControl({ onChange: (o) => seen.push(o) });
    const root = control.element as unknown as FakeEl;
    const select = root.find('olv-scan-type-select')!;

    select.fireChange('interior');
    select.fireChange('auto');
    expect(seen).toEqual(['interior', 'auto']);
  });
});
