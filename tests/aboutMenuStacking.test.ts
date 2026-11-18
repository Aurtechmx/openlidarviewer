/**
 * aboutMenuStacking.test.ts
 *
 * The About menu's panel opens from inside `.olv-topbar`, whose own z-index
 * traps it below the right rail. Like the Performance panel, the header is
 * lifted while the menu is open: the lift is toggled from the <details>
 * `toggle` event, both ways, and rides the same `olv-topbar-popover-open`
 * class that headerPopoverStacking.test.ts holds above the panel layers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const stage = readFileSync(new URL('../src/ui/Stage.ts', import.meta.url), 'utf8');
const topbarCss = readFileSync(new URL('../src/styles/20-topbar.css', import.meta.url), 'utf8');

describe('the About menu paints above the panels', () => {
  it('lifts the header from the details toggle event, in both directions', () => {
    expect(stage).toMatch(
      /about\.addEventListener\('toggle',\s*\(\) => \{\s*about\.closest\('\.olv-topbar'\)\?\.classList\.toggle\('olv-topbar-popover-open',\s*about\.open\);/,
    );
  });

  it('uses the lift class the stylesheet defines', () => {
    expect(topbarCss).toMatch(/\.olv-topbar-popover-open\s*\{\s*z-index:\s*var\(--z-popover\)/);
  });
});
