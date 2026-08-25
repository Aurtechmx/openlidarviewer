/**
 * profileAxisLabelBounds.test.ts — the axis fit's two constants stay bounds.
 *
 * The chart's label fit runs before the overlay is in a document, so it cannot
 * measure the chart or the text. It uses two constants instead, and each is
 * only correct as a BOUND: the chart width must be the narrowest the chart can
 * be, and the per-character width the widest a label can be. Rounded the other
 * way, the fit believes there is room that is not there and keeps a pair that
 * overprints, which is the defect the fit exists to remove.
 *
 * A first version of this fit used 236px and 6.2px per character. The chart's
 * CSS floor is 180px and the widest measured label is 6.74px per character, so
 * both were wrong in the direction that overprints. These cases hold each
 * constant to the source it was taken from.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const panel = read('src/ui/MeasurePanel.ts');
const css = read('src/styles/74-inspector-profile.css');

/** A numeric constant declared in the panel. */
function constant(name: string): number {
  const m = new RegExp(`const ${name} = ([0-9.]+);`).exec(panel);
  expect(m, `${name} not declared`).not.toBeNull();
  return Number(m![1]);
}

describe('the axis label fit uses bounds, not estimates', () => {
  it('fits against the chart width CSS actually permits', () => {
    // Read from the stylesheet so a narrower chart cannot be shipped without
    // this failing. Widening the chart is safe and does not.
    const m = /\.olv-mp-chart\s*\{[^}]*?min-width:\s*(\d+)px/s.exec(css);
    expect(m, 'olv-mp-chart min-width not found').not.toBeNull();
    expect(constant('MIN_CHART_PX')).toBeLessThanOrEqual(Number(m![1]));
  });

  it('states the font size the labels are actually drawn at', () => {
    // The width estimate is per em, so the size it is multiplied by has to be
    // the size the stylesheet gives `.olv-mp-axis`. A stale figure here
    // understates every label at once.
    const m = /\.olv-mp-axis\s*\{[^}]*?font-size:\s*var\(--text-xs\)/s.exec(css);
    expect(m, 'olv-mp-axis font-size is not --text-xs').not.toBeNull();
    const token = /--text-xs:\s*(\d+(?:\.\d+)?)px/.exec(
      read('src/styles/01-tokens.css'),
    );
    expect(token, '--text-xs not declared').not.toBeNull();
    expect(constant('AXIS_FONT_PX')).toBe(Number(token![1]));
  });
});
