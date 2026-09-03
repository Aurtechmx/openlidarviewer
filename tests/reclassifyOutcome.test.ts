/**
 * reclassifyOutcome.test.ts
 *
 * A lasso reclassify that changes nothing has three different reasons, and the
 * tool used to report all three as "no points inside the lasso". A user whose
 * points were hidden by a filter was told they had drawn around empty space, so
 * the one thing they could have done about it was the one thing the message
 * withheld.
 *
 * These pin the SPECIFIC case, not the wording: the filtered refusal must name
 * a filter, the already-that-class case must not claim the lasso was empty, and
 * a genuinely empty lasso must still say so.
 */

import { describe, it, expect } from 'vitest';
import { reclassifyOutcome } from '../src/ui/reclassifyOutcome';

describe('reclassify lasso outcome message', () => {
  it('reports the edit when points changed', () => {
    const msg = reclassifyOutcome(
      { changedCount: 12_345, pointCount: 1_888_921, selectedCount: 12_345, hiddenByFilters: 0 },
      2,
    );
    expect(msg).toContain('12,345');
    expect(msg).toContain('2');
  });

  it('says a filter held the points back, and how to release them', () => {
    const msg = reclassifyOutcome(
      { changedCount: 0, pointCount: 1_888_921, selectedCount: 8_400, hiddenByFilters: 8_400 },
      2,
    );
    expect(msg).toContain('8,400');
    expect(msg).toMatch(/filter/i);
    expect(msg).not.toMatch(/no points inside/i);
  });

  it('separates "already that class" from an empty lasso', () => {
    const already = reclassifyOutcome(
      { changedCount: 0, pointCount: 1_888_921, selectedCount: 500, hiddenByFilters: 0 },
      2,
    );
    expect(already).toMatch(/already class 2/i);
    expect(already).not.toMatch(/no points inside/i);
  });

  it('still says the lasso was empty when it was', () => {
    const msg = reclassifyOutcome(
      { changedCount: 0, pointCount: 1_888_921, selectedCount: 0, hiddenByFilters: 0 },
      2,
    );
    expect(msg).toMatch(/no points inside the lasso/i);
  });

  it('falls back to the empty-lasso line when a result carries no counts', () => {
    // An older/other mutator result has neither field; it must not invent one.
    const msg = reclassifyOutcome({ changedCount: 0, pointCount: 10 }, 6);
    expect(msg).toMatch(/no points inside the lasso/i);
  });
});
