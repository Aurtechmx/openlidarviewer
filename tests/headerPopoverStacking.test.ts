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

  it('toggles the lift with the open state, both ways', () => {
    const m = /_setOpenState\(open: boolean\): void \{([\s\S]*?)\n  \}/.exec(control);
    expect(m, '_setOpenState not found').toBeTruthy();
    expect(m![1]).toMatch(/closest\('\.olv-topbar'\)\?\.classList\.toggle\(\s*'olv-topbar-popover-open',\s*open,?\s*\)/);
  });

  it('keeps the header click-through, so the lift steals no clicks', () => {
    expect(topbarCss).toMatch(/\.olv-topbar\s*\{[^}]*pointer-events:\s*none/);
    expect(topbarCss).toMatch(/\.olv-topbar\s*>\s*\*\s*\{\s*pointer-events:\s*auto/);
  });
});
