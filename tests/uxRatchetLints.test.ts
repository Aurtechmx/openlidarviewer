/**
 * uxRatchetLints.test.ts: the counting rules behind lint:style-tokens,
 * lint:tooltip-length and lint:ux-rules (COMMUNITY_SPEC.md §11.3).
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ES module script without type declarations
import { countStyleLiterals } from '../scripts/lint-style-tokens.mjs';
// @ts-expect-error: plain ES module script without type declarations
import { findTooltips, LIMIT } from '../scripts/lint-tooltip-length.mjs';
// @ts-expect-error: plain ES module script without type declarations
import { findNestedDetails } from '../scripts/lint-ux-rules.mjs';

describe('lint:style-tokens counting', () => {
  it('counts hex and colour calls in values, never an id selector or a comment', () => {
    const css = '#add { color: #fff; background: rgba(0, 0, 0, 0.5); }\n/* #123456 */\n.a { border: 1px solid hsl(0 0% 50%); }';
    expect(countStyleLiterals(css)).toEqual({ colours: 3, pxFonts: 0 });
  });
  it('counts a px font size in font and font-size, but not a token', () => {
    const css = '.a { font-size: 12px; } .b { font: 600 13px var(--font); } .c { font-size: var(--text-sm); } .d { width: 12px; }';
    expect(countStyleLiterals(css)).toEqual({ colours: 0, pxFonts: 2 });
  });
});

describe('lint:tooltip-length measurement', () => {
  it('measures joined literals of an el() title or tip, and skips other keys and variables', () => {
    const src = [
      "el('button', { text: 'Go', title: 'Hello ' + 'there' });",
      "el('span', { tip: `Count ${n} items` });",
      "el('div', { title: someVar });",
      "const action = { title: 'Not a tooltip' };",
      "b.setAttribute('title', 'Attr tip');",
    ].join('\n');
    expect(findTooltips(src).map((t: { text: string }) => t.text)).toEqual(['Hello there', 'Count  items', 'Attr tip']);
  });
  it('holds the 160-character limit the spec names', () => {
    expect(LIMIT).toBe(160);
  });
});

describe('lint:ux-rules UX-D4', () => {
  it('flags a details written inside another, and passes siblings', () => {
    expect(findNestedDetails("el('details', {}, [el('summary', {}), el('details', {})]);")).toHaveLength(1);
    expect(findNestedDetails('const s = `<details><details></details></details>`;')).toHaveLength(1);
    expect(findNestedDetails("el('details', {}); el('details', {});")).toHaveLength(0);
    expect(findNestedDetails("// el('details', { el('details' })\nel('details', {});")).toHaveLength(0);
  });
});
