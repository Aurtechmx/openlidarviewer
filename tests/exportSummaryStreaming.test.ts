/**
 * The Export summary of a streamed scan. It counts the resident frontier, which
 * grows as nodes arrive; it used to be read once when the scan opened and kept
 * "Open a scan to export. · (0 points)" while millions of points were on screen.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { installFakeDom, type FakeEl } from './helpers/exportPanelHarness';
import { WAITING_FOR_POINTS } from '../src/ui/ExportPanel';

beforeAll(() => { installFakeDom(); });

async function panel(state: { points: number; pending: boolean }) {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const p = new ExportPanel({
    getCloud: () => null,
    hasFullSource: () => false,
    isReduced: () => true,
    getFullCloud: async () => null,
    isStreamingPending: () => state.pending,
    summaryInfo: () => ({ pointCount: state.points, hasRgb: false, hasGpsTime: false, crsName: null, hasWkt: false, classProvenance: 'source' }),
  });
  const root = p.element as unknown as FakeEl;
  return { p, summary: () => root.findByClass('olv-export-summary')[0]?.textContent ?? '' };
}

describe('Export summary of a streamed scan', () => {
  it('says it is waiting for points, not that no scan is open, before the first node', async () => {
    const { summary } = await panel({ points: 0, pending: true });
    expect(summary()).toBe(WAITING_FOR_POINTS);
  });

  it('shows the count once nodes arrive and refreshSummary is called', async () => {
    const state = { points: 0, pending: true };
    const { p, summary } = await panel(state);
    expect(summary()).toBe(WAITING_FOR_POINTS);
    state.points = 2_400_000;
    state.pending = false;
    p.refreshSummary();
    expect(summary()).toContain('2,400,000 points');
    expect(summary()).not.toContain('Open a scan to export');
  });

  it('still says "Open a scan to export" when nothing is open', async () => {
    const { summary } = await panel({ points: 0, pending: false });
    expect(summary()).toContain('Open a scan to export.');
  });
});
