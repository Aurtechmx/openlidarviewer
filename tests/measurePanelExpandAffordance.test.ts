/**
 * The profile focus view existed and nobody found it.
 *
 * Opening was always possible: the chart wrapper carries role="button" and
 * responds to click and Enter. The only hints were a hover tooltip and a corner
 * mark that was `pointer-events: none` — shaped like a control, unable to be
 * one. The first fix added a labelled Expand button to the chip strip below the
 * chart. That button needed 233px inside a panel whose content box is 192px, so
 * it clipped every row it shared the panel with, and the report came back as
 * "the profile panel is cut on the right side".
 *
 * The corner mark is the control now: one affordance, where people already
 * look, doing what it looks like it does.
 *
 * These read the source rather than the DOM, because the panel needs a live
 * viewer to render. Reading source has a trap this file already fell into. The
 * previous version asserted `/\.olv-mp-chart-expand \{[^}]*pointer-events: none/`
 * and kept passing after the property was deleted, because the comment that
 * replaced it mentions the property by name. Assertions here strip comments
 * first, so prose cannot satisfy them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readAppCss } from './support/appCss';

const PANEL = readFileSync(resolve(__dirname, '../src/ui/MeasurePanel.ts'), 'utf8');
const CSS_RAW = readAppCss();

/** Stylesheet with every comment removed, so prose cannot satisfy an assertion. */
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of one rule, comments already gone. */
const rule = (selector: string): string => {
  const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m?.[1] ?? '';
};

describe('the profile chart offers a working way into the focus view', () => {
  it('makes the corner mark a button rather than a decorated span', () => {
    expect(PANEL).toMatch(/const chartExpand = el\('button', \{/);
  });

  it('lets the pointer reach it', () => {
    // The whole defect in one property.
    expect(rule('.olv-mp-chart-expand')).not.toMatch(/pointer-events:\s*none/);
    expect(rule('.olv-mp-chart-expand')).toMatch(/cursor:\s*pointer/);
  });

  it('gives it an accessible name that names the measurement, and only what it opens', () => {
    // Two destinations now, so two names — and every one of them names the row
    // it belongs to. The wrapper and the button share the one expression, so
    // the picture and its corner control cannot promise different things.
    const names = PANEL.match(/`Expand profile \$\{s\.name\}[^`]*`/g) ?? [];
    expect(names).toHaveLength(2);
    expect(PANEL.match(/ariaLabel: expandName,/g) ?? []).toHaveLength(2);
  });

  it('opens the same focus view the chart click opens', () => {
    // One code path, so the two entries cannot drift apart.
    const calls = PANEL.match(/_openProfileFocus\(s, /g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops the click reaching the chart wrapper underneath', () => {
    // Both are clickable; without this the focus view would open twice.
    expect(PANEL).toMatch(
      /chartExpand\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);/,
    );
  });

  it('shows itself without waiting for hover', () => {
    // An affordance you can only see once you are already over it is not one.
    expect(CSS).not.toMatch(/\.olv-mp-chart-wrap:hover\s+\.olv-mp-chart-expand\s*\{/);
    expect(CSS).toMatch(/\.olv-mp-chart-expand:hover/);
  });

  it('lets the button own its own keyboard activation', () => {
    // The wrapper is role="button" with its own Enter/Space handler. Without
    // the target check, a bubbling Enter from the nested button was
    // preventDefault()ed before the browser could synthesise the button's
    // click: the view opened through the wrapper, so focus returned there
    // rather than to the control the user activated.
    expect(PANEL).toMatch(/if \(e\.target !== chartWrap\) return;/);
  });

  it('leaves no second expand control in the chip strip', () => {
    // The strip holds zoom chips. A second control there is what overflowed the
    // panel, so its absence is the regression this file guards.
    expect(PANEL).not.toMatch(/olv-mp-chart-expand-btn/);
    expect(CSS).not.toMatch(/olv-mp-chart-expand-btn/);
  });

  it('sizes the panel from the widest row it has to hold', () => {
    // Measured in the running app: widest row 193px, chrome 26px. 218 left the
    // content box at 192 and clipped the last label by a pixel.
    expect(rule('.olv-measure-panel')).toMatch(/width:\s*222px/);
    expect(rule('.olv-measure-panel')).toMatch(/min-width:\s*222px/);
  });

  it('keeps the left stack aligned', () => {
    // Annotations, Export/Convert and Clip box sit under Measurements in one
    // column. A panel 4px wider than its neighbours reads as broken, so the
    // width change is a stack-wide change or it is a new defect.
    for (const sel of ['.olv-anno-panel', '.olv-export-panel', '.olv-clip-panel']) {
      expect(rule(sel), `${sel} must match the measure panel width`).toMatch(/width:\s*222px/);
    }
  });
});
