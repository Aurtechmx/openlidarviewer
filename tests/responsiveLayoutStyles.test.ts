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
const src = (path: string): string => readFileSync(path, 'utf8');

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

// OVERLAYS-TOUR-1: the onboarding tour card at 320-375px.
describe('OVERLAYS-TOUR-1 — tour card width at phone widths', () => {
  it('.olv-tour-card is responsive, not a fixed 360px', () => {
    const rule = css('78-shortcuts-recorder-tour.css').match(/\.olv-tour-card\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/);
    expect(rule).not.toMatch(/width:\s*360px;/);
  });
  it('TourOverlay.ts computes cardW the same way, not a bare 360 literal', () => {
    const text = src('src/ui/onboarding/TourOverlay.ts');
    expect(text).toMatch(/const cardW = Math\.min\(360, vw - 32\)/);
    // Both placement branches (no-target centring, and the target-relative
    // clamp) must read the computed cardW, not a re-hardcoded 360.
    expect(text).not.toMatch(/\(vw - 360\) \/ 2/);
    expect(text).not.toMatch(/const cardW = 360;/);
  });
});

// SWEEP-F1: the dock overflowing at 768px with a scan loaded.
describe('SWEEP-F1 — dock width at 768px', () => {
  it('a fourth tool folds under More in the narrow low end of the laptop tier', () => {
    const text = css('45-dock-and-panels.css');
    const block = text.match(/@media \(max-width: 830px\) and \(min-width: 768px\) \{[^}]*\}[^}]*\}/s)?.[0] ?? '';
    expect(block).toMatch(/\.olv-dock \.olv-tool-command\s*\{\s*display:\s*none/);
    expect(block).toMatch(/\.olv-dock\.olv-dock-more-open \.olv-tool-command\s*\{\s*display:\s*inline-flex/);
  });
});

// OVERLAYS-TOAST-1 / INTAKE-F5: the DropZone toast text overflow.
describe('OVERLAYS-TOAST-1 / INTAKE-F5 — toast text wraps instead of overflowing', () => {
  it('.olv-toast-text wraps an unbroken long filename and can shrink below content width', () => {
    const rule = css('45-dock-and-panels.css').match(/\.olv-toast-text\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/min-width:\s*0/);
  });
});

// INSPECT-INSP-2: the auto-detected scan-type label mid-word clip.
describe('INSPECT-INSP-2 — scan-type segment label truncation', () => {
  it('.olv-scan-type-opt clips with an ellipsis rather than a bare mid-word cut', () => {
    const rule = css('94-scan-type.css').match(/\.olv-scan-type-opt\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });
});

// SHELL-F6: the classic-scrollbar selector-list omission.
describe('SHELL-F6 — .olv-ws-body joins the classic-scrollbar lists', () => {
  it('appears in all five .olv-classic-scrollbars ...::-webkit-scrollbar* lists', () => {
    const text = css('72-panel-rails.css');
    for (const suffix of ['', '-track', '-thumb', '-thumb:hover', '-corner']) {
      const needle = `.olv-classic-scrollbars .olv-ws-body::-webkit-scrollbar${suffix}`;
      expect(text.includes(needle), `missing: ${needle}`).toBe(true);
    }
  });
});

// CRITIC-GAP-1: light-theme rating scale contrast.
describe('CRITIC-GAP-1 — Field and High contrast rating scales stay readable', () => {
  function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  function relLum([r, g, b]: [number, number, number]): number {
    const f = (c: number): number => {
      const n = c / 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a: string, b: string): number {
    const la = relLum(hexToRgb(a));
    const lb = relLum(hexToRgb(b));
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }

  const block = (selector: string): string => {
    const text = css('03-theme-rails.css');
    const start = text.indexOf(`${selector} {`);
    const end = text.indexOf('\n}', start);
    return text.slice(start, end);
  };
  const hexIn = (body: string, token: string): string | null =>
    body.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? null;

  const tokens = ['--rating-excellent', '--rating-strong', '--rating-good', '--rating-moderate', '--rating-weak'];
  const palettes = [
    { selector: 'body.olv-theme-field', floor: 4.5 },
    { selector: 'body.olv-theme-high-contrast', floor: 7 },
  ];

  for (const { selector, floor } of palettes) {
    it(`every rating token is overridden in ${selector} (not inherited from the dark :root)`, () => {
      const body = block(selector);
      for (const t of tokens) expect(hexIn(body, t), `${t} must be set in ${selector}`).not.toBeNull();
    });

    it(`${selector}: each overridden value clears ${floor}:1 against both --bg and --panel`, () => {
      const body = block(selector);
      const bg = hexIn(body, '--bg')!;
      const panel = hexIn(body, '--panel')!;
      for (const t of tokens) {
        const hex = hexIn(body, t)!;
        expect(contrast(hex, bg), `${t} ${hex} vs --bg`).toBeGreaterThanOrEqual(floor);
        expect(contrast(hex, panel), `${t} ${hex} vs --panel`).toBeGreaterThanOrEqual(floor);
      }
    });
  }
});

// CRITIC-GAP-3: per-layer isolate/lock phone touch targets.
describe('CRITIC-GAP-3 — isolate/lock 44px phone touch targets', () => {
  it('.olv-layer-solo / .olv-layer-lock get the same 44px floor as .olv-layer-x', () => {
    const text = css('65-mobile-touch.css');
    const phoneBlockStart = text.indexOf('@media (max-width: 767px)');
    const phoneBlock = text.slice(phoneBlockStart);
    const rule = phoneBlock.match(/\.olv-layer-solo,\s*\.olv-layer-lock\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(rule).toMatch(/min-width:\s*44px/);
    expect(rule).toMatch(/min-height:\s*44px/);
  });
});

// Close scan files under More on a phone and stays in the primary row elsewhere.
describe('Close scan on phone layouts', () => {
  const phone = (): string => {
    const text = css('65-mobile-touch.css');
    const at = text.indexOf('@media (max-width: 767px), (max-height: 500px) and (pointer: coarse) {');
    expect(at, 'the phone media block is missing').toBeGreaterThan(-1);
    return text.slice(at);
  };
  it('hides it until More is open, using the same disclosure class as the other folded tools', () => {
    const text = phone();
    expect(text).toMatch(/\.olv-dock \.olv-tool-close,\s*\.olv-dock \.olv-tool-probe \{\s*display: none;/);
    expect(text).toMatch(/\.olv-dock\.olv-dock-more-open \.olv-tool-close \{\s*display: inline-flex;/);
  });
  it('keeps the 44 px target and its own cluster gap', () => {
    const text = css('99-mobile-gui-refresh.css');
    expect(text).toMatch(/\.olv-dock \.olv-tool-close \{ min-width: 44px; \}/);
    expect(text).toMatch(/\.olv-dock > \.olv-dock-gap \{/);
  });
  it('does not fold it on the laptop tier', () => {
    const text = css('45-dock-and-panels.css');
    const at = text.indexOf('@media (max-width: 1100px) and (min-width: 768px)');
    expect(text.slice(at, text.indexOf('\n}', at))).not.toContain('olv-tool-close');
  });
  it('keeps the destructive tint rule outside any media query', () => {
    expect(css('45-dock-and-panels.css')).toMatch(/^\.olv-tool-close:not\(:disabled\) \{/m);
  });
});

describe('confirm dialog touch targets', () => {
  it('keeps 44 px buttons on any coarse pointer, not only below 768px', () => {
    expect(css('80-modal-system.css')).toMatch(/@media \(pointer: coarse\) \{\s*\.olv-confirm-cancel, \.olv-confirm-ok \{\s*min-height: 44px;/);
  });
});
