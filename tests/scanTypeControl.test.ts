/**
 * scanTypeControl.test.ts
 *
 * The reusable "Treat scan as" control wired into both the Object/Space panel
 * and the terrain Analyse panel. It now renders a VISIBLE segmented selector —
 * Terrain · Object · Interior · Auto — highlights the active segment, surfaces a
 * subtle "(manual)" note when overridden, and fires a change callback on click.
 *
 * Runs in the node environment (no DOM), so it drives the builder through a
 * minimal recording DOM stub — the same stub-the-slice approach used in
 * tests/objectPanelSpace.test.ts, here covering buttons (dataset + click).
 */

import { describe, it, expect, beforeAll } from 'vitest';

type Handler = () => void;

/** A tiny fake element supporting only the surface the control touches. */
class FakeEl {
  title = '';
  type = '';
  private _text = '';
  readonly dataset: Record<string, string> = {};
  private readonly _attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  private readonly _classes = new Set<string>();
  private readonly _handlers = new Map<string, Handler[]>();
  readonly tagName: string;
  readonly classList = {
    toggle: (cls: string, force?: boolean): void => {
      const on = force === undefined ? !this._classes.has(cls) : force;
      if (on) this._classes.add(cls); else this._classes.delete(cls);
    },
    contains: (cls: string): boolean => this._classes.has(cls),
  };
  constructor(tagName: string) { this.tagName = tagName; }
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string { return [...this._classes].join(' '); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  setAttribute(k: string, v: string): void { this._attrs.set(k, v); }
  getAttribute(k: string): string | null { return this._attrs.get(k) ?? null; }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  addEventListener(type: string, fn: Handler): void {
    const list = this._handlers.get(type) ?? [];
    list.push(fn); this._handlers.set(type, list);
  }
  /** Test helper: simulate a click. */
  click(): void { for (const fn of this._handlers.get('click') ?? []) fn(); }
  /** Find the first descendant (or self) with the given class. */
  find(cls: string): FakeEl | null {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) { const hit = c.find(cls); if (hit) return hit; }
    return null;
  }
  /** All descendants (and self) with the given class. */
  findAll(cls: string, acc: FakeEl[] = []): FakeEl[] {
    if (this.classList.contains(cls)) acc.push(this);
    for (const c of this.children) c.findAll(cls, acc);
    return acc;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

async function build(onChange: (o: string) => void = () => { /* noop */ }) {
  const { createScanTypeControl } = await import('../src/ui/scanTypeControl');
  const control = createScanTypeControl({ onChange: onChange as never });
  return { control, root: control.element as unknown as FakeEl };
}

describe('createScanTypeControl', () => {
  it('renders the four segments Terrain · Object · Interior · Auto', async () => {
    const { root } = await build();
    const opts = root.findAll('olv-scan-type-opt');
    expect(opts.map((o) => o.textContent)).toEqual(['Terrain', 'Object', 'Interior', 'Auto']);
    expect(opts.map((o) => o.dataset.value)).toEqual(['terrain', 'object', 'interior', 'auto']);
    expect(root.textContent).toContain('Treat scan as');
    // All are real buttons.
    expect(opts.every((o) => o.type === 'button')).toBe(true);
  });

  it('highlights the active segment and shows "(manual)" only when overridden', async () => {
    const { control, root } = await build();
    const note = root.find('olv-scan-type-note')!;
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;

    control.set('auto', 'object');
    expect(byVal('auto').classList.contains('is-active')).toBe(true);
    expect(byVal('interior').classList.contains('is-active')).toBe(false);
    expect(note.classList.contains('olv-hidden')).toBe(true);

    control.set('interior', 'interior');
    expect(byVal('interior').classList.contains('is-active')).toBe(true);
    expect(byVal('interior').getAttribute('aria-pressed')).toBe('true');
    expect(byVal('auto').classList.contains('is-active')).toBe(false);
    expect(note.classList.contains('olv-hidden')).toBe(false);
    expect(note.textContent).toContain('manual');
  });

  it('fires the change callback with the clicked segment value', async () => {
    const seen: string[] = [];
    const { root } = await build((o) => seen.push(o));
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    byVal('interior').click();
    byVal('terrain').click();
    byVal('auto').click();
    expect(seen).toEqual(['interior', 'terrain', 'auto']);
  });
});
