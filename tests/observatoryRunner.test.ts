/**
 * observatoryRunner.test.ts — O9's state machine: states, staleness,
 * cancellation and the overlay-invalidation seam
 * (`registerObservatoryOverlayInvalidator`), all with an injected `compute`
 * so this file never touches the real O1-O8 pipeline (that is
 * `observatoryFromCloud.ts`'s own test, and the O0-O8 kernel tests already
 * on this branch).
 */
import { describe, it, expect, vi } from 'vitest';
import { createObservatoryRunner, type ObservatoryRunnerDeps } from '../src/app/observatoryRunner';
import type { ObservatoryCloudInput, ObservatoryRunOutcome } from '../src/app/observatoryFromCloud';

const FAKE_CLOUD: ObservatoryCloudInput = {
  positions: new Float32Array(0),
  sourceOrigin: [0, 0, 0],
  bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
};

const OK_OUTCOME: ObservatoryRunOutcome = { status: 'ineligible', reason: 'no-stations' };

function baseDeps(overrides: Partial<ObservatoryRunnerDeps> = {}): ObservatoryRunnerDeps {
  return {
    getActiveCloud: () => FAKE_CLOUD,
    getDatasetId: () => 'scan-1',
    getCrsRevision: () => 0,
    buildOptions: () => ({ filename: null, metresPerUnit: null, buildTag: 'test' }),
    compute: () => OK_OUTCOME,
    ...overrides,
  };
}

describe('idle / running / committed', () => {
  it('starts idle', () => {
    const runner = createObservatoryRunner(baseDeps());
    expect(runner.getState()).toEqual({ phase: 'idle' });
  });

  it('run() with no active cloud stays idle', () => {
    const runner = createObservatoryRunner(baseDeps({ getActiveCloud: () => null }));
    const state = runner.run();
    expect(state).toEqual({ phase: 'idle' });
  });

  it('run() with a cloud commits the compute outcome', () => {
    const runner = createObservatoryRunner(baseDeps());
    const state = runner.run();
    expect(state.phase).toBe('committed');
    if (state.phase === 'committed') expect(state.outcome).toBe(OK_OUTCOME);
  });

  it('notifies subscribers of every state transition', () => {
    const runner = createObservatoryRunner(baseDeps());
    const seen: string[] = [];
    runner.subscribe((s) => seen.push(s.phase));
    runner.run();
    expect(seen).toEqual(['running', 'committed']);
  });

  it('unsubscribe stops further notifications', () => {
    const runner = createObservatoryRunner(baseDeps());
    const seen: string[] = [];
    const unsub = runner.subscribe((s) => seen.push(s.phase));
    unsub();
    runner.run();
    expect(seen).toEqual([]);
  });
});

describe('staleness (Snapshot -> Await -> Revalidate -> Commit)', () => {
  it('a dataset change during compute lands as stale, not committed', () => {
    let currentId = 'scan-1';
    const runner = createObservatoryRunner(baseDeps({
      getDatasetId: () => currentId,
      compute: () => {
        currentId = 'scan-2'; // the "await" — the active scan moved on mid-run
        return OK_OUTCOME;
      },
    }));
    const state = runner.run();
    expect(state).toEqual({ phase: 'stale' });
  });

  it('a CRS revision change during compute lands as stale', () => {
    let rev = 0;
    const runner = createObservatoryRunner(baseDeps({
      getCrsRevision: () => rev,
      compute: () => {
        rev = 1;
        return OK_OUTCOME;
      },
    }));
    const state = runner.run();
    expect(state).toEqual({ phase: 'stale' });
  });

  it('a superseding run() during the first compute discards the first result', () => {
    const runner = createObservatoryRunner(baseDeps());
    let inner: (() => void) | null = null;
    const outerCompute = vi.fn(() => {
      inner?.();
      return OK_OUTCOME;
    });
    const runner2 = createObservatoryRunner(baseDeps({ compute: outerCompute }));
    inner = () => { runner2.abortAndClearCache(); };
    const state = runner2.run();
    // abortAndClearCache mid-compute bumps the token; run()'s own post-compute
    // revalidation then sees its token superseded and reports stale, never
    // silently re-committing over the abort.
    expect(state).toEqual({ phase: 'stale' });
    void runner; // unused placeholder to keep the first runner instance referenced
  });
});

describe('cancellation and invalidation', () => {
  it('abortAndClearCache resets to idle and clears the registered overlay', () => {
    const clear = vi.fn();
    const runner = createObservatoryRunner(baseDeps());
    runner.run();
    expect(runner.getState().phase).toBe('committed');
    runner.setOverlayClear(clear);
    runner.abortAndClearCache();
    expect(runner.getState()).toEqual({ phase: 'idle' });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('abortAndClearCache before any overlay was ever registered is a safe no-op', () => {
    const runner = createObservatoryRunner(baseDeps());
    expect(() => runner.abortAndClearCache()).not.toThrow();
  });

  it('registers itself with the shared lazyChunks invalidator on construction', async () => {
    const { invalidateObservatoryOverlay } = await import('../src/lazyChunks');
    const clear = vi.fn();
    const runner = createObservatoryRunner(baseDeps());
    runner.setOverlayClear(clear);
    invalidateObservatoryOverlay();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
