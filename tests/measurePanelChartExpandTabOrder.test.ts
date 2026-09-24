/**
 * measurePanelChartExpandTabOrder.test.ts
 *
 * ANALYSIS-F9: the profile chart's `chartWrap` (`role="button"`, `tabIndex=0`)
 * and the `chartExpand` button nested inside it shared the same accessible
 * name and the same `_openProfileFocus` action, so a keyboard/screen-reader
 * user tabbed through two consecutive stops for one control.
 *
 * Reads the source rather than the DOM — the panel needs a live viewer to
 * render (see tests/measurePanelExpandAffordance.test.ts, same file, same
 * convention). Comments are stripped first so prose cannot satisfy an
 * assertion meant to pin actual code.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RAW = readFileSync(resolve(__dirname, '../src/ui/MeasurePanel.ts'), 'utf8');
/** Source with block and line comments stripped, so a comment cannot satisfy an assertion. */
const PANEL = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

describe('the profile chart expander is one tab stop, not two', () => {
  it('keeps chartWrap as the focusable, named control', () => {
    expect(PANEL).toMatch(/chartWrap\.setAttribute\('role', 'button'\);/);
    expect(PANEL).toMatch(/chartWrap\.tabIndex = 0;/);
  });

  it('pulls the nested chartExpand button out of the tab order', () => {
    expect(PANEL).toMatch(/chartExpand\.tabIndex = -1;/);
  });

  it('pulls the nested chartExpand button out of the accessibility tree', () => {
    expect(PANEL).toMatch(/chartExpand\.setAttribute\('aria-hidden', 'true'\);/);
  });

  it('keeps chartExpand mouse-clickable (the fix removes a tab stop, not the control)', () => {
    expect(PANEL).toMatch(/chartExpand\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);/);
  });

  it('never removes chartWrap itself from the tab order to compensate', () => {
    // Two legitimate fixes exist (drop chartWrap's own role/tabIndex, or hide
    // chartExpand); this file took the second. Pin that choice so a future
    // edit cannot silently swap in the other one without a matching readout.
    expect(PANEL).not.toMatch(/chartWrap\.tabIndex = -1;/);
  });
});
