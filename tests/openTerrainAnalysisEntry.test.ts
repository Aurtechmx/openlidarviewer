/**
 * openTerrainAnalysisEntry.test.ts
 *
 * Terrain analysis and its contours both sit behind the Analyse panel, so the
 * palette's two entries route through one helper. "Run terrain analysis" asks
 * for a fresh run; "Create contours" asks for the panel, and runs only when
 * there is nothing on it yet, so it reveals an existing result rather than
 * recomputing a surface the user already has.
 */

import { describe, it, expect, vi } from 'vitest';
import { openTerrainAnalysis } from '../src/app/openTerrainAnalysis';

function deps(hasResult: boolean) {
  return {
    showAnalyseMode: vi.fn(),
    showPanel: vi.fn(async () => ({ hasResult })),
    run: vi.fn(),
  };
}

describe('openTerrainAnalysis', () => {
  it('always shows the Analyse mode and the panel, in that order', async () => {
    const d = deps(true);
    await openTerrainAnalysis(d);
    expect(d.showAnalyseMode).toHaveBeenCalledTimes(1);
    expect(d.showPanel).toHaveBeenCalledTimes(1);
    expect(d.showAnalyseMode.mock.invocationCallOrder[0])
      .toBeLessThan(d.showPanel.mock.invocationCallOrder[0]);
  });

  it('runs on a scan with no result, whichever entry asked', async () => {
    const cold = deps(false);
    await openTerrainAnalysis(cold, false);
    expect(cold.run).toHaveBeenCalledTimes(1);
    const coldRerun = deps(false);
    await openTerrainAnalysis(coldRerun, true);
    expect(coldRerun.run).toHaveBeenCalledTimes(1);
  });

  it('leaves an analysed scan alone unless a re-run was asked for', async () => {
    const reveal = deps(true);
    await openTerrainAnalysis(reveal, false);
    expect(reveal.run).not.toHaveBeenCalled();
    const rerun = deps(true);
    await openTerrainAnalysis(rerun, true);
    expect(rerun.run).toHaveBeenCalledTimes(1);
  });

  it('runs after the panel is on screen, never before', async () => {
    const d = deps(false);
    await openTerrainAnalysis(d);
    expect(d.showPanel.mock.invocationCallOrder[0]).toBeLessThan(d.run.mock.invocationCallOrder[0]);
  });
});
