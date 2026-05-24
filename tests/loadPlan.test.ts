import {
  chooseLoadMode,
  strideFor,
  estimateMemoryBytes,
  planLoad,
  formatPointCount,
  DESKTOP_MEDIUM_MULTIPLIER,
  MOBILE_MEDIUM_MULTIPLIER,
} from '../src/io/loadPlan';
import type { LoadPlanInput, PointAttributes } from '../src/io/loadPlan';

// ────────────────────────────────────────────────────────────────────────────
// shared fixtures
// ────────────────────────────────────────────────────────────────────────────

const DESKTOP_BUDGET = 4_000_000;
const MOBILE_BUDGET = 1_500_000;

const NO_ATTRS: PointAttributes = {
  hasColor: false,
  hasIntensity: false,
  hasClassification: false,
  hasNormals: false,
};

const LAS_ATTRS: PointAttributes = {
  hasColor: false,
  hasIntensity: true,
  hasClassification: true,
  hasNormals: false,
};

/** A baseline desktop LAS plan input; spread over it to vary one field. */
function input(over: Partial<LoadPlanInput> = {}): LoadPlanInput {
  return {
    sourceCount: 1_000_000,
    fileBytes: 20_000_000,
    budget: DESKTOP_BUDGET,
    isMobile: false,
    attributes: LAS_ATTRS,
    format: 'las',
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// chooseLoadMode — the mode boundaries
// ────────────────────────────────────────────────────────────────────────────

describe('chooseLoadMode', () => {
  const M = DESKTOP_MEDIUM_MULTIPLIER;

  test('a cloud within budget loads in full', () => {
    expect(chooseLoadMode(1_000_000, DESKTOP_BUDGET, M)).toBe('all');
  });

  test('exactly the budget is still a full load (inclusive boundary)', () => {
    expect(chooseLoadMode(DESKTOP_BUDGET, DESKTOP_BUDGET, M)).toBe('all');
  });

  test('one point over budget switches to voxel', () => {
    expect(chooseLoadMode(DESKTOP_BUDGET + 1, DESKTOP_BUDGET, M)).toBe('voxel');
  });

  test('exactly budget x multiplier is still voxel (inclusive boundary)', () => {
    expect(chooseLoadMode(DESKTOP_BUDGET * M, DESKTOP_BUDGET, M)).toBe('voxel');
  });

  test('one point past budget x multiplier switches to stride', () => {
    expect(chooseLoadMode(DESKTOP_BUDGET * M + 1, DESKTOP_BUDGET, M)).toBe('stride');
  });

  test('the tighter mobile multiplier reaches stride sooner', () => {
    // 2.25M = 1.5M x 1.5 — the mobile voxel ceiling.
    expect(chooseLoadMode(2_250_000, MOBILE_BUDGET, MOBILE_MEDIUM_MULTIPLIER)).toBe('voxel');
    expect(chooseLoadMode(2_250_001, MOBILE_BUDGET, MOBILE_MEDIUM_MULTIPLIER)).toBe('stride');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// strideFor — keep ~budget points out of sourceCount
// ────────────────────────────────────────────────────────────────────────────

describe('strideFor', () => {
  test('a cloud at the budget needs no striding (stride 1)', () => {
    expect(strideFor(DESKTOP_BUDGET, DESKTOP_BUDGET)).toBe(1);
  });

  test('twice the budget halves the cloud (stride 2)', () => {
    expect(strideFor(8_000_000, DESKTOP_BUDGET)).toBe(2);
  });

  test('a non-integer ratio rounds up so the result never exceeds budget', () => {
    // ceil(18.2M / 4M) = ceil(4.55) = 5.
    expect(strideFor(18_200_000, DESKTOP_BUDGET)).toBe(5);
  });

  test('a tiny cloud still yields a stride of at least 1', () => {
    expect(strideFor(100, DESKTOP_BUDGET)).toBe(1);
  });

  test('a non-positive budget degrades safely to a stride of 1', () => {
    expect(strideFor(1_000_000, 0)).toBe(1);
    expect(strideFor(1_000_000, -5)).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// estimateMemoryBytes — the conservative peak-memory estimate
// ────────────────────────────────────────────────────────────────────────────

describe('estimateMemoryBytes', () => {
  test('positions-only: 12 bytes per point plus the file buffer', () => {
    const bytes = estimateMemoryBytes({
      pointCount: 1_000_000,
      attributes: NO_ATTRS,
      fileBytes: 0,
      format: 'las',
    });
    expect(bytes).toBe(12_000_000);
  });

  test('every attribute adds its own per-point cost', () => {
    // 12 + 3 + 2 + 1 + 12 = 30 bytes per point.
    const bytes = estimateMemoryBytes({
      pointCount: 1_000_000,
      attributes: { hasColor: true, hasIntensity: true, hasClassification: true, hasNormals: true },
      fileBytes: 0,
      format: 'las',
    });
    expect(bytes).toBe(30_000_000);
  });

  test('the source file buffer is counted alongside the decoded points', () => {
    const bytes = estimateMemoryBytes({
      pointCount: 1_000_000,
      attributes: NO_ATTRS,
      fileBytes: 10_000_000,
      format: 'las',
    });
    expect(bytes).toBe(22_000_000); // 12M points + 10M file
  });

  test('a LAZ load counts the file twice (WASM heap copy) plus scratch', () => {
    const las = estimateMemoryBytes({
      pointCount: 1_000_000,
      attributes: NO_ATTRS,
      fileBytes: 10_000_000,
      format: 'las',
    });
    const laz = estimateMemoryBytes({
      pointCount: 1_000_000,
      attributes: NO_ATTRS,
      fileBytes: 10_000_000,
      format: 'laz',
    });
    // laz adds another fileBytes (10M) + 16M scratch.
    expect(laz - las).toBe(26_000_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planLoad — mode selection
// ────────────────────────────────────────────────────────────────────────────

describe('planLoad — mode selection', () => {
  test('a small cloud plans a full load', () => {
    const plan = planLoad(input({ sourceCount: 1_000_000 }));
    expect(plan.mode).toBe('all');
    expect(plan.stride).toBe(1);
    expect(plan.targetCount).toBe(1_000_000);
    expect(plan.memoryGuardTriggered).toBe(false);
  });

  test('a medium cloud plans a voxel downsample to the budget', () => {
    const plan = planLoad(input({ sourceCount: 8_000_000 }));
    expect(plan.mode).toBe('voxel');
    expect(plan.stride).toBe(1);
    expect(plan.targetCount).toBe(DESKTOP_BUDGET);
  });

  test('a huge cloud plans a stride decode that voxel-reduces to the budget', () => {
    const plan = planLoad(input({ sourceCount: 18_200_000 }));
    expect(plan.mode).toBe('stride');
    // Strided down to the ~budget x 3 intermediate, not straight to the budget.
    expect(plan.stride).toBeGreaterThan(1);
    // The on-screen total is the voxel budget — the strided cloud is reduced.
    expect(plan.targetCount).toBe(DESKTOP_BUDGET);
  });

  test('a budget below the floor is clamped up to the minimum', () => {
    const plan = planLoad(input({ sourceCount: 100, budget: 1000 }));
    expect(plan.budget).toBe(250_000);
    expect(plan.mode).toBe('all');
  });

  test('an empty cloud does not crash and plans a full load', () => {
    const plan = planLoad(input({ sourceCount: 0 }));
    expect(plan.mode).toBe('all');
    expect(plan.targetCount).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planLoad — mobile awareness (Task 10)
// ────────────────────────────────────────────────────────────────────────────

describe('planLoad — mobile awareness', () => {
  test('the same cloud strides on mobile where it would load fully on desktop', () => {
    // 3M points: within the 4M desktop budget, but well past the mobile band.
    const desktop = planLoad(input({ sourceCount: 3_000_000 }));
    const mobile = planLoad(
      input({ sourceCount: 3_000_000, budget: MOBILE_BUDGET, isMobile: true }),
    );
    expect(desktop.mode).toBe('all');
    expect(mobile.mode).toBe('stride');
  });

  test('mobile reaches stride sooner than the desktop multiplier would', () => {
    // 2.5M: still voxel on desktop (< 12M), but past the mobile 2.25M ceiling.
    const mobile = planLoad(
      input({ sourceCount: 2_500_000, budget: MOBILE_BUDGET, isMobile: true }),
    );
    expect(mobile.mode).toBe('stride');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planLoad — the memory guard (Task 7)
// ────────────────────────────────────────────────────────────────────────────

describe('planLoad — memory guard', () => {
  test('a normal load on a normal device does not trip the guard', () => {
    const plan = planLoad(input({ sourceCount: 1_000_000, deviceMemoryGB: 8 }));
    expect(plan.memoryGuardTriggered).toBe(false);
    expect(plan.mode).toBe('all');
  });

  test('a load too large for the device is downgraded to stride and shrunk', () => {
    // deviceMemory 0.25 GB -> ceiling 150 MB. A 10M-point voxel load with a
    // 100 MB file would need ~352 MB — the guard must downgrade it.
    const plan = planLoad(
      input({
        sourceCount: 10_000_000,
        fileBytes: 100_000_000,
        deviceMemoryGB: 0.25,
        attributes: {
          hasColor: true,
          hasIntensity: true,
          hasClassification: true,
          hasNormals: false,
        },
      }),
    );
    expect(plan.memoryGuardTriggered).toBe(true);
    expect(plan.mode).toBe('stride');
    expect(plan.budget).toBeLessThan(DESKTOP_BUDGET);
    // The downgraded plan must fit inside the ceiling (0.25 GB x 0.6).
    expect(plan.memoryEstimateBytes).toBeLessThanOrEqual(0.25 * 1_000_000_000 * 0.6);
  });

  test('the guard never plans a budget below the floor', () => {
    // A pathologically large file on a tiny device — the guard floors out.
    const plan = planLoad(
      input({
        sourceCount: 500_000_000,
        fileBytes: 2_000_000_000,
        deviceMemoryGB: 0.25,
      }),
    );
    expect(plan.memoryGuardTriggered).toBe(true);
    expect(plan.budget).toBeGreaterThanOrEqual(250_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planLoad — the preload summary (Task 11)
// ────────────────────────────────────────────────────────────────────────────

describe('planLoad — preload summary', () => {
  test('a full load names the format and the source count', () => {
    const plan = planLoad(input({ sourceCount: 1_000_000, format: 'las' }));
    expect(plan.preloadSummary).toContain('LAS file detected');
    expect(plan.preloadSummary).toContain('1M source points');
    expect(plan.preloadSummary).toContain('Loading at full resolution');
  });

  test('a stride load announces fast-load mode and the render budget', () => {
    const plan = planLoad(input({ sourceCount: 18_200_000, format: 'laz' }));
    expect(plan.preloadSummary).toContain('LAZ file detected');
    expect(plan.preloadSummary).toContain('18.2M source points');
    expect(plan.preloadSummary).toContain('Fast load mode enabled');
    expect(plan.preloadSummary).toContain('Target render budget: 4M points');
  });

  test('a guarded load tells the user density was reduced', () => {
    const plan = planLoad(
      input({
        sourceCount: 10_000_000,
        fileBytes: 100_000_000,
        deviceMemoryGB: 0.25,
        attributes: {
          hasColor: true,
          hasIntensity: true,
          hasClassification: true,
          hasNormals: false,
        },
      }),
    );
    expect(plan.preloadSummary).toContain(
      'Large file — loading at reduced density to fit available memory',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatPointCount — human-readable counts
// ────────────────────────────────────────────────────────────────────────────

describe('formatPointCount', () => {
  test('millions carry one decimal place', () => {
    expect(formatPointCount(18_200_000)).toBe('18.2M');
    expect(formatPointCount(1_500_000)).toBe('1.5M');
  });

  test('a whole number of millions drops the trailing .0', () => {
    expect(formatPointCount(4_000_000)).toBe('4M');
  });

  test('thousands use a K suffix', () => {
    expect(formatPointCount(950_000)).toBe('950K');
    expect(formatPointCount(1_000)).toBe('1K');
  });

  test('small counts are printed verbatim', () => {
    expect(formatPointCount(500)).toBe('500');
    expect(formatPointCount(0)).toBe('0');
  });
});
