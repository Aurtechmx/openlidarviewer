import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readSection, STYLE_ORDER } from './support/appCss';
import { LARGE_TOUCH_LAYOUT_QUERY } from '../src/platform/runtimeFormFactor';

/**
 * Tablet touch targets: the rules live in one partition, sit inside the
 * large-touch query only, and give the listed controls their 44 px or 48 px
 * floor. A fine pointer and the phone layouts never match the query.
 */
const CSS = readSection('99y4-tablet-touch.css');
const STRIP = readFileSync(fileURLToPath(new URL('../src/ui/stateStrip.css', import.meta.url)), 'utf8');
const QUERY = '@media (pointer: coarse) and (hover: none) and (min-width: 768px) and (min-height: 600px)';

/** The body of the one @media block that follows `QUERY`. */
function mediaBody(css: string): string {
  const at = css.indexOf(QUERY);
  expect(at, 'large-touch media block').toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
  }
  throw new Error('unbalanced media block');
}

describe('tablet touch targets', () => {
  it('uses the same query as the large-touch layout', () => {
    expect(LARGE_TOUCH_LAYOUT_QUERY.replace(/\s+/g, ' ')).toContain('pointer: coarse');
    expect(CSS).toContain(QUERY);
  });

  it('is registered after the workspace polish and before forced colors', () => {
    const a = STYLE_ORDER.indexOf('99y3-workspace-polish.css');
    const b = STYLE_ORDER.indexOf('99y4-tablet-touch.css');
    const c = STYLE_ORDER.indexOf('99z-forced-colors.css');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it('keeps every sizing rule inside the query', () => {
    const outside = CSS.replace(mediaBody(CSS), '');
    expect(outside).not.toMatch(/min-(width|height)\s*:\s*4[48]px/);
    expect(outside).not.toMatch(/!important/);
  });

  it('gives close buttons 48 px with a selector that outranks the 44 px container rules', () => {
    const body = mediaBody(CSS);
    for (const c of ['palette-close', 'shortcuts-close', 'help-close', 'bc-close', 'wfc-close', 'workbench-close', 'pc-dismiss', 'colorbar-close']) {
      expect(body).toContain(`button.olv-${c}`);
    }
    expect(body).toMatch(/min-width: 48px; min-height: 48px/);
  });

  it('gives Frame all 48 px and moves the neighbouring pads out', () => {
    const body = mediaBody(CSS);
    expect(body).toMatch(/\.olv-modes-triangle \.olv-mode-reset \{ width: 48px; height: 48px; \}/);
    expect(body).toContain('.olv-mode-walk { left: -7px; }');
    expect(body).toContain('.olv-mode-fly { right: -7px; }');
  });

  it('sizes the navigation card, empty state, palette and tour controls at 44 px', () => {
    const body = mediaBody(CSS);
    for (const s of ['.olv-navbar button', '.olv-empty button', '.olv-palette-row', '.olv-shortcuts-card button', '.olv-tour-btn', '.olv-wfc button']) {
      expect(body).toContain(s);
    }
    expect(body).toMatch(/min-height: 44px; min-width: 44px;/);
  });

  it('grows the view cube so five 44 px buttons fit without overlapping', () => {
    const body = mediaBody(CSS);
    expect(body).toContain('.olv-viewcube { width: 144px !important; height: 144px !important; }');
    expect(body).toContain('.olv-viewcube > button { width: 44px !important; height: 44px !important; }');
    // Rose inset 8 px: the centre sits at 72 px, the top face ends at 50 px, the centre button starts at 50 px.
    expect(8 - 2 + 44).toBeLessThanOrEqual(144 / 2 - 22);
  });

  it('wraps the class visibility checkbox in a label that is a 44 px box under the query only', () => {
    expect(CSS).toMatch(/^\.olv-cl-check-hit \{ display: inline-flex;/m);
    expect(mediaBody(CSS)).toContain('.olv-cl-check-hit { min-width: 44px; min-height: 44px;');
    const src = readFileSync(fileURLToPath(new URL('../src/ui/ClassLegendPanel.ts', import.meta.url)), 'utf8');
    expect(src).toContain("el('label', { className: 'olv-cl-check-hit' }, [check])");
  });

  it('lets the state strip hold 44 px items on a large touch screen', () => {
    const body = mediaBody(STRIP);
    expect(body).toContain('--olv-strip-h: 48px');
    expect(body).toContain('.olv-ss-item { min-height: 44px; min-width: 44px; }');
  });
});
