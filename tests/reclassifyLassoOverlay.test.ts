/**
 * reclassifyLassoOverlay.test.ts
 *
 * Arming the reclassify lasso used to cover the whole interface. The lasso SVG
 * mounts as a sibling of `.olv-overlay`, which is a stacking context at
 * `--z-scene-overlay: 2` holding every panel, so an inline `z-index: 3` painted
 * the lasso above all of them and swallowed their clicks. Escape could not
 * clear it either: the global handler knew only the volume lasso.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('the armed lasso does not cover the panels', () => {
  const src = readFileSync(new URL('../src/ui/LassoVolumeTool.ts', import.meta.url), 'utf8');

  it('mounts under the panel overlay, not above it', () => {
    expect(src).not.toMatch(/z-index:\s*3\b/);
    expect(src).toMatch(/z-index:var\(--z-content\)/);
  });

  it('keeps the panel overlay above the lasso in the token scale', () => {
    const tokens = readFileSync(new URL('../src/styles/01-tokens.css', import.meta.url), 'utf8');
    const val = (name: string): number => {
      const m = new RegExp(`--${name}:\\s*(\\d+)`).exec(tokens);
      return m ? Number(m[1]) : Number.NaN;
    };
    expect(val('z-content')).toBeLessThan(val('z-scene-overlay'));
  });
});

describe('Escape reaches the reclassify lasso', () => {
  it('main.ts disarms the reclassify lasso in its Escape handler', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const esc = /onEscape:\s*\(\)\s*=>\s*\{([\s\S]*?)\n    \},/.exec(main);
    expect(esc, 'onEscape handler not found').toBeTruthy();
    expect(esc![1]).toMatch(/reclassifyUi\?\.disarm\(\)/);
  });

  it('reclassifyUi exposes disarm on its public surface', () => {
    const ui = readFileSync(new URL('../src/ui/reclassifyUi.ts', import.meta.url), 'utf8');
    expect(ui).toMatch(/disarm\(\):\s*boolean;/);
    expect(ui).toMatch(/disarm\(\):\s*boolean\s*\{/);
  });
});
