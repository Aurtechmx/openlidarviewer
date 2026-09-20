import { describe, it, expect } from 'vitest';
import {
  afterFailure,
  runContinuityPass,
  sourceRenderingAvailable,
  type ContinuityFailure,
} from '../src/render/continuity/continuityFailure';
import { TIER_ORDER, type ContinuityTier } from '../src/render/continuity/continuityTier';

const FAILURES: ContinuityFailure[] = [
  'CONTINUITY_RENDER_UNAVAILABLE',
  'history-over-ceiling',
  'history-allocation-failed',
  'pass-threw',
];

describe('after a failure', () => {
  // A device that cannot keep a history may still close gaps. Dropping
  // everything on the first refusal gives up capabilities never implicated.
  it.each(FAILURES)('gives up one rung for %s', (failure) => {
    const o = afterFailure('full', failure);
    expect(o.tier).toBe('closure');
    expect(o.degraded).toBe(true);
    expect(o.failure).toBe(failure);
  });

  it('walks down to source rendering and stops there', () => {
    let tier: ContinuityTier = 'full';
    const walked: ContinuityTier[] = [tier];
    for (let i = 0; i < 6; i++) {
      tier = afterFailure(tier, 'pass-threw').tier;
      walked.push(tier);
    }
    expect(walked.slice(0, 4)).toEqual([...TIER_ORDER]);
    expect(tier).toBe('source');
  });

  it('reports nothing given up once there is nothing left', () => {
    const o = afterFailure('source', 'pass-threw');
    expect(o.tier).toBe('source');
    expect(o.degraded).toBe(false);
  });

  it('never returns a richer tier than the one that failed', () => {
    for (const tier of TIER_ORDER) {
      for (const failure of FAILURES) {
        const o = afterFailure(tier, failure);
        expect(TIER_ORDER.indexOf(o.tier)).toBeGreaterThanOrEqual(TIER_ORDER.indexOf(tier));
      }
    }
  });

  it('always leaves something to draw with', () => {
    for (const tier of TIER_ORDER) {
      // The outcome is computed and deliberately not consulted: no failure can
      // answer this differently, which is why it takes nothing.
      afterFailure(tier, 'pass-threw');
      expect(sourceRenderingAvailable()).toBe(true);
    }
  });
});

describe('running a pass', () => {
  it('returns what the pass returned', () => {
    expect(runContinuityPass(() => 42)).toBe(42);
  });

  it('returns nothing when the pass throws, rather than throwing', () => {
    expect(runContinuityPass(() => {
      throw new Error('gpu said no');
    })).toBeNull();
  });

  // A pass can throw anything, not only an Error.
  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an object', { code: 'x' }],
  ])('swallows %s', (_label, thrown) => {
    expect(
      runContinuityPass(() => {
        throw thrown;
      }),
    ).toBeNull();
  });

  it('tells the reporter what failed and why', () => {
    const seen: [ContinuityFailure, unknown][] = [];
    const cause = new Error('device lost');
    runContinuityPass(
      () => {
        throw cause;
      },
      (f, c) => seen.push([f, c]),
    );
    expect(seen).toEqual([['pass-threw', cause]]);
  });

  it('does not call the reporter when the pass succeeds', () => {
    let calls = 0;
    expect(runContinuityPass(() => 1, () => { calls += 1; })).toBe(1);
    expect(calls).toBe(0);
  });

  // A diagnostics surface that throws while recording a failure would turn a
  // degraded frame into a broken one: the failure this exists to prevent,
  // arriving through its own handler.
  it('survives a reporter that throws', () => {
    expect(
      runContinuityPass(
        () => {
          throw new Error('pass');
        },
        () => {
          throw new Error('reporter');
        },
      ),
    ).toBeNull();
  });

  it('lets a pass return a falsy value without looking like a failure', () => {
    expect(runContinuityPass(() => 0)).toBe(0);
    expect(runContinuityPass(() => false)).toBe(false);
    expect(runContinuityPass(() => '')).toBe('');
  });
});
