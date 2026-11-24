/**
 * measurePanelChartExpandTabOrder.test.ts
 *
 * The profile chart (`role="button"`, `tabIndex=0`) opens the larger view.
 * It holds no nested control, so it stays one tab stop for that action.
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

  it('nests no second control in the chart', () => {
    expect(PANEL).not.toMatch(/chartExpand|chartWrap\.append/);
  });

  it('never removes chartWrap itself from the tab order to compensate', () => {
    expect(PANEL).not.toMatch(/chartWrap\.tabIndex = -1;/);
  });
});
