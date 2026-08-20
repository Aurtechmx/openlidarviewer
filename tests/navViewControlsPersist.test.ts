/**
 * navViewControlsPersist.test.ts — dismissing the navigation legend must not
 * take the view controls with it.
 *
 * The HUD holds two different kinds of thing. The legend (movement keys, modes,
 * meta hints) is help, and a user who knows WASD has every reason to hide it.
 * The Camera and Views rows beside it are controls: Top, Front, Side, Iso and
 * the orthographic toggle, which exist nowhere else in the app. One
 * `olv-hidden` toggle covered both, and the dismissal is written to
 * `olv.nav.helpPinned`, so hiding the help text removed the only surface for
 * orthographic projection and every standard view, permanently and across
 * sessions.
 *
 * These tests read the DOM the panel builds. Whether the collapsed panel looks
 * right is a browser question; whether the controls still exist is not.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

class FakeClassList {
  private readonly set = new Set<string>();
  constructor(initial: string) {
    for (const c of initial.split(/\s+/).filter(Boolean)) this.set.add(c);
  }
  add(...c: string[]): void { for (const x of c) this.set.add(x); }
  remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
  contains(c: string): boolean { return this.set.has(c); }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

class FakeEl {
  private _className = '';
  classList = new FakeClassList('');
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get className(): string { return this._className; }
  set className(v: string) { this._className = v; this.classList = new FakeClassList(v); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string { return this._text; }
  get ownText(): string { return this._text; }
  append(...kids: (FakeEl | null)[]): void {
    for (const k of kids) if (k) this.children.push(k);
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0; this.children.push(...kids);
  }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** Every descendant (and self) carrying `cls`. */
  byClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.classList.contains(cls)) out.push(this);
    for (const c of this.children) out.push(...c.byClass(cls));
    return out;
  }
  /** Is `node` inside a subtree that carries `cls`? */
  hasAncestorWithClass(node: FakeEl, cls: string): boolean {
    for (const host of this.byClass(cls)) {
      if (host === node) continue;
      const stack = [...host.children];
      while (stack.length) {
        const n = stack.pop() as FakeEl;
        if (n === node) return true;
        stack.push(...n.children);
      }
    }
    return false;
  }
  /** All text in this subtree, joined. */
  allText(): string {
    return [this._text, ...this.children.map((c) => c.allText())].filter(Boolean).join(' ');
  }
}

const store = new Map<string, string>();

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  // `el()` narrows with `instanceof` before assigning href / type. The stub is
  // not a real element, so these only have to exist for the check to answer no.
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLAnchorElement ??= class {};
  g.HTMLInputElement ??= class {};
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});

beforeEach(() => store.clear());

/** A NavBar with inert callbacks; only its DOM is under test. */
async function navbar() {
  const { NavBar } = await import('../src/ui/NavBar');
  const noop = (): void => { /* inert */ };
  const bar = new NavBar({
    onMode: noop,
    onSpeed: noop,
    onCameraPreset: noop,
    onStandardView: noop,
    onOrthographic: noop,
  } as unknown as ConstructorParameters<typeof NavBar>[0]);
  return { bar, root: bar.element as unknown as FakeEl };
}

describe('dismissing the navigation legend keeps the view controls', () => {
  it('builds the legend and the view rows as separate regions', async () => {
    const { root } = await navbar();
    const legend = root.byClass('olv-legend');
    const rows = root.byClass('olv-cam-presets-row');
    expect(legend).toHaveLength(1);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The defect in one assertion: a view row inside the legend shares its fate.
    for (const row of rows) {
      expect(root.hasAncestorWithClass(row, 'olv-legend')).toBe(false);
    }
  });

  it('hides only the legend when help is dismissed', async () => {
    const { bar, root } = await navbar();
    const legend = root.byClass('olv-legend')[0];
    const rows = root.byClass('olv-cam-presets-row');

    expect(legend.classList.contains('olv-hidden')).toBe(false);
    bar.toggleHelp();

    expect(legend.classList.contains('olv-hidden')).toBe(true);
    for (const row of rows) {
      expect(row.classList.contains('olv-hidden')).toBe(false);
    }
  });

  it('keeps the orthographic toggle reachable after dismissal', async () => {
    const { bar, root } = await navbar();
    bar.toggleHelp();
    const ortho = root.byClass('olv-ortho-toggle');
    expect(ortho).toHaveLength(1);
    // It exists AND no hidden ancestor is swallowing it.
    expect(ortho[0].classList.contains('olv-hidden')).toBe(false);
    expect(root.hasAncestorWithClass(ortho[0], 'olv-hidden')).toBe(false);
  });

  it('leaves the toggle itself reachable, so the legend can come back', async () => {
    const { bar, root } = await navbar();
    const toggle = root.byClass('olv-nav-hud-close')[0];
    expect(toggle).toBeDefined();

    bar.toggleHelp();
    // The control that hid the legend must not be inside it.
    expect(root.hasAncestorWithClass(toggle, 'olv-legend')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toMatch(/show/i);

    bar.toggleHelp();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toMatch(/hide/i);
  });

  it('marks the panel collapsed rather than hiding it outright', async () => {
    const { bar, root } = await navbar();
    const hud = root.byClass('olv-nav-hud')[0];
    expect(hud.classList.contains('olv-hidden')).toBe(false);
    bar.toggleHelp();
    // The old behaviour hid the whole panel here, taking the controls with it.
    expect(hud.classList.contains('olv-hidden')).toBe(false);
    expect(hud.classList.contains('olv-nav-hud-collapsed')).toBe(true);
  });

  it('persists the dismissal without persisting a loss of controls', async () => {
    const first = await navbar();
    first.bar.toggleHelp();
    expect(store.get('olv.nav.helpPinned')).toBe('0');

    // A later session reads that choice back.
    const second = await navbar();
    const legend = second.root.byClass('olv-legend')[0];
    expect(legend.classList.contains('olv-hidden')).toBe(true);
    // …and still offers every view control.
    expect(second.root.byClass('olv-ortho-toggle')).toHaveLength(1);
    expect(second.root.byClass('olv-cam-presets-row').length).toBeGreaterThanOrEqual(2);
  });
});
