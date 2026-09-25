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
const openFlowPulseLab = vi.fn();
const loadFlowPulseLab = vi.fn(() => {
  if (loadResult === 'reject') return Promise.reject(new Error('flow-pulse chunk failed'));
  if (loadResult === 'undefined') return Promise.resolve(undefined as unknown as { openFlowPulseLab: typeof openFlowPulseLab });
  return Promise.resolve({ openFlowPulseLab });
});

vi.mock('../src/lazyChunks', () => ({
  loadFlowPulseLab: () => loadFlowPulseLab(),
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
  openFlowPulseLab.mockClear();
  loadFlowPulseLab.mockClear();
});

describe('Flow Pulse Lab action — toast wired', () => {
  it('opens the lab on a successful load', async () => {
    const toast = fakeToast();
    const deps = fakeDeps({ showLassoToast: toast });
    flowPulseAction(deps).run();
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.terrainAnalysisEntry.showAnalyseMode).toHaveBeenCalledTimes(1);
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
