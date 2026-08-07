import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { STYLE_ORDER, readSection, readAppCss } from './support/appCss';

/**
 * tests/styleCssPartition.test.ts
 *
 * Proof that splitting the 9,004-line src/style.css into src/styles/*.css kept
 * the sheet byte-for-byte. The build concatenates the section files in the
 * order src/styles/index.ts imports them; this test concatenates them the same
 * way and checks the result still equals the original sheet, captured once as a
 * fixture in tests/fixtures/style.css.original.
 *
 * CSS is order-sensitive: at equal specificity a later rule wins. So the split
 * is only safe if it is a PURE, order-preserving partition — no rule reordered,
 * merged, or dropped. If any of those happened, the concatenation would stop
 * matching the fixture and this test would fail, which is the whole point.
 *
 * The fixture is a golden snapshot. When a section file is deliberately edited,
 * regenerate it so it records the current sheet. From the repo root:
 *   (cd src/styles && cat $(grep -oE "\\./[^']+\\.css" index.ts | sed 's|\\./||')) \
 *     > tests/fixtures/style.css.original
 */
const ORIGINAL = readFileSync(
  fileURLToPath(new URL('./fixtures/style.css.original', import.meta.url)),
  'utf8',
);

describe('src/style.css section partition', () => {
  it('reconstructs the original sheet byte-for-byte in import order', () => {
    // The exact-equality guarantee: the split changed file boundaries only.
    expect(readAppCss()).toBe(ORIGINAL);
  });

  it('keeps every section a contiguous slice, in cascade order (no reorder, gap, or drop)', () => {
    // Independent of the check above: walk the sections and require each to sit
    // exactly where the previous one ended, then require full coverage. A
    // reordered or dropped section moves an offset and fails here with a name.
    let cursor = 0;
    for (const name of STYLE_ORDER) {
      const section = readSection(name);
      const at = ORIGINAL.indexOf(section, cursor);
      expect(at, `${name} is not a contiguous slice starting at offset ${cursor}`).toBe(cursor);
      cursor += section.length;
    }
    expect(cursor, 'the sections do not cover the whole sheet').toBe(ORIGINAL.length);
  });

  it('matches the original modulo leading and trailing whitespace at file boundaries', () => {
    // Tolerance for a future editor that only nudges boundary whitespace: strip
    // trailing spaces per line and collapse blank-line runs on BOTH sides, then
    // compare. Real content (selectors, declarations, order) must still match.
    const collapse = (s: string): string =>
      s
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
    expect(collapse(readAppCss())).toBe(collapse(ORIGINAL));
  });
});
