/**
 * themeHighContrast.test.ts — the High contrast interface palette.
 *
 * A pure black page with opaque surfaces. Text, icon, status and accent inks
 * clear 7:1 (WCAG AAA for text) on every surface, and so does the filled
 * primary action. Every literal bridge resolves to an opaque value, so no
 * panel is translucent. The component rules give panels, inputs, buttons and
 * menus a 2 px solid edge and focus a 3 px ring, and they step aside under
 * forced colours, which stays the final override.
 *
 * Token ratios are computed from the declared values; they do not certify the
 * rendered interface, and this palette is not a certified accessibility mode.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { block, contrast, hexIn } from './helpers/paletteContrast';

const read = (p: string): string => readFileSync(resolve(import.meta.dirname, '../src/styles', p), 'utf8');
const tokens = read('01-tokens.css');
const rails = read('03-theme-rails.css');
const hc = block(rails, 'body.olv-theme-high-contrast');
const index = readFileSync(resolve(import.meta.dirname, '../src/styles/index.ts'), 'utf8');

const INKS = [
  '--text', '--text-dim', '--text-faint', '--accent', '--warn',
  '--rating-excellent', '--rating-strong', '--rating-good', '--rating-moderate',
  '--rating-weak', '--rating-blocked', '--state-withheld', '--hc-focus',
];
const SURFACES = ['--bg', '--panel', '--panel-raised', '--hc-accent-wash', '--hover-wash', '--caveat-tint'];

/** Resolve a token in the High contrast block to a hex value, following var() once. */
function resolveHex(token: string): string {
  const direct = hexIn(hc, token);
  if (direct) return direct;
  const ref = new RegExp(`${token}:\\s*var\\((--[\\w-]+)\\)`).exec(hc)?.[1];
  if (!ref) throw new Error(`${token} not declared as a hex or var() in the High contrast block`);
  return resolveHex(ref);
}

describe('High contrast palette', () => {
  it('has a pure black page', () => {
    expect(hexIn(hc, '--bg')).toBe('#000000');
  });

  for (const ink of INKS) {
    it(`${ink} clears 7:1 on every High contrast surface`, () => {
      for (const surface of SURFACES) {
        expect(contrast(resolveHex(ink), resolveHex(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(7);
      }
    });
  }

  it('the filled primary action clears 7:1', () => {
    expect(contrast(resolveHex('--on-accent'), resolveHex('--accent'))).toBeGreaterThanOrEqual(7);
  });

  it('edges are visible: hairlines clear 3:1 on every surface', () => {
    for (const edge of ['--hairline', '--hairline-strong']) {
      for (const surface of SURFACES) expect(contrast(resolveHex(edge), resolveHex(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  it('every surface and literal bridge is opaque; only backdrops use the scrim', () => {
    const names = [...block(tokens, ':root').matchAll(/(--ui-[\w-]+|--stage-ui-background):/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(40);
    const scrims: string[] = [];
    for (const name of [...names, '--panel-recessive', '--m-glass', '--m-glass-raised', '--accent-soft']) {
      const value = new RegExp(`${name}:\\s*([^;]+);`).exec(hc)?.[1];
      expect(value, `${name} is overridden`).toBeDefined();
      if (value === 'var(--hc-scrim)') scrims.push(name);
      else expect(value, name).not.toMatch(/rgba|transparent|color-mix/);
    }
    // The five modal, palette and dialog backdrops dim the app behind them.
    expect(scrims).toHaveLength(5);
    const backdropCss = ['02-overlays-chrome.css', '80-modal-system.css', '90-converter-export.css', '78-shortcuts-recorder-tour.css']
      .map(read).join('\n');
    for (const name of scrims) {
      const uses = [...backdropCss.matchAll(new RegExp(`([^{}]+)\\{[^}]*var\\(${name}\\)`, 'g'))].map((m) => m[1].trim());
      expect(uses.length, name).toBeGreaterThan(0);
      for (const sel of uses) expect(sel, name).toMatch(/backdrop|overlay|focus|olv-help|olv-wfc/);
    }
  });

  it('removes soft shadows and glows', () => {
    for (const name of ['--shadow-raised', '--m-glass-shadow', '--m-chrome-lift']) {
      expect(new RegExp(`${name}:\\s*none;`).test(hc), name).toBe(true);
    }
    expect(hc).toMatch(/--m-active-glow:\s*transparent;/);
    expect(hc).toMatch(/--lab-glow:\s*transparent;/);
  });

  it('declares a focus ring of at least 3px', () => {
    const width = /--focus-ring:\s*(\d+)px solid var\(--hc-focus\)/.exec(hc)?.[1];
    expect(Number(width)).toBeGreaterThanOrEqual(3);
  });
});

describe('High contrast component rules', () => {
  const media = rails.slice(rails.indexOf('@media (forced-colors: none)'));

  it('only apply outside forced colours', () => {
    expect(media.length).toBeGreaterThan(0);
    expect(media).toContain('body.olv-theme-high-contrast :focus-visible');
  });

  it('draw 2px solid edges on controls, dialogs, menus, tooltips and panels', () => {
    for (const hook of ['button', 'select', 'textarea', "[role='dialog']", "[role='menu']", "[role='tooltip']",
      "[role='tablist']", '.olv-modal', '.olv-toast', '.olv-mobile-sheet', '.olv-inspector', '.olv-dock', '.olv-nav-more-menu']) {
      expect(media, hook).toContain(hook);
    }
    expect(media).toMatch(/border:\s*2px solid var\(--hairline-strong\)/);
  });

  it('remove blur and text glow', () => {
    expect(media).toMatch(/backdrop-filter:\s*none/);
    expect(media).toMatch(/text-shadow:\s*none/);
  });

  it('focus uses the thick ring and comes after the state outlines', () => {
    expect(media.indexOf(':focus-visible {')).toBeGreaterThan(media.indexOf("[aria-pressed='true']"));
    expect(media).toMatch(/:focus-visible \{\s*outline:\s*var\(--focus-ring\)/);
  });

  it('forced colours remain the final stylesheet', () => {
    const imports = [...index.matchAll(/import '\.\/([^']+\.css)'/g)].map((m) => m[1]);
    expect(imports.at(-1)).toBe('99z-forced-colors.css');
  });
});
