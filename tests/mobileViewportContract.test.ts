/**
 * mobileViewportContract.test.ts — phone rules that regress silently.
 *
 * These three are stylesheet properties, so nothing throws and no screenshot
 * looks obviously wrong when they break. They surface only on a real phone,
 * which is the slowest possible place to find them. Reading the sheets
 * directly catches a regression at unit speed, and the browser contract in
 * tests/e2e/visualsStudioMobile.spec.ts covers the behaviour on top of this.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLES = fileURLToPath(new URL('../src/styles/', import.meta.url));
const sheets = readdirSync(STYLES).filter((f) => f.endsWith('.css'));
const read = (f: string) => readFileSync(`${STYLES}${f}`, 'utf8');
const ALL = sheets.map((f) => ({ file: f, css: read(f) }));

/** Strip comments so a rule quoted in prose is not read as a declaration. */
const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('full-height on mobile Safari', () => {
  // `100vh` counts the dynamic toolbar, so a full-height element runs under
  // the browser chrome and its last row cannot be reached. Every declaration
  // that asks for a full viewport height needs a `dvh` companion.
  it('pairs every full-viewport height with a dvh companion', () => {
    const offenders: string[] = [];
    for (const { file, css } of ALL) {
      const body = code(css);
      // A full-height request: 100vh used for height or max-height.
      if (!/(?:^|[^-\w])(?:max-)?height:\s*[^;]*\b100vh\b/m.test(body)) continue;
      if (!/\ddvh\b/.test(body)) offenders.push(file);
    }
    expect(offenders, 'sheets asking for 100vh with no dvh companion').toEqual([]);
  });
});

describe('hover on a touch screen', () => {
  // A tap fires :hover and it sticks until the next tap elsewhere, so a
  // control keeps its hover styling indefinitely. The phone stylesheets are
  // reached only by touch devices, so an unguarded :hover there is always
  // wrong. Desktop sheets are out of scope: they legitimately assume a mouse.
  const PHONE_ONLY = ['65-mobile-touch.css', '96-phone-sheet-story.css', '99-mobile-gui-refresh.css'];

  for (const file of PHONE_ONLY) {
    it(`${file} guards every :hover behind a hover-capable query`, () => {
      const body = code(read(file));
      const unguarded: string[] = [];
      let depth = 0;
      let guarded = -1;
      for (const line of body.split('\n')) {
        if (/@media[^{]*\bhover:\s*hover\b/.test(line) && guarded < 0) guarded = depth;
        if (/:hover\b/.test(line) && guarded < 0) unguarded.push(line.trim());
        depth += (line.match(/\{/g) ?? []).length;
        depth -= (line.match(/\}/g) ?? []).length;
        if (guarded >= 0 && depth <= guarded) guarded = -1;
      }
      expect(unguarded, `unguarded :hover in ${file}`).toEqual([]);
    });
  }
});

describe('input zoom on focus', () => {
  // Mobile Safari zooms the whole page when a focused input is under 16px,
  // and the user has to pinch back out. It reads as a font-size preference
  // and behaves like a navigation bug.
  it('never sets a text-input font size below 16px in a phone sheet', () => {
    const offenders: string[] = [];
    for (const file of ['65-mobile-touch.css', '96-phone-sheet-story.css', '99-mobile-gui-refresh.css']) {
      const body = code(read(file));
      const re = /(input|textarea|select)[^{}]*\{[^}]*font-size:\s*([\d.]+)px/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        if (Number(m[2]) < 16) offenders.push(`${file}: ${m[1]} at ${m[2]}px`);
      }
    }
    expect(offenders, 'phone inputs below the 16px zoom threshold').toEqual([]);
  });
});
