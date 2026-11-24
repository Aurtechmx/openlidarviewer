/**
 * Ways into a profile's larger view: the chart (role="button", click and
 * Enter) and the labelled "Open in Profile Workbench" button. There is no
 * third control, in the chart's corner or in the chip strip, where a labelled
 * one once overflowed the panel.
 *
 * These read the source rather than the DOM, because the panel needs a live
 * viewer to render. Assertions strip comments first, so prose cannot satisfy
 * them.
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
  it('has no corner mark that repeats the chart and the labelled button', () => {
    expect(PANEL).not.toMatch(/olv-mp-chart-expand/);
    expect(CSS).not.toMatch(/olv-mp-chart-expand/);
    expect(rule('.olv-mp-chart-wrap')).toMatch(/cursor:\s*pointer/);
  });

  it('gives it an accessible name that names the measurement, and only what it opens', () => {
    // Two destinations now, so two names — and every one of them names the row
    // it belongs to.
    const names = PANEL.match(/`Expand profile \$\{s\.name\}[^`]*`/g) ?? [];
    expect(names).toHaveLength(2);
    expect(PANEL.match(/ariaLabel: expandName,/g) ?? []).toHaveLength(1);
  });

  it('opens the same focus view the chart click opens', () => {
    // One code path, so the two entries cannot drift apart.
    const calls = PANEL.match(/_openProfileFocus\(s, /g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('answers a key only when the chart itself has focus', () => {
    expect(PANEL).toMatch(/if \(e\.target !== chartWrap\) return;/);
  });

  it('fills the rail rather than carrying its own fixed width', () => {
    // The panel used to be a fixed 222px, narrower than the workspace tabs and
    // the cards above it, so its right edge did not line up with theirs. It now
    // fills the rail (width:100%) and can never force a horizontal scrollbar.
    expect(rule('.olv-measure-panel')).toMatch(/width:\s*100%/);
    expect(rule('.olv-measure-panel')).toMatch(/min-width:\s*0/);
    expect(rule('.olv-measure-panel')).toMatch(/max-width:\s*100%/);
    // `overflow-x: clip` forbids a horizontal scrollbar; `overflow-y: visible`
    // keeps the panel from being a scroll container so a trackpad wheel reaches
    // the `.olv-ws-body` column that actually scrolls.
    expect(rule('.olv-measure-panel')).toMatch(/overflow-x:\s*clip/);
    expect(rule('.olv-measure-panel')).toMatch(/overflow-y:\s*visible/);
  });

  it('keeps the left stack aligned by making every rail card fill the column', () => {
    // Alignment no longer depends on each panel declaring the same fixed width.
    // The open rail forces every child to width:100%, so the workspace tabs, the
    // Clip box card and the Measurements panel share one width and one right
    // edge. This rule is the guarantee; losing it reopens the misalignment.
    expect(CSS).toMatch(
      /\.olv-left-panels:not\(\.olv-rail-collapsed\)\s*>\s*\*\s*\{[^}]*width:\s*100%/,
    );
  });
});
