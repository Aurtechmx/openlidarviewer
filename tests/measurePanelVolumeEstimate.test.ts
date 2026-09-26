/**
 * measurePanelVolumeEstimate.test.ts: every volume row in the Measurements
 * panel carries the "not survey-grade" estimate caveat.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../src/ui/ResultFocus', () => ({ openResultFocus: () => {} }));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import { VOLUME_ESTIMATE_NOTICE } from '../src/render/measure/format';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
});

function mount(s: MeasurementSummary): FakeEl {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  panel.update([s]);
  return panel.element as unknown as FakeEl;
}

const notes = (root: FakeEl): string[] =>
  root.querySelectorAll('.olv-mp-volume-estimate').map((n) => n.textContent);

describe('MeasurePanel volume estimate caveat', () => {
  it('shows the caveat under a volume result', () => {
    const root = mount({ id: 'v1', kind: 'volume', name: 'Pile A', value: '12.00 m³' } as MeasurementSummary);
    expect(notes(root)).toEqual([VOLUME_ESTIMATE_NOTICE]);
    expect(VOLUME_ESTIMATE_NOTICE).toMatch(/not survey-grade/);
  });

  it('keeps it alongside the resident-node caveat', () => {
    const root = mount({
      id: 'v2', kind: 'volume', name: 'Pile B', value: '3.00 m³', volumeResidentOnly: true,
    } as MeasurementSummary);
    expect(notes(root)).toEqual([VOLUME_ESTIMATE_NOTICE]);
    expect(root.querySelectorAll('.olv-mp-chart-caveat').map((n) => n.textContent).join(' ')).toMatch(/Resident-node/);
  });

  it('does not add it to other kinds', () => {
    const root = mount({ id: 'd1', kind: 'distance', name: 'Line', value: '4.00 m' } as MeasurementSummary);
    expect(notes(root)).toEqual([]);
  });
});
