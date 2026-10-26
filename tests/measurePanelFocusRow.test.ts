/**
 * measurePanelFocusRow.test.ts: the result card's "Open details" lands on the
 * row it is about. The row itself takes focus, not its name field, so nothing
 * opens for editing and a phone sheet that is still opening does not receive
 * focus in a hidden input.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../src/ui/ResultFocus', () => ({ openResultFocus: () => {} }));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => { installFakeDom(); });

const rows = [
  { id: 'a', kind: 'distance', name: 'Line A', value: '4 m' },
  { id: 'b', kind: 'distance', name: 'Line B', value: '5 m' },
] as MeasurementSummary[];

describe('MeasurePanel.focusRow', () => {
  it('focuses the row itself, not its name field', () => {
    const panel = new MeasurePanel({ onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {}, getUnitSystem: () => 'metric' });
    panel.update(rows);
    const root = panel.element as unknown as FakeEl;
    const row = root.querySelectorAll('.olv-mp-row').find((r) => r.getAttribute('data-measurement-id') === 'b')!;
    const name = row.querySelectorAll('.olv-mp-name')[0]!;
    const focused: FakeEl[] = [];
    row.focus = () => { focused.push(row); };
    name.focus = () => { focused.push(name); };
    expect(panel.focusRow('b')).toBe(true);
    expect(focused).toEqual([row]);
    expect(row.tabIndex).toBe(-1);
  });

  it('reports a row it does not have', () => {
    const panel = new MeasurePanel({ onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {}, getUnitSystem: () => 'metric' });
    panel.update(rows);
    expect(panel.focusRow('zz')).toBe(false);
  });
});
