/**
 * fieldPalette.test.ts — the Field interface palette and the Blue default.
 *
 * Blue is the :root palette and must keep its original values. Field is a
 * body-class rail in 03-theme-rails.css: every text and status ink clears
 * 4.5:1 on its page, panel and raised surfaces, and every literal bridge the
 * stylesheets read (`--ui-*`) has a Blue value on :root and a Field override.
 *
 * Token ratios are computed from the declared values. They do not certify the
 * rendered interface (alpha compositing and images still need a browser).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { block, contrast, hexIn } from './helpers/paletteContrast';

const read = (p: string): string => readFileSync(resolve(import.meta.dirname, '../src/styles', p), 'utf8');
const tokens = read('01-tokens.css');
const rails = read('03-theme-rails.css');
const root = block(tokens, ':root');
const field = block(rails, 'body.olv-theme-field');

const INKS = [
  '--text', '--text-dim', '--text-faint', '--accent', '--warn',
  '--rating-excellent', '--rating-strong', '--rating-good', '--rating-moderate',
  '--rating-weak', '--rating-blocked', '--state-withheld',
];
const SURFACES = ['--bg', '--panel', '--panel-raised'];

describe('Blue stays the original palette', () => {
  it('keeps the primary Blue token values', () => {
    const blue = {
      '--bg': '#030817', '--panel': '#0f172a', '--panel-raised': '#16203a', '--accent': '#00b2ff',
      '--on-accent': '#030817', '--text': '#FFFFFF', '--text-dim': '#9aa6bd', '--text-faint': '#8a94ad',
      '--warn': '#b8860b', '--rating-blocked': '#c084fc', '--state-withheld': '#f472b6',
    };
    for (const [name, value] of Object.entries(blue)) expect(hexIn(root, name), name).toBe(value);
  });

  it('keeps each literal bridge at the exact value it replaced', () => {
    expect(root).toContain('--ui-accent-solid: #00b2ff;');
    expect(root).toContain('--ui-accent-a0p3: rgba(0, 178, 255, 0.3);');
    expect(root).toContain('--ui-surface-deep: #030817;');
    expect(root).toContain('--ui-surface-11-17-33-a-0p92: rgba(11, 17, 33, 0.92);');
    expect(root).toContain('--stage-ui-background: radial-gradient(ellipse at 50% 45%, #0c1224 0%, #070a14 70%, #050810 100%);');
  });
});

describe('Field palette', () => {
  for (const ink of INKS) {
    it(`${ink} clears 4.5:1 on every Field surface`, () => {
      for (const surface of SURFACES) {
        expect(contrast(hexIn(field, ink)!, hexIn(field, surface)!), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('the filled primary action clears 4.5:1', () => {
    expect(contrast(hexIn(field, '--on-accent')!, hexIn(field, '--accent')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('every literal bridge has a Blue value and a Field override', () => {
    const names = [...root.matchAll(/(--ui-[\w-]+|--stage-ui-background):/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) expect(field, name).toContain(`${name}:`);
  });

  it('retired palette selectors and the disconnected data-theme hook are gone', () => {
    const all = [tokens, rails, read('50-navigation-bar.css')].join('\n');
    expect(all).not.toMatch(/olv-theme-light/);
    expect(all).not.toMatch(/data-theme="high-contrast"/);
  });

  it('forced-colour support remains', () => {
    expect(read('99z-forced-colors.css')).toContain('forced-colors: active');
  });
});
