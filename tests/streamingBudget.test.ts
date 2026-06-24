/**
 * streamingBudget.test.ts — the resolved resident-point + cache budgets per
 * quality preset and device class. Pins the trimmed desktop "balanced" default
 * (2.5M, down from 4M — the steady-state navigation cost is dominated by the
 * resident-point draw) plus the ordering invariants every device must keep.
 */

import { describe, it, expect } from 'vitest';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';

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
