/**
 * themeToggle.test.ts
 *
 * The header theme control — a single shape-morphing button that lives in
 * the top bar. Clicking it cycles Blue → Field → High contrast → Blue,
 * keeps keyboard focus, routes the choice through
 * the host's `onChange` callback (which owns `applyTheme` + persistence),
 * and re-labels itself for screen readers. `setTheme` lets an external
 * change (command palette, workflow replay, boot) keep the button in sync
 * WITHOUT re-firing `onChange`.
 *
 * Runs in the node environment (no DOM), driven through a minimal recording
 * stub — the same stub-the-slice approach used in scanTypeControl.test.ts,
 * extended with the surface ThemeToggle touches (button `click`, attribute
 * get/set, dataset, and the per-icon active class the morph toggles).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { ThemeName } from '../src/ui/themes';

type ClickHandler = () => void;

/** A tiny fake element supporting only the surface ThemeToggle touches. */
class FakeEl {
  readonly dataset: Record<string, string> = {};
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly _classes = new Set<string>();
  private readonly _clickHandlers: ClickHandler[] = [];
  innerHTML = '';
  type = '';
  readonly tagName: string;
  readonly classList = {
    add: (...cls: string[]): void => { for (const c of cls) this._classes.add(c); },
    remove: (...cls: string[]): void => { for (const c of cls) this._classes.delete(c); },
    toggle: (cls: string, force?: boolean): void => {
      const on = force === undefined ? !this._classes.has(cls) : force;
      if (on) this._classes.add(cls); else this._classes.delete(cls);
    },
    contains: (cls: string): boolean => this._classes.has(cls),
  };
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string { return [...this._classes].join(' '); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  addEventListener(type: string, fn: ClickHandler): void {
    if (type === 'click') this._clickHandlers.push(fn);
  }
  blurred = 0;
  blur(): void { this.blurred += 1; }
  /** Test helper: simulate a user click. */
  fireClick(): void { for (const fn of this._clickHandlers) fn(); }
  /** Find the first descendant (or self) carrying the given class. */
  find(cls: string): FakeEl | null {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) {
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  /** All descendants (and self) carrying the given class. */
  findAll(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.classList.contains(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findAll(cls));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

/** The currently-lit icon state, read off the per-theme active class. */
function activeIcon(root: FakeEl): ThemeName | null {
  const lit = root.findAll('olv-theme-icon-active');
  if (lit.length !== 1) return null;
  const ds = lit[0].attrs['data-theme'];
  return ds === 'dark' || ds === 'field' || ds === 'high-contrast' ? ds : null;
}

describe('ThemeToggle — Blue, Field and High contrast', () => {
  it('is a button with one icon per palette and the current one lit', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const root = new ThemeToggle({ initial: 'dark' }).element as unknown as FakeEl;
    expect(root.type).toBe('button');
    const themes = root.findAll('olv-theme-icon').map((i) => i.attrs['data-theme']);
    expect(themes).toEqual(['dark', 'field', 'high-contrast']);
    expect(activeIcon(root)).toBe('dark');
  });

  it('cycles Blue → Field → High contrast → Blue and reports each choice', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const seen: ThemeName[] = [];
    const toggle = new ThemeToggle({ initial: 'dark', onChange: (n) => seen.push(n) });
    const root = toggle.element as unknown as FakeEl;
    root.fireClick();
    expect(activeIcon(root)).toBe('field');
    root.fireClick();
    expect(activeIcon(root)).toBe('high-contrast');
    root.fireClick();
    expect(activeIcon(root)).toBe('dark');
    expect(seen).toEqual(['field', 'high-contrast', 'dark']);
    expect(toggle.theme).toBe('dark');
  });

  it.each([
    ['dark', 'Theme: Blue — switch to Field'],
    ['field', 'Theme: Field — switch to High contrast'],
    ['high-contrast', 'Theme: High contrast — switch to Blue'],
  ] as const)('announces the current and next palette from %s', async (initial, label) => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const root = new ThemeToggle({ initial }).element as unknown as FakeEl;
    expect(root.attrs['aria-label']).toBe(label);
    expect(root.attrs['title']).toBe(label);
  });

  it('keeps keyboard focus on the button after a press', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const root = new ThemeToggle({ initial: 'dark' }).element as unknown as FakeEl;
    root.fireClick();
    root.fireClick();
    expect(root.blurred).toBe(0);
  });

  it('setTheme syncs the icon and label without firing onChange', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const seen: ThemeName[] = [];
    const toggle = new ThemeToggle({ initial: 'dark', onChange: (n) => seen.push(n) });
    const root = toggle.element as unknown as FakeEl;
    toggle.setTheme('high-contrast');
    expect(toggle.theme).toBe('high-contrast');
    expect(activeIcon(root)).toBe('high-contrast');
    expect(root.attrs['aria-label']).toContain('switch to Blue');
    expect(seen).toEqual([]);
  });

  it('works without a host callback', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const toggle = new ThemeToggle({ initial: 'field' });
    expect(() => (toggle.element as unknown as FakeEl).fireClick()).not.toThrow();
    expect(toggle.theme).toBe('high-contrast');
  });
});
