/**
 * analysisActionsFlowPulse.test.ts — Flow Pulse Lab's chunk-load busy/failure
 * states (F7: ANNOTATE-SIM-F7). DOM-free: `contributeAnalysisActions` is
 * called directly with fake deps, the same shape `actionDefinitions.ts`
 * would build.
 *
 * `showLassoToast` is optional on `AnalysisActionDeps` (the current caller,
 * `src/app/actionDefinitions.ts`, does not thread it through yet — see the
 * interface's doc comment) — this file pins BOTH branches: the ready,
 * toast-driven behaviour once that wiring lands, and today's unwired
 * `console.warn` fallback, so neither regresses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let loadResult: 'success' | 'reject' | 'undefined' = 'success';
const events: string[] = [];
const openFlowPulseLab = vi.fn((input: unknown, _opts?: unknown) => { events.push(`open:${input === null ? 'none' : 'surface'}`); });
const openFlowPulsePreparing = vi.fn(() => { events.push('preparing'); return { close: () => events.push('preparing-closed') }; });
const openTerrainAccessLab = vi.fn((input: unknown) => { events.push(`ta-open:${input === null ? 'none' : 'surface'}`); });
const openTerrainAccessPreparing = vi.fn(() => { events.push('ta-preparing'); return { close: () => events.push('ta-preparing-closed') }; });
const loadFlowPulseLab = vi.fn(() => {
  if (loadResult === 'reject') return Promise.reject(new Error('flow-pulse chunk failed'));
  if (loadResult === 'undefined') return Promise.resolve(undefined as unknown as { openFlowPulseLab: typeof openFlowPulseLab });
  return Promise.resolve({ openFlowPulseLab, openFlowPulsePreparing });
});

vi.mock('../src/lazyChunks', () => ({
  loadFlowPulseLab: () => loadFlowPulseLab(),
  loadTerrainAccessLab: () => Promise.resolve({ openTerrainAccessLab, openTerrainAccessPreparing }),
}));

import { contributeAnalysisActions, type AnalysisActionDeps } from '../src/app/actions/analysisActions';

function fakeToast() {
  const calls: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  return { show: (message: string, action?: { label: string; onClick: () => void }) => { calls.push({ message, action }); }, calls };
}

function fakeDeps(overrides: Partial<AnalysisActionDeps> = {}): AnalysisActionDeps {
  return {
    terrainAnalysisEntry: {
      showAnalyseMode: vi.fn(),
      showPanel: vi.fn(() => Promise.resolve({ hasResult: true, flowInput: null })),
      run: vi.fn(),
    },
    observatoryEntry: {} as never,
    buildCurrentStoryInputs: vi.fn(),
    ...overrides,
  };
}

function flowPulseAction(deps: AnalysisActionDeps) {
  const action = contributeAnalysisActions(deps).find((a) => a.id === 'analyse.flowPulse');
  if (!action) throw new Error('analyse.flowPulse action not found');
  return action;
}

beforeEach(() => {
  loadResult = 'success';
  events.length = 0;
  openFlowPulseLab.mockClear();
  loadFlowPulseLab.mockClear();
});

describe('Flow Pulse Lab action — toast wired', () => {
  it('opens the lab on a successful load', async () => {
    const toast = fakeToast();
    const deps = fakeDeps({ showLassoToast: toast });
    flowPulseAction(deps).run();
    await new Promise((r) => setTimeout(r, 0));
    // The lab is a modal: opening it leaves the rail's mode alone.
    expect(deps.terrainAnalysisEntry.showAnalyseMode).not.toHaveBeenCalled();
    expect(openFlowPulseLab).toHaveBeenCalledTimes(1);
    expect(toast.calls).toEqual([]);
  });

  it('reports a rejected chunk through the toast with a Try again action', async () => {
    loadResult = 'reject';
    const toast = fakeToast();
    flowPulseAction(fakeDeps({ showLassoToast: toast })).run();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.calls).toHaveLength(1);
    expect(toast.calls[0].message).toBe('flow-pulse chunk failed');
    expect(toast.calls[0].action?.label).toBe('Try again');
    expect(openFlowPulseLab).not.toHaveBeenCalled();
  });

  it('reports the stale-chunk "resolves to undefined" case the same way', async () => {
    loadResult = 'undefined';
    const toast = fakeToast();
    flowPulseAction(fakeDeps({ showLassoToast: toast })).run();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.calls).toHaveLength(1);
    expect(openFlowPulseLab).not.toHaveBeenCalled();
  });

  it('a "Try again" action that succeeds actually opens the lab', async () => {
    loadResult = 'reject';
    const toast = fakeToast();
    flowPulseAction(fakeDeps({ showLassoToast: toast })).run();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.calls).toHaveLength(1);

    loadResult = 'success';
    toast.calls[0].action?.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(openFlowPulseLab).toHaveBeenCalledTimes(1);
  });
});

describe('Flow Pulse Lab action — no toast wired (current actionDefinitions.ts wiring)', () => {
  it('falls back to console.warn on failure, never an unhandled rejection', async () => {
    loadResult = 'reject';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    flowPulseAction(fakeDeps()).run();
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(warnSpy).toHaveBeenCalledWith('[flow-pulse] lab chunk failed to load', expect.any(Error));
    expect(unhandled).toEqual([]);
    warnSpy.mockRestore();
  });

  it('still opens the lab on a successful load', async () => {
    flowPulseAction(fakeDeps()).run();
    await new Promise((r) => setTimeout(r, 0));
    expect(openFlowPulseLab).toHaveBeenCalledTimes(1);
  });
});

describe('Terrain Access action', () => {
  it('does not switch the rail to Analyse, since its lab opens as a modal', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = fakeDeps();
    const action = contributeAnalysisActions(deps).find((a) => a.id === 'analyse.terrainAccess');
    action?.run();
    expect(action).toBeDefined();
    expect(deps.terrainAnalysisEntry.showAnalyseMode).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('one click to a lab result: terrain runs first when there is none', () => {
  /** A panel with no terrain result until `run` settles. */
  function terrainDeps() {
    let analysed = false;
    const surface = { dtm: 'surface' };
    const run = vi.fn(async () => { events.push('terrain-run'); analysed = true; });
    const showPanel = vi.fn(async () => ({
      hasResult: analysed,
      flowInput: analysed ? (surface as never) : null,
      terrainAccessInput: analysed ? (surface as never) : null,
    }));
    return fakeDeps({ terrainAnalysisEntry: { showAnalyseMode: vi.fn(), showPanel, run } });
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

  for (const [id, prefix] of [['analyse.flowPulse', ''], ['analyse.terrainAccess', 'ta-']] as const) {
    it(`${id}: shows progress on the lab page, runs terrain, then opens the lab on the new surface`, async () => {
      const deps = terrainDeps();
      contributeAnalysisActions(deps).find((a) => a.id === id)!.run();
      await settle();
      expect(events).toEqual([`${prefix}preparing`, 'terrain-run', `${prefix}open:surface`, `${prefix}preparing-closed`]);
      // It never leaves for the Terrain page.
      expect(deps.terrainAnalysisEntry.showAnalyseMode).not.toHaveBeenCalled();
    });

    it(`${id}: opens nothing when the progress page closed while terrain ran (the scan was closed)`, async () => {
      const deps = terrainDeps();
      const preparing = id === 'analyse.flowPulse' ? openFlowPulsePreparing : openTerrainAccessPreparing;
      // The page host runs the page's close when the scan closes; this one closes mid-run.
      preparing.mockImplementationOnce(((onClose?: () => void) => {
        events.push(`${prefix}preparing`);
        let done = false;
        const close = (): void => { if (done) return; done = true; events.push(`${prefix}preparing-closed`); onClose?.(); };
        const run = deps.terrainAnalysisEntry.run as unknown as { mockImplementationOnce(f: () => Promise<void>): void };
        run.mockImplementationOnce(async () => { events.push('terrain-run'); close(); });
        return { close };
      }) as never);
      contributeAnalysisActions(deps).find((a) => a.id === id)!.run();
      await settle();
      expect(events).toEqual([`${prefix}preparing`, 'terrain-run', `${prefix}preparing-closed`]);
    });

    it(`${id}: with a terrain result, opens the lab at once and runs nothing`, async () => {
      const deps = terrainDeps();
      await deps.terrainAnalysisEntry.run();
      events.length = 0;
      contributeAnalysisActions(deps).find((a) => a.id === id)!.run();
      await settle();
      expect(events).toEqual([`${prefix}open:surface`]);
    });
  }

  it('a lab that opened without a surface runs terrain again from its notice', async () => {
    const deps = fakeDeps(); // a result, but no flow input
    flowPulseAction(deps).run();
    await settle();
    expect(events).toEqual(['open:none']);
    const opts = openFlowPulseLab.mock.calls[0]![1] as unknown as { onRunTerrain: () => void };
    opts.onRunTerrain();
    await settle();
    expect(deps.terrainAnalysisEntry.run).toHaveBeenCalledTimes(1);
    expect(events.slice(1)).toEqual(['preparing', 'open:none', 'preparing-closed']);
  });
});
