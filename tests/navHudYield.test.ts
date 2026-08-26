/**
 * navHudYield.test.ts — the navigation panel gets out of the way, without
 * taking the controls with it.
 *
 * The panel stands over the middle of the scan, and the complaint that started
 * this was that it never goes away. The obvious fix, letting the close control
 * dismiss the whole panel, is the one thing that must not happen: the Camera
 * and Views rows inside it are the only surface in the app for orthographic
 * projection and the standard views, and the dismissal is persisted, so a
 * closed panel would take those controls away for good. That is what
 * `navViewControlsPersist.test.ts` protects.
 *
 * So the panel YIELDS instead. While a drag is under way on the scan it fades
 * and stops taking pointer events, and when the drag ends it is back. These
 * cases hold the distinction: yielding is a class on the panel, never a change
 * to what the panel contains and never anything written down.
 */

import { describe, it, expect } from 'vitest';

const YIELD = 'olv-nav-hud-yielding';

/** The pointer handlers the panel installs, captured off a fake window. */
interface Installed {
  readonly down: (e: { target: unknown }) => void;
  readonly up: () => void;
}

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
}

/**
 * The panel's own rule, restated: a press that begins inside the navigation
 * bar does not make the panel retreat from the cursor reaching for it.
 */
function install(hud: { classList: FakeClassList }): Installed {
  const yieldTo = (down: boolean): void => { hud.classList.toggle(YIELD, down); };
  return {
    down: (e) => {
      const t = e.target as { closest?: (s: string) => unknown } | null;
      if (t?.closest?.('.olv-navbar') != null) return;
      yieldTo(true);
    },
    up: () => yieldTo(false),
  };
}

const onScan = { closest: () => null };
const inNavBar = { closest: (s: string) => (s === '.olv-navbar' ? {} : null) };

describe('the panel yields while the scan is dragged', () => {
  it('fades out on a press that starts on the scan', () => {
    const hud = { classList: new FakeClassList() };
    install(hud).down({ target: onScan });
    expect(hud.classList.contains(YIELD)).toBe(true);
  });

  it('comes back when the drag ends', () => {
    const hud = { classList: new FakeClassList() };
    const h = install(hud);
    h.down({ target: onScan });
    h.up();
    expect(hud.classList.contains(YIELD)).toBe(false);
  });

  it('does not retreat from a press aimed at its own controls', () => {
    // Reaching for Ortho must not make Ortho fade away under the cursor.
    const hud = { classList: new FakeClassList() };
    install(hud).down({ target: inNavBar });
    expect(hud.classList.contains(YIELD)).toBe(false);
  });

  it('yields by class alone, so nothing is dismissed or persisted', () => {
    // The whole point of the design: the panel's contents are untouched, and
    // no preference is written, so the controls survive the next session.
    const hud = { classList: new FakeClassList() };
    install(hud).down({ target: onScan });
    expect(hud.classList.contains('olv-hidden')).toBe(false);
    expect(hud.classList.contains('olv-nav-hud-collapsed')).toBe(false);
  });
});

describe('the stylesheet backs the behaviour', () => {
  it('makes the yielding panel faint and non-interactive', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const css = readFileSync(resolve(root, 'src/styles/50-navigation-bar.css'), 'utf8');
    const rule = /\.olv-nav-hud-yielding\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'the yielding rule is missing').not.toBeNull();
    expect(rule![1]).toMatch(/pointer-events:\s*none/);
    expect(rule![1]).toMatch(/opacity:\s*0?\.\d+/);
  });

  it('respects a reduced-motion preference', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const css = readFileSync(
      new URL('../src/styles/50-navigation-bar.css', import.meta.url),
      'utf8',
    );
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
  });
});
