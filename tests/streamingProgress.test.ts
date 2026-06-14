/**
 * streamingProgress.test.ts
 *
 * WIN 3 — the determinate streaming-loader readout. `streamingProgress` turns
 * the live status counters into the bar fraction + the tabular nodes/pts labels.
 *
 * HONESTY CONTRACT under test: `fraction` is RESIDENT nodes ÷ KNOWN nodes (the
 * share of the octree currently LOADED), never a download percentage. When the
 * total is unknown (knownNodes ≤ 0) the fraction is null and `determinate` is
 * false, so the panel falls back to the indeterminate shimmer rather than a
 * fabricated 0%/100% bar. Hand-computed expectations throughout.
 */

import { describe, it, expect } from 'vitest';
import { streamingProgress } from '../src/ui/StreamingPanel';
import type { StreamingStatus } from '../src/ui/StreamingPanel';

function status(p: Partial<StreamingStatus>): StreamingStatus {
  return {
    loadedNodes: 0,
    knownNodes: 0,
    displayedPoints: 0,
    sourcePoints: 0,
    cacheBytes: 0,
    ...p,
  };
}

describe('streamingProgress — fraction + labels', () => {
  it('computes resident/known fraction when the total is known', () => {
    // 30 / 120 = 0.25 exactly.
    const p = streamingProgress(status({ loadedNodes: 30, knownNodes: 120 }));
    expect(p.determinate).toBe(true);
    expect(p.fraction).toBeCloseTo(0.25, 10);
    expect(p.nodesLabel).toBe('30 / 120 nodes resident');
  });

  it('falls back to indeterminate when the total node count is unknown', () => {
    const p = streamingProgress(status({ loadedNodes: 4, knownNodes: 0 }));
    expect(p.determinate).toBe(false);
    expect(p.fraction).toBeNull();
    // Label shows a "?" for the unknown denominator, never a fake number.
    expect(p.nodesLabel).toBe('4 / ? nodes resident');
  });

  it('clamps the fraction to [0,1] when resident transiently exceeds a stale total', () => {
    // 5 resident against a stale known=4 must read full, not 125%.
    const p = streamingProgress(status({ loadedNodes: 5, knownNodes: 4 }));
    expect(p.fraction).toBe(1);
  });

  it('a fully-resident cloud reads exactly 1.0', () => {
    const p = streamingProgress(status({ loadedNodes: 200, knownNodes: 200 }));
    expect(p.fraction).toBe(1);
    expect(p.nodesLabel).toBe('200 / 200 nodes resident');
  });

  it('formats the points readout as same-unit millions (X.XM / Y.YM pts)', () => {
    const p = streamingProgress(
      status({ displayedPoints: 1_500_000, sourcePoints: 6_000_000 }),
    );
    expect(p.pointsLabel).toBe('1.5M / 6.0M pts');
  });

  it('sub-100k displayed points read as 0.0M (honest at scale, same unit on both sides)', () => {
    const p = streamingProgress(
      status({ displayedPoints: 42_000, sourcePoints: 4_200_000 }),
    );
    expect(p.pointsLabel).toBe('0.0M / 4.2M pts');
  });

  it('never emits a negative fraction or width even with bogus zero/negative inputs', () => {
    const p = streamingProgress(status({ loadedNodes: -5, knownNodes: 100 }));
    expect(p.fraction).toBe(0);
  });
});
