/**
 * The profile sheet PDF prints grades and chainages, so on a geographic CRS it
 * is refused like the profile CSV: its buttons are disabled with the reason,
 * and the shared export path (also used by the docked workbench) rejects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import { GEOGRAPHIC_CRS_MEASURE_NOTICE } from '../src/render/measure/format';
import { FakeEl, installFakeDom, uninstallFakeDom } from './support/measurePanelDom';

beforeEach(() => installFakeDom({ ns: true, docListeners: true }));
afterEach(() => uninstallFakeDom());

function profile(): MeasurementSummary {
  const profileChart = Array.from({ length: 8 }, (_, i) => ({ distance: i * 0.0001, height: 100 + i, count: 12 }));
  return { id: 'p1', kind: 'profile', name: 'Section A', value: '—', profileChart };
}

function mount(geographic: boolean): MeasurePanel {
  const panel = new MeasurePanel({
    onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  panel.setGeographicNotice(geographic);
  panel.update([profile()]);
  return panel;
}

const pdfButtons = (panel: MeasurePanel): FakeEl[] =>
  (panel.element as unknown as FakeEl).querySelectorAll('button').filter((b) => b.textContent.includes('PDF'));

describe('profile sheet PDF on a geographic CRS', () => {
  it('rejects through the shared export path with the geographic notice', async () => {
    await expect(mount(true).exportProfilePdf('p1')).rejects.toThrow(GEOGRAPHIC_CRS_MEASURE_NOTICE);
  });

  it('disables every profile PDF button, with the reason as its title', () => {
    const buttons = pdfButtons(mount(true));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
      expect((b as unknown as { title: string }).title).toBe(GEOGRAPHIC_CRS_MEASURE_NOTICE);
    }
  });

  it('leaves the buttons enabled on a projected frame', () => {
    for (const b of pdfButtons(mount(false))) expect(b.disabled).toBe(false);
  });
});
