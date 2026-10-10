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

  it('keeps the five view cube buttons apart at every heading', () => {
    const body = mediaBody(CSS);
    const cube = Number(/\.olv-viewcube \{ width: (\d+)px !important; height: \1px !important; \}/.exec(body)?.[1]);
    const face = Number(/\.olv-viewcube-rose button \{[^}]*?width: (\d+)px !important;[^}]*?height: \1px !important/.exec(body)?.[1]);
    const top = Number(/\.olv-viewcube > button \{ width: (\d+)px !important; height: \1px !important; \}/.exec(body)?.[1]);
    expect(body).toMatch(/\.olv-viewcube-rose button \{[^}]*border-radius: 50% !important/);
    // Every face is a fixed-width circle, so a long label wraps and cannot widen the face.
    expect(body).not.toMatch(/\.olv-viewcube-rose button \{[^}]*width: auto/);
    expect(body).toMatch(/\.olv-viewcube-rose button \{[^}]*white-space: normal/);
    // Geometry owned by viewCube.ts: the rose inset and how far a face sits outside it.
    const src = readFileSync(fileURLToPath(new URL('../src/ui/viewCube.ts', import.meta.url)), 'utf8');
    const inset = Number(/inset:(\d+)px/.exec(src)?.[1]);
    const out = Number(/top:-(\d+)px;left:50%/.exec(src)?.[1]);
    expect([cube, face, top, inset, out].every(Number.isFinite)).toBe(true);
    const roseRadius = cube / 2 - inset;
    // Face centre sits (roseRadius + out - face / 2) from the rose centre, along one of four axes.
    const faceCentre = roseRadius + out - face / 2;
    // Distance from the cube centre to the face centre does not change when the rose turns, and the
    // faces are circles, so two circles of radius face / 2 and top / 2 stay clear when it is at least the sum.
    expect(faceCentre).toBeGreaterThanOrEqual(face / 2 + top / 2);
    // Neighbouring faces are 90 degrees apart on that ring.
    expect(faceCentre * Math.SQRT2).toBeGreaterThanOrEqual(face);
  });

  it('moves the view cube right of the open left rail', () => {
    const body = mediaBody(CSS);
    expect(body).toContain("body:has(.olv-left-panels:not(.olv-rail-collapsed)) .olv-viewcube {");
    expect(body).toContain('left: calc(var(--olv-rail-width) + 32px) !important;');
  });

  it('wraps the class visibility checkbox in a label that is a 44 px box under the query only', () => {
    expect(CSS).toMatch(/^\.olv-check-hit \{ display: inline-flex;/m);
    expect(mediaBody(CSS)).toContain('.olv-check-hit { min-width: 44px; min-height: 44px;');
    const src = readFileSync(fileURLToPath(new URL('../src/ui/ClassLegendPanel.ts', import.meta.url)), 'utf8');
    expect(src).toContain("el('label', { className: 'olv-check-hit' }, [check])");
  });

  it('sizes the location bar, catalogue inputs and the View panel head', () => {
    const body = mediaBody(CSS);
    expect(body).toContain('.olv-loc-back, .olv-loc-crumb, .olv-catalog-input { min-height: 44px; }');
    expect(body).toContain(".olv-panel-head[role='button'] { min-height: 44px;");
  });

  it('lets the state strip hold 44 px items on a large touch screen', () => {
    const body = mediaBody(STRIP);
    expect(body).toContain('--olv-strip-h: 48px');
    expect(body).toContain('.olv-ss-item { min-height: 44px; min-width: 44px; }');
  });
});
