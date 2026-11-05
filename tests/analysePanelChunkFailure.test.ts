/** analysePanelChunkFailure.test.ts: an optional Analyse part whose chunk fails says why, and a retry can bring it back. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installAnalysePanelDom } from './helpers/analysePanelDom';

const state = vi.hoisted(() => ({ range: 0, present: false }));
vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<object>()),
  loadRangeWorkbenchMount: () => { state.range++; return Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://h/r.js')); },
}));
vi.mock('../src/model/organizedRangeLink', async (orig) => ({
  ...(await orig<object>()),
  organizedRangeFor: () => (state.present ? { layerId: 'a', set: {}, recordPosition: () => {}, upAxis: 'z' } : null),
}));

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement ??= class {};
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Range frames launcher', () => {
  it('keeps the row, shows the reason, and a scan with no grid has no row', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    state.present = false;
    const none = new AnalysePanel({ getActiveScanId: () => 'a' });
    await tick();
    expect((none as unknown as { _rangeLauncher: { children: unknown[] } })._rangeLauncher.children).toHaveLength(0);
    state.present = true;
    const p = new AnalysePanel({ getActiveScanId: () => 'a' });
    (p as unknown as { _refreshRangeLauncher(): void })._refreshRangeLauncher();
    await tick();
    expect(state.range).toBeGreaterThan(0);
    // hasPart counts these children; the fake DOM has no childElementCount.
    const host = (p as unknown as { _rangeLauncher: { textContent: string; children: unknown[] } })._rangeLauncher;
    expect(host.children).toHaveLength(1);
    expect(host.textContent).toContain('Range frames could not load');
  });
});
