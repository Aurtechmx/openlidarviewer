/**
 * warnTokenContrast.test.ts — the provenance caption stays readable.
 *
 * The caption that names a figure's basis is the one piece of text a reader
 * consults precisely when they doubt the number above it. It carries its
 * meaning in words rather than in colour, but it still has to be read, and it
 * sits on a tinted fill of its own colour, which cuts contrast further than
 * the colour on the panel alone.
 *
 * `--warn` was undefined for a long time, so every use fell back to a single
 * hardcoded amber that measured 2.9:1 on the light rail's near-white caption
 * fill, against the 4.5:1 WCAG AA asks for body text. These cases hold each
 * rail's value to the ratio it was chosen for, computed rather than asserted
 * in a comment, so a later palette edit has to keep the guarantee.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

type Rgb = readonly [number, number, number];

const parseHex = (hex: string): Rgb => {
  const h = hex.trim().replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Rgb;
};

/** WCAG relative luminance. */
const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** `color-mix(in srgb, fg 12%, transparent)` composited over a surface. */
const captionFill = (fg: Rgb, surface: Rgb): Rgb =>
  fg.map((v, i) => v * 0.12 + surface[i] * 0.88) as unknown as Rgb;

/** Read one custom property out of a declaration block. */
function tokenIn(css: string, block: string, name: string): string {
  const start = css.indexOf(block);
  expect(start, `block ${block} not found`).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf('}', start));
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
  expect(m, `${name} not declared in ${block}`).not.toBeNull();
  return m![1];
}

const tokens = read('src/styles/01-tokens.css');
const rails = read('src/styles/03-theme-rails.css');

const RAILS: ReadonlyArray<{ name: string; warn: string; panel: string }> = [
  { name: 'default dark', warn: tokenIn(tokens, ':root', '--warn'), panel: '#0b1020' },
  {
    name: 'light',
    warn: tokenIn(rails, 'body.olv-theme-light', '--warn'),
    panel: tokenIn(rails, 'body.olv-theme-light', '--panel'),
  },
  {
    name: 'high contrast',
    warn: tokenIn(rails, 'body.olv-theme-high-contrast', '--warn'),
    panel: tokenIn(rails, 'body.olv-theme-high-contrast', '--panel'),
  },
];

describe('the provenance caption clears WCAG AA on every rail', () => {
  for (const rail of RAILS) {
    it(`${rail.name}: caption text on its own tinted fill`, () => {
      const fg = parseHex(rail.warn);
      const ratio = contrast(fg, captionFill(fg, parseHex(rail.panel)));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('declares --warn on every rail, so no use falls back to a literal', () => {
    // The bug this file exists for: an undefined token meant one hardcoded
    // amber served three palettes, and the light one failed.
    for (const rail of RAILS) expect(rail.warn).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
