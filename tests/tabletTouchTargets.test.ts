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
    expect(c).toBeGreaterThan(b);
    expect(c).toBe(STYLE_ORDER.length - 1);
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

  it('gives the mode segments, Frame all and More 44 px targets', () => {
    const body = mediaBody(CSS);
    expect(body).toContain('.olv-modes-segmented .olv-mode { height: 44px; min-width: 44px; }');
    expect(body).toContain('.olv-mode-reset, .olv-nav-more { width: 44px; height: 44px; }');
  });

  it('sizes the navigation card, empty state, palette and tour controls at 44 px', () => {
    const body = mediaBody(CSS);
    for (const s of ['.olv-navbar button', '.olv-empty button', '.olv-palette-row', '.olv-shortcuts-card button', '.olv-tour-btn', '.olv-wfc button']) {
      expect(body).toContain(s);
    }
    expect(body).toMatch(/min-height: 44px; min-width: 44px;/);
  });

  it('sizes the view cube for touch: 44 px edge and corner targets, a 44 px Home, the cube inside its box', () => {
    // The cube owns its touch geometry (its lazy viewCube.css, plus script-set sizes),
    // so the tablet stylesheet no longer carries cube rules.
    expect(mediaBody(CSS)).not.toMatch(/\.olv-viewcube[^-]/);
    const src = readFileSync(fileURLToPath(new URL('../src/render/viewCubeMath.ts', import.meta.url)), 'utf8');
    const m = /coarse: \{ box: (\d+), half: (\d+), hit: (\d+), home: (\d+) \}/.exec(src);
    expect(m).not.toBeNull();
    const [box, half, hit, home] = m!.slice(1).map(Number);
    expect(hit).toBeGreaterThanOrEqual(44);
    expect(home).toBeGreaterThanOrEqual(44);
    // The cube's widest silhouette (a corner-on view) is its space diagonal.
    expect(2 * half * Math.sqrt(3)).toBeLessThanOrEqual(box);
    const css = readFileSync(fileURLToPath(new URL('../src/ui/viewCube.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/@media \(pointer:coarse\)\{[^\n]*\.olv-viewcube-home\{width:44px;height:44px\}/);
  });

  it('wraps the class visibility checkbox in a label that is a 44 px box under the query only', () => {
    expect(CSS).toMatch(/^\.olv-check-hit \{ display: inline-flex;/m);
    expect(mediaBody(CSS)).toContain('.olv-check-hit { min-width: 44px; min-height: 44px;');
    const src = readFileSync(fileURLToPath(new URL('../src/ui/ClassLegendPanel.ts', import.meta.url)), 'utf8');
    expect(src).toContain("el('label', { className: 'olv-check-hit' }, [check])");
  });

  it('sizes the location bar, catalogue inputs and the View panel head', () => {
    const body = mediaBody(CSS);
    expect(body).toContain('.olv-loc-back, .olv-loc-crumb, .olv-catalog-input, .olv-help-nav-item { min-height: 44px; }');
    expect(body).toContain(".olv-panel-head[role='button'] { min-height: 44px;");
  });

  it('lets the state strip hold 44 px items on a large touch screen', () => {
    const body = mediaBody(STRIP);
    expect(body).toContain('--olv-strip-h: 48px');
    expect(body).toContain('.olv-ss-item { min-height: 44px; min-width: 44px; }');
  });
});
