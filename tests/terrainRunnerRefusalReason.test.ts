/**
 * terrainRunnerRefusalReason.test.ts
 *
 * When nothing gathers for terrain analysis the status must name the reason.
 * With no layer loaded it asks for a scan. With several visible layers that
 * have not proven a shared frame the gather is empty too, and the old status
 * blamed a missing scan; it now names the combination rule and the way out.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';

function harness(cloudIds: string[]) {
  const statuses: string[] = [];
  const fakeViewer = {
    gatherTerrainPositions: () => null,
    clouds: () => cloudIds,
    getCloud: () => null,
    streamingCloud: null,
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: () => true,
    setBusy: vi.fn(),
    setStatus: (t: string) => { statuses.push(t); },
    update: vi.fn(),
    setContourFrame: vi.fn(),
  } as unknown as AnalysePanel;
  const fakeCrs = { crsRevision: () => 0, current: () => null, context: () => ({}) } as unknown as CrsService;
  const runner = createTerrainAnalysisRunner({
    getViewer: () => fakeViewer,
    getAnalysePanel: () => fakePanel,
    getActiveId: () => cloudIds[0] ?? null,
    crsService: fakeCrs,
  });
  return { runner, statuses };
}

describe('terrain analysis refusal reason', () => {
  it('asks for a scan when nothing is loaded', async () => {
    const h = harness([]);
    await h.runner.run();
    expect(h.statuses.at(-1)).toBe('Load a scan first, then run terrain analysis.');
  });

  it('names the shared-frame rule when several layers are loaded but none gathers', async () => {
    const h = harness(['a', 'b']);
    await h.runner.run();
    expect(h.statuses.at(-1)).toMatch(/have not proven they share a frame/);
    expect(h.statuses.at(-1)).toMatch(/Hide or lock all but one layer/);
  });
});
