/**
 * headerPopoverStacking.test.ts
 *
 * The Performance panel opened underneath the right rail and read as a control
 * that does nothing. `.olv-topbar` carries its own `z-index`, which makes it a
 * stacking context, so a panel opened from inside it is capped at the header's
 * layer however high its own `z-index` reads: the panel asked for `--z-dock`
 * (20) and painted at the header's 4, under every panel at 15 and 20.
 *
 * The header is lifted while a header popover is open. Asserted on the token
 * ORDER rather than on the numbers, so re-scaling the tokens cannot silently
 * reintroduce the overlap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HEADER_LIFT_CLASS, setHeaderPopoverOpen } from '../src/ui/headerLift';

const tokens = readFileSync(new URL('../src/styles/01-tokens.css', import.meta.url), 'utf8');
const topbarCss = readFileSync(new URL('../src/styles/20-topbar.css', import.meta.url), 'utf8');
const control = readFileSync(new URL('../src/ui/qualityControl.ts', import.meta.url), 'utf8');

const token = (name: string): number => {
  const m = new RegExp(`--${name}:\\s*(\\d+)`).exec(tokens);
  return m ? Number(m[1]) : Number.NaN;
};

describe('a header popover paints above the panels', () => {
  it('lifts the header itself, because its z-index traps its children', () => {
    expect(topbarCss).toMatch(/\.olv-topbar-popover-open\s*\{\s*z-index:\s*var\(--z-popover\)/);
  });

  it('lifts it above both the panel and the dock layers', () => {
    expect(token('z-popover')).toBeGreaterThan(token('z-panel'));
    expect(token('z-popover')).toBeGreaterThan(token('z-dock'));
    // The header's resting layer is the one that trapped the panel.
    expect(token('z-topbar')).toBeLessThan(token('z-panel'));
  });

  it('toggles the lift with the open state, both ways, through the shared header lift', () => {
    const m = /_setOpenState\(open: boolean\): void \{([\s\S]*?)\n  \}/.exec(control);
    expect(m, '_setOpenState not found').toBeTruthy();
    expect(m![1]).toMatch(/setHeaderPopoverOpen\(this\.element,\s*open\)/);
    // Nothing else toggles the class directly, or one popover closing would drop another.
    expect(control).not.toMatch(/classList\.toggle\(\s*'olv-topbar-popover-open'/);
  });

  it('keeps the header click-through, so the lift steals no clicks', () => {
    expect(topbarCss).toMatch(/\.olv-topbar\s*\{[^}]*pointer-events:\s*none/);
    expect(topbarCss).toMatch(/\.olv-topbar\s*>\s*\*\s*\{\s*pointer-events:\s*auto/);
  });
});

describe('the header stays lifted while any header popover is open', () => {
  /** A header node with the two popovers mounted inside it, as `closest` sees them. */
  class Node {
    readonly classes = new Set<string>();
    readonly classList = {
      toggle: (c: string, on: boolean): void => { if (on) this.classes.add(c); else this.classes.delete(c); },
    };
    private readonly parent: Node | null;
    constructor(parent: Node | null, cls = '') {
      this.parent = parent;
      if (cls) this.classes.add(cls);
    }
    closest(sel: string): Node | null {
      for (let n: Node | null = this; n; n = n.parent) if (n.classes.has(sel.slice(1))) return n;
      return null;
    }
  }
  const make = () => {
    const header = new Node(null, 'olv-topbar');
    return { header, about: new Node(header), performance: new Node(header) };
  };
  const lifted = (h: Node): boolean => h.classes.has(HEADER_LIFT_CLASS);
  const set = (n: Node, open: boolean): void => setHeaderPopoverOpen(n as unknown as Element, open);

  it('opening and closing About leaves an open Performance panel above the rails', () => {
    const { header, about, performance } = make();
    set(performance, true);
    expect(lifted(header)).toBe(true);
    set(about, true);
    set(about, false);
    expect(lifted(header)).toBe(true);
    set(performance, false);
    expect(lifted(header)).toBe(false);
  });

  it('the same holds the other way round, and a repeated close changes nothing', () => {
    const { header, about, performance } = make();
    set(about, true);
    set(performance, true);
    set(performance, false);
    set(performance, false);
    expect(lifted(header)).toBe(true);
    set(about, false);
    expect(lifted(header)).toBe(false);
  });

  it('a popover outside any header lifts nothing', () => {
    const loose = new Node(null);
    expect(() => set(loose, true)).not.toThrow();
    set(loose, false);
    expect(lifted(make().header)).toBe(false);
  });

  it('a popover that closes after leaving the page still releases its header', () => {
    const { header, about } = make();
    set(about, true);
    // Detached: closest no longer reaches the header, which was remembered on open.
    (about as unknown as { closest: () => null }).closest = () => null;
    set(about, false);
    expect(lifted(header)).toBe(false);
  });
});
