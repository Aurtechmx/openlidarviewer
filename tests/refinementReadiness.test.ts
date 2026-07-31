/**
 * refinementReadiness.test.ts
 *
 * Pins the state-derived readiness model. Untested, the failure is silent and
 * expensive: a verdict of `'settled'` on a set that is still loading tells the
 * renderer to sharpen, and a sharp frame over half a point cloud reads to the
 * user as "this is all the data there is". So the boundaries are checked
 * exactly — `'settled'` only with every wanted node resident and nothing moving,
 * `'unknown'` for an empty wanted set (never `'settled'`), a permanently-failed
 * set stalling at `'loading'` rather than aging into completion, and churn
 * computed without a clock anywhere in the derivation.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateRefinementReadiness,
  SETTLING_MIN_FRACTION,
  type RefinementReadiness,
  type SchedulerReadinessFacts,
} from '../src/render/streaming/refinementReadiness';

/** A fully-idle, empty fact set — each test overrides only what it exercises. */
function facts(overrides: Partial<SchedulerReadinessFacts> = {}): SchedulerReadinessFacts {
  return {
    wantedCount: 0,
    residentCount: 0,
    inFlightCount: 0,
    queuedCount: 0,
    decodedPendingCount: 0,
    failedCount: 0,
    ...overrides,
  };
}

/** The resident fraction of a verdict that has one; `'unknown'` has none. */
function fractionOf(r: RefinementReadiness): number | null {
  return r.phase === 'unknown' ? null : r.fractionResident;
}

/** The churn term of a verdict that has one; `'unknown'` has none. */
function churnOf(r: RefinementReadiness): number | null {
  return r.phase === 'unknown' ? null : r.churn;
}

describe('the empty wanted set refuses a verdict', () => {
  it('reports "unknown" — never "settled" — when nothing is wanted', () => {
    expect(evaluateRefinementReadiness(facts())).toEqual({ phase: 'unknown' });
  });

  it('still refuses when stale residency or in-flight work is reported', () => {
    // Between a stop and the next cull the store can still hold resident nodes
    // and an aborting decode. Nothing is WANTED, so there is nothing to be
    // ready about, and a fraction over a zero denominator would be fabricated.
    const r = evaluateRefinementReadiness(
      facts({ residentCount: 12, inFlightCount: 3, decodedPendingCount: 1 }),
    );
    expect(r).toEqual({ phase: 'unknown' });
  });

  it('carries no derived numbers at all on the "unknown" branch', () => {
    expect(Object.keys(evaluateRefinementReadiness(facts()))).toEqual(['phase']);
  });
});

describe('settled is exact', () => {
  it('reports "settled" with every wanted node resident and nothing moving', () => {
    const r = evaluateRefinementReadiness(facts({ wantedCount: 10, residentCount: 10 }));
    expect(r).toEqual({ phase: 'settled', fractionResident: 1, churn: 0 });
  });

  it('refuses "settled" while a decode is in flight', () => {
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 20, residentCount: 19, inFlightCount: 1 }),
    );
    expect(r.phase).toBe('settling');
  });

  it('refuses "settled" while a node is queued', () => {
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 20, residentCount: 19, queuedCount: 1 }),
    );
    expect(r.phase).toBe('settling');
  });

  it('refuses "settled" while a decoded node awaits commit', () => {
    // `decoded` points exist in memory but nothing has drawn them yet — calling
    // that settled would claim pixels the user cannot see.
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 20, residentCount: 19, decodedPendingCount: 1 }),
    );
    expect(r.phase).toBe('settling');
  });

  it('refuses "settled" when a wanted node is known to have failed', () => {
    // Over the wanted set a node cannot be both resident and failed, so this
    // input is self-contradictory — and an inconsistent count is exactly when a
    // readiness claim must not be made.
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 10, residentCount: 10, failedCount: 1 }),
    );
    expect(r.phase).toBe('loading');
  });
});

describe('the settling / loading boundary', () => {
  it('reports "settling" at exactly SETTLING_MIN_FRACTION with work still moving', () => {
    expect(SETTLING_MIN_FRACTION).toBe(0.95);
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 100, residentCount: 95, queuedCount: 5 }),
    );
    expect(r.phase).toBe('settling');
    expect(fractionOf(r)).toBeCloseTo(0.95, 12);
  });

  it('reports "loading" one node below the threshold', () => {
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 100, residentCount: 94, queuedCount: 6 }),
    );
    expect(r.phase).toBe('loading');
    expect(fractionOf(r)).toBeCloseTo(0.94, 12);
  });

  it('reports "loading" for a set that has barely started', () => {
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 100, residentCount: 2, queuedCount: 90, inFlightCount: 8 }),
    );
    expect(r.phase).toBe('loading');
  });

  it('needs work in motion to call a nearly-complete set "settling"', () => {
    // 99 % resident but nothing moving: the last node is not coming, so this is
    // a stall, not a tail. `'settling'` would promise an arrival.
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 100, residentCount: 99, failedCount: 1 }),
    );
    expect(r.phase).toBe('loading');
  });
});

describe('a stalled set never ages into completion', () => {
  it('holds at "loading" with permanent decode failures and nothing outstanding', () => {
    // The elapsed-time proxy would have called this settled long ago. 20 % of
    // the wanted data is simply not on screen, and the verdict says so.
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 10, residentCount: 8, failedCount: 2 }),
    );
    expect(r.phase).toBe('loading');
    expect(fractionOf(r)).toBeCloseTo(0.8, 12);
  });
});

describe('churn', () => {
  it('is (inFlight + queued) / max(1, wanted)', () => {
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 8, residentCount: 2, inFlightCount: 2, queuedCount: 2 }),
    );
    expect(churnOf(r)).toBe(0.5);
  });

  it('excludes decoded-pending work — a pending commit is not thrash', () => {
    const r = evaluateRefinementReadiness(
      facts({
        wantedCount: 8,
        residentCount: 2,
        inFlightCount: 2,
        queuedCount: 2,
        decodedPendingCount: 4,
      }),
    );
    expect(churnOf(r)).toBe(0.5);
  });

  it('exceeds 1 when far more work is moving than the view wants', () => {
    // The flick-back-and-forth signature: a small wanted set with a large
    // backlog of requests behind it. No timer can produce this reading.
    const r = evaluateRefinementReadiness(
      facts({ wantedCount: 2, residentCount: 0, inFlightCount: 3, queuedCount: 1 }),
    );
    expect(churnOf(r)).toBe(2);
  });

  it('is 0 for a settled set', () => {
    expect(churnOf(evaluateRefinementReadiness(facts({ wantedCount: 4, residentCount: 4 })))).toBe(0);
  });
});

describe('fractionResident', () => {
  it('clamps at 1 when a caller reports more resident nodes than wanted', () => {
    // A global resident count includes nodes held by eviction hysteresis. The
    // clamp keeps a progress readout sane; it never lets the excess vote.
    const r = evaluateRefinementReadiness(facts({ wantedCount: 10, residentCount: 40 }));
    expect(r.phase).toBe('settled');
    expect(fractionOf(r)).toBe(1);
  });

  it('is 0 for a wanted set with nothing resident yet', () => {
    const r = evaluateRefinementReadiness(facts({ wantedCount: 10, queuedCount: 10 }));
    expect(fractionOf(r)).toBe(0);
  });
});

describe('poison counts throw, naming the argument', () => {
  /** A valid settled fact set with exactly one field replaced by poison. */
  function poisoned(field: keyof SchedulerReadinessFacts, value: number): SchedulerReadinessFacts {
    const base: { -readonly [K in keyof SchedulerReadinessFacts]: number } = {
      wantedCount: 10,
      residentCount: 10,
      inFlightCount: 0,
      queuedCount: 0,
      decodedPendingCount: 0,
      failedCount: 0,
    };
    base[field] = value;
    return base;
  }

  const fields: readonly (keyof SchedulerReadinessFacts)[] = [
    'wantedCount',
    'residentCount',
    'inFlightCount',
    'queuedCount',
    'decodedPendingCount',
    'failedCount',
  ];

  for (const field of fields) {
    it(`rejects NaN, Infinity and a negative ${field}`, () => {
      for (const poison of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        const bad = poisoned(field, poison);
        expect(() => evaluateRefinementReadiness(bad)).toThrow(TypeError);
        expect(() => evaluateRefinementReadiness(bad)).toThrow(new RegExp(field));
      }
    });
  }

  it('validates before the empty-set shortcut, so a counting bug is never masked', () => {
    // wantedCount 0 would return 'unknown' without reading the other counts;
    // a broken counter must still surface.
    expect(() => evaluateRefinementReadiness(facts({ residentCount: Number.NaN }))).toThrow(
      /residentCount/,
    );
  });
});

describe('the verdict is derived from state alone', () => {
  it('returns an identical verdict for identical facts, whenever it is called', () => {
    const f = facts({ wantedCount: 50, residentCount: 30, inFlightCount: 4, queuedCount: 16 });
    expect(evaluateRefinementReadiness(f)).toEqual(evaluateRefinementReadiness(f));
  });

  it('does not mutate the facts it was given', () => {
    const f = facts({ wantedCount: 3, residentCount: 1, queuedCount: 2 });
    const before = { ...f };
    evaluateRefinementReadiness(f);
    expect(f).toEqual(before);
  });
});
