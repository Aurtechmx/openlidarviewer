/**
 * stateTokenContrast.test.ts: the withheld state colour (CE-STRIP-04).
 *
 * Withheld had borrowed the blocked violet, so the two states differed only by
 * word. It now has its own token. The glyph and word still carry the state;
 * this pins that the new colour differs from blocked and stays readable as
 * text on every rail's page and panel (WCAG AA, 4.5:1).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = readFileSync(resolve(ROOT, 'src/styles/01-tokens.css'), 'utf8');
const rails = readFileSync(resolve(ROOT, 'src/styles/03-theme-rails.css'), 'utf8');

type Rgb = readonly [number, number, number];
const parseHex = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255) as unknown as Rgb;
const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The hex value the first matching block declares for a token. */
function tokenIn(css: string, block: string, name: string): string {
  const start = css.indexOf(`${block} {`);
  expect(start, `block ${block} not found`).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf('}', start));
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
  expect(m, `${name} not declared in ${block}`).not.toBeNull();
  return m![1];
}

const RAILS = [
  { name: 'dark', block: ':root', css: tokens, bg: tokenIn(tokens, ':root', '--bg'), panel: tokenIn(tokens, ':root', '--panel'), blocked: tokenIn(tokens, ':root', '--rating-blocked') },
  { name: 'light', block: 'body.olv-theme-light', css: tokens, bg: tokenIn(rails, 'body.olv-theme-light', '--bg'), panel: tokenIn(rails, 'body.olv-theme-light', '--panel'), blocked: tokenIn(rails, 'body.olv-theme-light', '--rating-blocked') },
  { name: 'high contrast', block: 'body.olv-theme-high-contrast', css: tokens, bg: tokenIn(rails, 'body.olv-theme-high-contrast', '--bg'), panel: tokenIn(rails, 'body.olv-theme-high-contrast', '--panel'), blocked: tokenIn(rails, 'body.olv-theme-high-contrast', '--rating-blocked') },
];

describe('the withheld state token', () => {
  it('is its own value on :root, not an alias of blocked', () => {
    expect(tokens).not.toMatch(/--state-withheld:\s*var\(--rating-blocked\)/);
  });
  for (const rail of RAILS) {
    it(`${rail.name}: differs from blocked and clears 4.5:1 on --bg and --panel`, () => {
      const withheld = tokenIn(rail.css, rail.block, '--state-withheld');
      expect(withheld.toLowerCase()).not.toBe(rail.blocked.toLowerCase());
      expect(contrast(withheld, rail.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(withheld, rail.panel)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
