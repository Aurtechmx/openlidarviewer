/**
 * The profile focus view existed and nobody found it.
 *
 * Opening was already possible: the chart wrapper carries role="button" and
 * responds to click and Enter. But the only hints were a hover tooltip and a
 * corner glyph that is decorative and pointer-events: none, sharing that corner
 * with the native resize grip. The one mark people saw was the one that changes
 * the height, so a full-page chart, its station table and its PDF export sat
 * behind an affordance that announced nothing.
 *
 * These read the source rather than the DOM, because the panel needs a live
 * viewer to render. They pin the two properties that made it undiscoverable, so
 * a later edit cannot quietly take the label away again.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PANEL = readFileSync(resolve(__dirname, '../src/ui/MeasurePanel.ts'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');

describe('the profile chart offers a named way into the focus view', () => {
  it('has a control whose visible text says what it does', () => {
    // A glyph is not a label. The word is the point of this test.
    expect(PANEL).toMatch(/olv-mp-chart-expand-btn[\s\S]{0,400}<span>Expand<\/span>/);
  });

  it('gives that control an accessible name naming the measurement', () => {
    expect(PANEL).toMatch(/ariaLabel: `Expand profile \$\{s\.name\} to a focus view`/);
  });

  it('opens the same focus view the chart click opens', () => {
    // One code path, so the two entries cannot drift apart.
    const calls = PANEL.match(/_openProfileFocus\(s, /g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops the click reaching the chart wrapper underneath', () => {
    // Both are clickable; without this the focus view would open twice.
    expect(PANEL).toMatch(/expandBtn\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);/);
  });

  it('keeps the corner glyph decorative, so it is not a second control', () => {
    expect(CSS).toMatch(/\.olv-mp-chart-expand \{[^}]*pointer-events: none/);
  });

  it('styles the control as focusable, since keyboard users reach it first', () => {
    expect(CSS).toMatch(/\.olv-mp-chart-expand-btn:focus-visible \{[^}]*outline: var\(--focus-ring\)/);
  });
});
