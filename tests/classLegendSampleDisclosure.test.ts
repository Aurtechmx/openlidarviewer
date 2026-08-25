/**
 * classLegendSampleDisclosure.test.ts
 *
 * The Classes legend counts the points the loader actually held, so on a cloud
 * strided for display every class figure describes the sample rather than the
 * survey. These tests pin the disclosure, not its wording: a sampled scan gets
 * a visible caption, a fully resident one gets none. Both directions matter —
 * a caption shown unconditionally would be a caveat everywhere and therefore a
 * caveat nowhere, so the absent case is asserted as hard as the present one.
 *
 * Also pinned: the sensor-inference density signal names the area its footprint
 * comes from, since the app computes both a bounding box and a tighter hull and
 * a reader cannot otherwise tell which one the density is over.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ClassLegendPanel } from '../src/ui/ClassLegendPanel';
import { classify } from '../src/diagnostics/provenance';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface the legend touches. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  textContent = '';
  title = '';
  value = '';
  type = '';
  checked = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

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

  private _adopt(kid: unknown): FakeEl[] {
    if (kid instanceof FakeEl) {
      if (kid.tagName === '#fragment') {
        const kids = [...kid.children];
        kid.children.length = 0;
        for (const k of kids) k.parent = this;
        return kids;
      }
      kid.parent?.detach(kid);
      kid.parent = this;
      return [kid];
    }
    const text = new FakeEl('#text');
    text.textContent = String(kid);
    text.parent = this;
    return [text];
  }
  detach(kid: FakeEl): void {
    const at = this.children.indexOf(kid);
    if (at >= 0) this.children.splice(at, 1);
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(...this._adopt(k));
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(...this._adopt(k));
  }
  remove(): void {
    this.parent?.detach(this);
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
  dispatchEvent(evt: { type: string }): boolean {
    for (const fn of [...(this.handlers.get(evt.type) ?? [])]) fn(evt);
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
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createDocumentFragment: () => new FakeEl('#fragment'),
  };
  g.HTMLInputElement = class HTMLInputElement {};
});

/** The per-class counts of the session that motivated this: they sum to the sample. */
const COUNTS = new Map<number, number>([
  [1, 1_059],
  [2, 1_700_456],
  [3, 457_117],
  [4, 426_754],
  [5, 237_263],
  [6, 152_622],
]);
const LOADED = 2_975_271;

/** The sample caption node, or null when the panel never built one. */
function caption(panel: ClassLegendPanel): FakeEl | null {
  return (panel.element as unknown as FakeEl).querySelector('.olv-cl-samplenote');
}

/** Whether the caption is currently visible to the reader. */
function captionShown(panel: ClassLegendPanel): boolean {
  const node = caption(panel);
  return node !== null && !node.classList.contains('olv-hidden');
}

describe('Classes legend — counts name their basis', () => {
  it('a sampled scan labels its class counts as the loaded sample', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(COUNTS, { loaded: LOADED, declared: 47_900_000 });
    expect(captionShown(panel)).toBe(true);
    // Wording is free to change; it must say the counts are of what was loaded.
    expect(caption(panel)?.textContent ?? '').toMatch(/sample/i);
  });

  it('a fully resident scan carries no sample caveat', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(COUNTS, { loaded: LOADED, declared: LOADED });
    expect(captionShown(panel)).toBe(false);
  });

  it('a source that declares no total carries no sample caveat', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(COUNTS, { loaded: LOADED });
    expect(captionShown(panel)).toBe(false);
    panel.setClasses(COUNTS);
    expect(captionShown(panel)).toBe(false);
  });

  it('loading a resident scan after a sampled one clears the caveat', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(COUNTS, { loaded: LOADED, declared: 47_900_000 });
    expect(captionShown(panel)).toBe(true);
    panel.setClasses(COUNTS, { loaded: LOADED, declared: LOADED });
    expect(captionShown(panel)).toBe(false);
  });
});

describe('Capture provenance — the density footprint names its basis', () => {
  it('a drone-scale density signal says which area it is over', () => {
    const f = classify({
      sourceFormat: 'las',
      pointCount: 47_900_000,
      extent: [204.0, 332.3, 60],
      densityPerSqM: 707,
    });
    const signals = f.signals.join(' | ');
    expect(signals).toMatch(/pts\/m²/);
    // The app also computes a tighter hull area, so the figure has to say the
    // basis is the bounding box rather than leaving the reader to guess.
    expect(signals).toMatch(/bounding.box/i);
  });
});
