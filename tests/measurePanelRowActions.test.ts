/**
 * measurePanelRowActions.test.ts: each Measurements row has a Copy action when
 * the host wires one, writing what the result card's Copy writes, and the
 * panel's deleteRow runs the same delete the row's × does, for the result
 * card's Delete.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../src/ui/ResultFocus', () => ({ openResultFocus: () => {} }));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => { installFakeDom(); });

const rows = [
  { id: 'a', kind: 'distance', name: 'Line A', value: '4 m' },
  { id: 'b', kind: 'area', name: 'Ring B', value: '9 m²' },
] as MeasurementSummary[];

function mount(onCopy?: (id: string) => void) {
  const deleted: string[] = [];
  const panel = new MeasurePanel({
    onDelete: (id) => deleted.push(id), onRename: () => {}, onExport: () => {}, onImport: () => {},
    getUnitSystem: () => 'metric', onCopy,
  });
  panel.update(rows);
  return { panel, deleted, root: panel.element as unknown as FakeEl };
}

describe('MeasurePanel row actions', () => {
  it('shows Copy on every row when wired, passing the row id', () => {
    const copied: string[] = [];
    const { root } = mount((id) => copied.push(id));
    const btns = root.querySelectorAll('.olv-mp-copy');
    expect(btns).toHaveLength(2);
    expect(btns[1]!.getAttribute('aria-label')).toBe('Copy Ring B');
    btns[1]!.click();
    expect(copied).toEqual(['b']);
  });

  it('has no Copy when the host did not wire it', () => {
    expect(mount().root.querySelectorAll('.olv-mp-copy')).toHaveLength(0);
  });

  it('deleteRow runs the row delete for a listed id and refuses an unknown one', () => {
    const { panel, deleted } = mount();
    expect(panel.deleteRow('a')).toBe(true);
    expect(deleted).toEqual(['a']);
    expect(panel.deleteRow('zz')).toBe(false);
    expect(deleted).toEqual(['a']);
  });
});
