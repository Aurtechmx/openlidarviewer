/**
 * measurePanelUseAsClip.test.ts — the "Use as clipping region" row action
 * (spec 3) appears on Box rows only, and only when the host wired it; a click
 * hands the measurement's stable id to the host.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../src/ui/ResultFocus', () => ({ openResultFocus: () => {} }));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => { installFakeDom(); });

function mount(rows: MeasurementSummary[], onUseAsClip?: (id: string) => void): FakeEl {
  const panel = new MeasurePanel({
    onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {},
    getUnitSystem: () => 'metric', onUseAsClip,
  });
  panel.update(rows);
  return panel.element as unknown as FakeEl;
}

const box = { id: 'b-7', kind: 'box', name: 'Box 1', value: '2 m³' } as MeasurementSummary;
const dist = { id: 'd-1', kind: 'distance', name: 'Line', value: '4 m' } as MeasurementSummary;

describe('MeasurePanel — Use as clipping region', () => {
  it('shows on Box rows only and passes the stable id', () => {
    const ids: string[] = [];
    const root = mount([box, dist], (id) => ids.push(id));
    const btns = root.querySelectorAll('.olv-mp-use-clip');
    expect(btns).toHaveLength(1);
    expect(btns[0].getAttribute('aria-label')).toBe('Use Box 1 as clipping region');
    btns[0].click();
    expect(ids).toEqual(['b-7']);
  });

  it('is absent when the host did not wire it', () => {
    expect(mount([box]).querySelectorAll('.olv-mp-use-clip')).toHaveLength(0);
  });
});
