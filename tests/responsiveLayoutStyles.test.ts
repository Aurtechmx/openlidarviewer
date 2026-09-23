/**
 * responsiveLayoutStyles.test.ts
 *
 * DOM-free regression pins for the v0.7 layout-lane audit findings. Each
 * pin reads the real stylesheet (or TourOverlay.ts) source and asserts the
 * exact rule the fix introduced, so a later edit that quietly reverts one
 * of these fails here instead of only in a slower Playwright run. The
 * corresponding e2e/visual assertions live in tests/e2e/responsiveLayout.spec.ts
 * and the other e2e specs named per finding below.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = (name: string): string => readFileSync(`src/styles/${name}`, 'utf8');

/**
 * The `@media (max-width: 480px) { ... }` block in 83-mobile-audit.css that
 * contains `needle` — the file has more than one such block, so a bare
 * first-match would silently grab the wrong one.
 */
function mobileClampBlockContaining(text: string, needle: string): string {
  let from = 0;
  for (;;) {
    const start = text.indexOf('@media (max-width: 480px)', from);
    expect(start, `no 480px block in 83-mobile-audit.css contains ${needle}`).toBeGreaterThan(-1);
    const braceStart = text.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const block = text.slice(braceStart, end + 1);
    if (block.includes(needle)) return block;
    from = end + 1;
  }
}

// SHELL-F1: the Open-from-URL row at 320px.
describe('SHELL-F1 — Open-from-URL row at 320px', () => {
  it('.olv-url-input no longer forces a column-flex-basis height blowout', () => {
    const block = mobileClampBlockContaining(css('83-mobile-audit.css'), '.olv-url-input');
    expect(block).toMatch(/\.olv-url-input\s*\{[^}]*flex:\s*0 0 auto/);
    expect(block).not.toMatch(/\.olv-url-input\s*\{[^}]*flex:\s*1 1 100%/);
  });
  it('.olv-empty clips its own decorative wash instead of scrolling on it', () => {
    expect(css('30-empty-state.css')).toMatch(/\.olv-empty\s*\{[^}]*overflow-x:\s*hidden/s);
  });
});

// SHELL-F2: the coordinate HUD painted over by the tool dock.
describe('SHELL-F2 — coordinate HUD vs tool dock stacking', () => {
  it('the HUD z-index sits above the dock, not below it', () => {
    const rule = css('40-inspector.css').match(/\.olv-coordinate-hud\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/z-index:\s*calc\(var\(--z-dock\)\s*\+\s*1\)/);
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
});
