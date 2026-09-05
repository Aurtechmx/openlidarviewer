/**
 * terrainRunnerBusyRelease.test.ts — who owns the Analyse panel's busy flag.
 *
 * `run()` sets the busy flag, disabling the Run button and labelling it
 * "Analysing…", then bails at five checkpoints if the run went stale. Staleness
 * folds three different situations into one predicate: a newer run took the
 * token, the active scan changed, or the panel was hidden. Only the first has a
 * successor that will clear the flag. Bailing on the other two left it set, and
 * `setBusy` is the only writer of `disabled` in the tree, so the Run button
 * stayed dead for the rest of the session. Hiding the panel is one click and the
 * core runs off-thread for seconds, so the window is wide open.
 *
 * These tests drive the real runner over a small plane and watch what it does to
 * the panel in each arm.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';
import { spatialContextFrom } from '../src/geo/SpatialContext';

/** A small sloped plane — enough for the pipeline, cheap to analyse. */
function plane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 20; x += 1) {
    for (let y = 0; y < 20; y += 1) pts.push(x, y, 0.02 * x + 0.01 * y);
  }
  return Float32Array.from(pts);
}

interface PanelLog {
  readonly busy: boolean[];
  readonly statuses: string[];
}

/**
 * A runner over a fixed plane, with the panel's visibility and the active scan
 * id under the test's control so each staleness arm can be driven separately.
 */
function harness(opts: { isVisible: () => boolean; getActiveId: () => string | null }) {
  const log: PanelLog = { busy: [], statuses: [] };
  const cloud = {
    sourceOrigin: [500_000, 4_500_000, 0] as [number, number, number],
    bounds: () => ({
      min: [0, 0, 0] as [number, number, number],
      max: [2000, 2000, 100] as [number, number, number],
    }),
  };
  const fakeViewer = {
    gatherTerrainPositions: () => ({
      positions: plane(),
      classification: undefined,
      groundIsDerived: false,
      residentOnly: false,
      sampled: false,
      totalPoints: plane().length / 3,
    }),
    getCloud: () => cloud,
    streamingCloud: null,
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: opts.isVisible,
    setBusy: (b: boolean) => { log.busy.push(b); },
    setStatus: (t: string) => { log.statuses.push(t); },
    update: () => {},
    setContourFrame: () => {},
  } as unknown as AnalysePanel;
  const resolved = {
    kind: 'projected',
    name: 'Test / metre grid',
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    verticalUnitToMetres: 1,
  } as const;
  const context = spatialContextFrom(resolved as unknown as Parameters<typeof spatialContextFrom>[0]);
  const fakeCrs: Pick<CrsService, 'current' | 'context' | 'crsRevision'> = {
  // The frame revision the run is pinned to; constant in these doubles.
  crsRevision: () => 0,
    current: () => resolved as unknown as ReturnType<CrsService['current']>,
    context: () => context,
  };
  const runner = createTerrainAnalysisRunner({
    getViewer: () => fakeViewer,
    getAnalysePanel: () => fakePanel,
    getActiveId: opts.getActiveId,
    crsService: fakeCrs,
  });
  return { runner, log };
}

describe('the Analyse panel never keeps a busy flag nobody owns', () => {
  // Node has no Worker; the runner announces its expected main-thread fallback.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('releases the Run button when the panel is hidden mid-run, and says why', async () => {
    let visible = true;
    const { runner, log } = harness({ isVisible: () => visible, getActiveId: () => 'scan-1' });
    // Hide the panel on the first visibility read AFTER the run has claimed the
    // busy flag. That is exactly the user gesture: start an analysis, collapse
    // the panel, go and look at the scan.
    const started = runner.run();
    visible = false;
    await started;

    expect(log.busy[0]).toBe(true);
    expect(log.busy).toContain(false);
    expect(log.busy.at(-1)).toBe(false);
    expect(log.statuses.at(-1)).toBe('Analysis stopped.');
  });

  it('releases the button but leaves the copy alone when the scan itself went away', async () => {
    let visible = true;
    let activeId: string | null = 'scan-1';
    const { runner, log } = harness({ isVisible: () => visible, getActiveId: () => activeId });
    const started = runner.run();
    // A scan close: the id changes and the panel goes away with it. The reset
    // owns the panel's copy here, so the runner must not write over it.
    activeId = null;
    visible = false;
    await started;

    expect(log.busy.at(-1)).toBe(false);
    expect(log.statuses).not.toContain('Analysis stopped.');
  });

  it('leaves everything to the successor when a newer run takes the token', async () => {
    const { runner, log } = harness({ isVisible: () => true, getActiveId: () => 'scan-1' });
    // Two runs in flight. The first loses the token immediately and must not
    // touch the flag, or it would clear the state the winner just claimed.
    const first = runner.run();
    const second = runner.run();
    await Promise.all([first, second]);

    expect(log.busy.filter((b) => b)).toHaveLength(2);
    // Exactly one release: the winner's. The loser bailed silently.
    expect(log.busy.filter((b) => !b)).toHaveLength(1);
    expect(log.busy.at(-1)).toBe(false);
  });

  it('leaves the button enabled after a completed run', async () => {
    const { runner, log } = harness({ isVisible: () => true, getActiveId: () => 'scan-1' });
    await runner.run();
    expect(log.busy.at(-1)).toBe(false);
  });
});
