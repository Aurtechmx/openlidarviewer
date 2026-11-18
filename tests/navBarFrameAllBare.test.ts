/**
 * navBarFrameAllBare.test.ts — Frame all in the nav row in the bare layouts.
 *
 * Embed (`?embed=1`) and `?ui=minimal` build no workspace shell, so the dock
 * and its Frame all button are never mounted, and the ViewCube has no Home
 * control. The nav row is the one visible surface left there, so it carries
 * Frame all in those layouts. Every other layout shows Frame all once, on the
 * dock, and the nav row has none.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, vi } from 'vitest';

type Listener = () => void;

class FakeClassList {
  private readonly set = new Set<string>();
  add(...c: string[]): void { for (const x of c) this.set.add(x); }
  remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
  contains(c: string): boolean { return this.set.has(c); }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  reset(v: string): void {
    this.set.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this.set.add(c);
  }
}

class FakeEl {
  private _className = '';
  classList = new FakeClassList();
  title = '';
  type = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private readonly listeners: Listener[] = [];
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get className(): string { return this._className; }
  set className(v: string) { this._className = v; this.classList.reset(v); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string { return this._text; }
  append(...kids: (FakeEl | string | null)[]): void {
    for (const k of kids) if (k && typeof k !== 'string') this.children.push(k);
  }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(type: string, fn: Listener): void { if (type === 'click') this.listeners.push(fn); }
  removeEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  focus(): void { /* no-op */ }
  remove(): void { /* no-op */ }
  closest(): null { return null; }
  click(): void { for (const fn of [...this.listeners]) fn(); }
  /** Every descendant (and self) that is a button named `name`. */
  buttonsNamed(name: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.tagName === 'button' && this.attrs['aria-label'] === name) out.push(this);
    for (const c of this.children) out.push(...c.buttonsNamed(name));
    return out;
  }
  byClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.classList.contains(cls)) out.push(this);
    for (const c of this.children) out.push(...c.byClass(cls));
    return out;
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.HTMLAnchorElement ??= class {};
  g.HTMLInputElement ??= class {};
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});

/** A NavBar wired as main.ts wires it, over a viewer whose Frame all is a spy. */
async function navbar(options?: { readonly frameAllButton?: boolean }) {
  const { NavBar } = await import('../src/ui/NavBar');
  const { createNavBarWiring } = await import('../src/ui/navBarWiring');
  const frameAll = vi.fn();
  const viewer = { frameAll } as unknown as import('../src/render/Viewer').Viewer;
  let bar: InstanceType<typeof NavBar> | null = null;
  const wiring = createNavBarWiring({ getViewer: () => viewer, getNavBar: () => bar, toast: () => {} });
  bar = new NavBar(wiring.callbacks, options);
  const row = (bar.element as unknown as FakeEl).byClass('olv-nav-row')[0];
  return { row, frameAll };
}

describe('Frame all in the nav row', () => {
  it('in a bare layout the nav row has a Frame all control that frames the scan', async () => {
    const { row, frameAll } = await navbar({ frameAllButton: true });
    const buttons = row.buttonsNamed('Frame all');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attrs['aria-keyshortcuts']).toBe('R');
    expect(buttons[0].title).toMatch(/\(R\)/);
    buttons[0].click();
    expect(frameAll).toHaveBeenCalledTimes(1);
  });

  it('in every other layout the nav row has no Frame all control', async () => {
    const { row } = await navbar();
    expect(row.buttonsNamed('Frame all')).toHaveLength(0);
    const off = await navbar({ frameAllButton: false });
    expect(off.row.buttonsNamed('Frame all')).toHaveLength(0);
  });

  it('main.ts asks for it in the bare layouts only', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('const bareMode = embed || embedConfig.uiMinimal;');
    expect(main).toContain('new NavBar(navWiring.callbacks, { frameAllButton: bareMode })');
  });
});
