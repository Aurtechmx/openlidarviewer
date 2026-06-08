/**
 * themeToggle.test.ts
 *
 * The v0.4.3 header theme control — a single shape-morphing button that
 * lives in the top bar (relocated from the Inspector chip rail). Clicking
 * it cycles Dark → Light → High-contrast → Dark, routes the choice through
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
  blur(): void { /* focus is a no-op in the stub */ }
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
  return (ds === 'dark' || ds === 'light' || ds === 'high-contrast') ? ds : null;
}

describe('ThemeToggle — header shape-morphing button', () => {
  it('renders a real <button type="button"> with all three icon states', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const toggle = new ThemeToggle({ initial: 'dark' });
    const root = toggle.element as unknown as FakeEl;
    expect(root.tagName.toLowerCase()).toBe('button');
    expect(root.type).toBe('button');
    expect(root.classList.contains('olv-theme-toggle')).toBe(true);
    // One icon group per theme — the morph cross-fades between them.
    const icons = root.findAll('olv-theme-icon');
    const themes = icons.map((i) => i.attrs['data-theme']).sort();
    expect(themes).toEqual(['dark', 'high-contrast', 'light']);
  });

  it('lights the icon matching the initial theme and labels it', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const toggle = new ThemeToggle({ initial: 'light' });
    const root = toggle.element as unknown as FakeEl;
    expect(activeIcon(root)).toBe('light');
    expect(root.getAttribute('aria-label')).toContain('Light');
    expect(root.getAttribute('aria-label')!.toLowerCase()).toContain('change');
  });

  it('cycles dark → light → high-contrast → dark on click', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const seen: ThemeName[] = [];
    const toggle = new ThemeToggle({ initial: 'dark', onChange: (n) => seen.push(n) });
    const root = toggle.element as unknown as FakeEl;

    root.fireClick();
    expect(activeIcon(root)).toBe('light');
    root.fireClick();
    expect(activeIcon(root)).toBe('high-contrast');
    root.fireClick();
    expect(activeIcon(root)).toBe('dark');

    expect(seen).toEqual(['light', 'high-contrast', 'dark']);
  });

  it('fires onChange with the next theme name on each click', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const seen: ThemeName[] = [];
    const toggle = new ThemeToggle({ initial: 'high-contrast', onChange: (n) => seen.push(n) });
    const root = toggle.element as unknown as FakeEl;
    root.fireClick(); // high-contrast → dark
    root.fireClick(); // dark → light
    expect(seen).toEqual(['dark', 'light']);
  });

  it('updates the aria-label to name the current theme on each cycle', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const toggle = new ThemeToggle({ initial: 'dark' });
    const root = toggle.element as unknown as FakeEl;
    expect(root.getAttribute('aria-label')).toContain('Dark');
    root.fireClick();
    expect(root.getAttribute('aria-label')).toContain('Light');
    root.fireClick();
    expect(root.getAttribute('aria-label')).toContain('High contrast');
  });

  it('sets a title tooltip that tracks the current theme', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    const toggle = new ThemeToggle({ initial: 'dark' });
    const root = toggle.element as unknown as FakeEl;
    expect(root.getAttribute('title')).toContain('Dark');
    root.fireClick();
    expect(root.getAttribute('title')).toContain('Light');
  });

  it('setTheme updates the icon + label without firing onChange', async () => {
    const { ThemeToggle } = await import('../src/ui/ThemeToggle');
    let fired = 0;
    const toggle = new ThemeToggle({ initial: 'dark', onChange: () => { fired++; } });
    const root = toggle.element as unknown as FakeEl;

    toggle.setTheme('high-contrast');
    expect(activeIcon(root)).toBe('high-contrast');
    expect(root.getAttribute('aria-label')).toContain('High contrast');
    expect(fired).toBe(0);

    // And a subsequent click resumes the cycle from the externally-set value.
    root.fireClick();
    expect(activeIcon(root)).toBe('dark');
    expect(fired).toBe(1);
  });
});
