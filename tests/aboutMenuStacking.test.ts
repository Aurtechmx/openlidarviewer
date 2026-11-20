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
const lift = readFileSync(new URL('../src/ui/headerLift.ts', import.meta.url), 'utf8');

describe('the About menu paints above the panels', () => {
  it('lifts the header from the details toggle event, in both directions, through the shared header lift', () => {
    expect(stage).toMatch(
      /about\.addEventListener\('toggle',\s*\(\) => \{\s*setHeaderPopoverOpen\(about,\s*about\.open\);/,
    );
    // Nothing else toggles the class directly, or closing About would drop an open Performance panel.
    expect(stage).not.toMatch(/classList\.toggle\(\s*'olv-topbar-popover-open'/);
  });

  it('uses the lift class the stylesheet defines', () => {
    expect(topbarCss).toMatch(/\.olv-topbar-popover-open\s*\{\s*z-index:\s*var\(--z-popover\)/);
    expect(lift).toMatch(/HEADER_LIFT_CLASS = 'olv-topbar-popover-open'/);
  });
});
