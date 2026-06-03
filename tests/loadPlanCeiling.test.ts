/**
 * loadPlanCeiling.test.ts
 *
 * Pins the over-ceiling honesty contract on `LoadPlan`. The memory
 * guard shrinks the point budget when the estimate exceeds the
 * ceiling — but when the FIXED cost (file bytes + LAZ scratch +
 * WASM heap) alone is too large, no point reshape can help. The
 * plan returns `mayExceedCeiling: true` in that case so the loader
 * can warn the user instead of implying the file fits.
 */

import { describe, it, expect } from 'vitest';
import { planLoad } from '../src/io/loadPlan';
import type { LoadPlanInput, PointAttributes } from '../src/io/loadPlan';

const LAS_ATTRS: PointAttributes = {
  hasColor: false,
  hasIntensity: true,
  hasClassification: true,
  hasNormals: false,
};

function input(over: Partial<LoadPlanInput> = {}): LoadPlanInput {
  return {
    sourceCount: 1_000_000,
    fileBytes: 20_000_000,
    budget: 4_000_000,
    isMobile: false,
    attributes: LAS_ATTRS,
    format: 'las',
    ...over,
  };
}

describe('LoadPlan — mayExceedCeiling honesty flag', () => {
  it('is false for a comfortably-fitting plan', () => {
    const plan = planLoad(input({ sourceCount: 100_000, fileBytes: 5_000_000 }));
    expect(plan.mayExceedCeiling).toBe(false);
    expect(plan.memoryGuardTriggered).toBe(false);
  });

  it('is false when the guard successfully shrinks the budget to fit', () => {
    // A large source count that the guard CAN reshape to fit.
    const plan = planLoad(
      input({ sourceCount: 30_000_000, fileBytes: 50_000_000 }),
    );
    if (plan.memoryGuardTriggered) {
      // Guard fired but the post-shrink estimate is within ceiling.
      expect(plan.mayExceedCeiling).toBe(false);
    }
  });

  it('is true when fixed file/LAZ scratch already exceeds the ceiling', () => {
    // LAZ format doubles the fixed cost (file bytes + LAZ scratch).
    // A 4 GB LAZ file alone busts a desktop ceiling without any point
    // budget yet allocated — the guard floors the budget, but the
    // estimate still exceeds the ceiling because fixed > ceiling.
    const plan = planLoad(
      input({
        sourceCount: 100_000_000,
        fileBytes: 4_000_000_000,
        format: 'laz',
      }),
    );
    expect(plan.memoryGuardTriggered).toBe(true);
    expect(plan.mayExceedCeiling).toBe(true);
  });

  it('reports a finite memory estimate even when over-ceiling', () => {
    const plan = planLoad(
      input({
        sourceCount: 100_000_000,
        fileBytes: 4_000_000_000,
        format: 'laz',
      }),
    );
    expect(Number.isFinite(plan.memoryEstimateBytes)).toBe(true);
    expect(plan.memoryEstimateBytes).toBeGreaterThan(0);
  });

  it('keeps mayExceedCeiling separate from memoryGuardTriggered', () => {
    // The two flags answer different questions:
    //   - memoryGuardTriggered: "did the guard shrink the budget?"
    //   - mayExceedCeiling: "does the result still exceed the ceiling?"
    // A small over-budget case fires the guard and successfully fits;
    // mayExceedCeiling should stay false then.
    const small = planLoad(
      input({ sourceCount: 10_000_000, fileBytes: 100_000_000 }),
    );
    if (small.memoryGuardTriggered) {
      expect(small.mayExceedCeiling).toBe(false);
    }
  });
});
