/**
 * streamingBudget.test.ts — the resolved resident-point + cache budgets per
 * quality preset and device class. Pins the trimmed desktop "balanced" default
 * (2.5M, down from 4M — the steady-state navigation cost is dominated by the
 * resident-point draw) plus the ordering invariants every device must keep.
 */

import { describe, it, expect } from 'vitest';
import {
  streamingBudgets,
  selectWithinBudget,
  type ScoredCandidate,
} from '../src/render/streaming/streamingBudget';

describe('streamingBudgets — desktop resident-point budgets', () => {
  it('resolves the trimmed balanced default and the unchanged low/high', () => {
    expect(streamingBudgets('low', false).pointBudget).toBe(1_500_000);
    expect(streamingBudgets('balanced', false).pointBudget).toBe(2_500_000);
    expect(streamingBudgets('high', false).pointBudget).toBe(8_000_000);
  });

  it('keeps the presets strictly ordered low < balanced < high', () => {
    const low = streamingBudgets('low', false).pointBudget;
    const bal = streamingBudgets('balanced', false).pointBudget;
    const high = streamingBudgets('high', false).pointBudget;
    expect(low).toBeLessThan(bal);
    expect(bal).toBeLessThan(high);
  });
});

describe('streamingBudgets — mobile is more conservative', () => {
  it('every mobile preset is below its desktop counterpart', () => {
    for (const q of ['low', 'balanced', 'high'] as const) {
      expect(streamingBudgets(q, true).pointBudget).toBeLessThan(
        streamingBudgets(q, false).pointBudget,
      );
    }
  });

  it('mobile presets stay ordered low < balanced < high', () => {
    expect(streamingBudgets('low', true).pointBudget).toBeLessThan(
      streamingBudgets('balanced', true).pointBudget,
    );
    expect(streamingBudgets('balanced', true).pointBudget).toBeLessThan(
      streamingBudgets('high', true).pointBudget,
    );
  });
});

describe('streamingBudgets — shape', () => {
  it('returns finite, positive point and cache budgets', () => {
    const b = streamingBudgets('balanced', false);
    expect(Number.isFinite(b.pointBudget)).toBe(true);
    expect(b.pointBudget).toBeGreaterThan(0);
    expect(b.chunkCacheBytes).toBeGreaterThan(0);
  });
});

describe('selectWithinBudget — greedy fill', () => {
  const c = (id: string, score: number, pointCount = 100): ScoredCandidate => ({ id, score, pointCount });

  it('fills in score order until the budget is reached', () => {
    const wanted = selectWithinBudget([c('a', 10), c('b', 9), c('c', 8)], 250);
    expect(wanted).toEqual(new Set(['a', 'b']));
  });

  it('never selects a zero-score (culled) candidate', () => {
    const wanted = selectWithinBudget([c('a', 10), c('b', 0)], 1_000);
    expect(wanted).toEqual(new Set(['a']));
  });

  it('always renders the top node even if it alone exceeds the budget', () => {
    expect(selectWithinBudget([c('a', 10, 500)], 100)).toEqual(new Set(['a']));
  });

  it('passing options with margin 0 is identical to the plain fill', () => {
    const cands = [c('x', 10.5), c('r', 10)];
    expect(selectWithinBudget(cands, 150, { resident: new Set(['r']), stickyMargin: 0 })).toEqual(
      selectWithinBudget(cands, 150),
    );
  });
});

describe('selectWithinBudget — resident stickiness', () => {
  const c = (id: string, score: number, pointCount = 100): ScoredCandidate => ({ id, score, pointCount });
  // Budget fits exactly one 100-point node — the boundary where thrash lives.
  const BUDGET = 150;

  it('without stickiness, a hair-higher newcomer bumps the resident node (the thrash)', () => {
    expect(selectWithinBudget([c('x', 10.5), c('r', 10)], BUDGET)).toEqual(new Set(['x']));
  });

  it('a resident node holds its slot against a marginally-higher newcomer', () => {
    const wanted = selectWithinBudget([c('x', 10.5), c('r', 10)], BUDGET, {
      resident: new Set(['r']),
      stickyMargin: 0.15,
    });
    expect(wanted).toEqual(new Set(['r']));
  });

  it('a decisively better newcomer (beyond the margin) still wins — refinement is not starved', () => {
    const wanted = selectWithinBudget([c('x', 12), c('r', 10)], BUDGET, {
      resident: new Set(['r']),
      stickyMargin: 0.15,
    });
    expect(wanted).toEqual(new Set(['x']));
  });

  it('a resident node BEING REFINED gets no stickiness, so its child is selected (never freezes LOD)', () => {
    // Parent p is resident and slightly outranks its child by raw score, but the
    // child c is also a candidate — p is being refined away, so the exemption
    // strips its bonus and the finer child takes the slot.
    const wanted = selectWithinBudget([c('child', 10.5), c('p', 10)], BUDGET, {
      resident: new Set(['p']),
      refining: new Set(['p']),
      stickyMargin: 0.15,
    });
    expect(wanted).toEqual(new Set(['child']));
  });

  it('when the budget fits everything, stickiness changes nothing', () => {
    const cands = [c('x', 10.5), c('r', 10)];
    const wanted = selectWithinBudget(cands, 1_000, {
      resident: new Set(['r']),
      stickyMargin: 0.15,
    });
    expect(wanted).toEqual(new Set(['x', 'r']));
  });
});
