import { describe, it, expect } from 'vitest';
import { checkGridBudget } from '../src/terrain/quality/gridBudget';
import { recommendGrid } from '../src/terrain/quality/recommendGrid';

describe('checkGridBudget', () => {
  it('passes a modest grid within budget', () => {
    const r = checkGridBudget({ cols: 1000, rows: 1000 });
    expect(r.verdict).toBe('ready');
    expect(r.cellCount).toBe(1_000_000);
    expect(r.cpuBytes).toBe(1_000_000 * 20);
  });

  it('asks to coarsen a grid over the soft budget but under the hard ceiling', () => {
    // 6000×6000 = 36M cells: over 16M soft, under 268M hard.
    const r = checkGridBudget({ cols: 6000, rows: 6000 });
    expect(r.verdict).toBe('coarsen');
    expect(r.cellCount).toBe(36_000_000);
  });

  it('blocks the pathological tiny-cell / huge-extent grid', () => {
    // The real 3.7-billion-cell case: a 100 km × 100 km extent at a 0.05 m cell
    // is 2,000,000 × 2,000,000 cells — must be refused, not attempted.
    const cols = Math.ceil(100_000 / 0.05);
    const rows = Math.ceil(100_000 / 0.05);
    const r = checkGridBudget({ cols, rows });
    expect(r.verdict).toBe('blocked');
  });

  it('blocks invalid dimensions fail-closed (zero, negative, non-finite, non-integer)', () => {
    expect(checkGridBudget({ cols: 0, rows: 100 }).verdict).toBe('blocked');
    expect(checkGridBudget({ cols: -5, rows: 100 }).verdict).toBe('blocked');
    expect(checkGridBudget({ cols: Number.NaN, rows: 100 }).verdict).toBe('blocked');
    expect(checkGridBudget({ cols: Number.POSITIVE_INFINITY, rows: 100 }).verdict).toBe('blocked');
    expect(checkGridBudget({ cols: 100.5, rows: 100 }).verdict).toBe('blocked');
  });

  it('blocks a GPU buffer that exceeds the device limit even when CPU-feasible', () => {
    // 4000×4000 = 16M cells, 4 bytes each = 64 MiB GPU buffer; device caps at 32 MiB.
    const r = checkGridBudget({
      cols: 4000,
      rows: 4000,
      gpu: {
        bytesPerCell: 4,
        maxBufferSizeBytes: 32 * 1024 * 1024,
        maxStorageBufferBindingSizeBytes: 128 * 1024 * 1024,
      },
    });
    expect(r.verdict).toBe('blocked');
    expect(r.gpuBytes).toBe(16_000_000 * 4);
  });

  it('stays ready when the GPU buffer fits both device limits', () => {
    const r = checkGridBudget({
      cols: 1000,
      rows: 1000,
      gpu: {
        bytesPerCell: 4,
        maxBufferSizeBytes: 256 * 1024 * 1024,
        maxStorageBufferBindingSizeBytes: 128 * 1024 * 1024,
      },
    });
    expect(r.verdict).toBe('ready');
  });
});

describe('recommendGrid feasibility signal', () => {
  it('marks a normal dataset feasible', () => {
    const r = recommendGrid({ pointCount: 1_000_000, widthM: 100, depthM: 100, reliefM: 20 });
    expect(r.feasible).toBe(true);
  });

  it('marks infeasible when even the coarsest ladder cell blows the budget', () => {
    // 200 km × 200 km at a 1M-cell budget: (200000/20)² = 100M cells at 20 m,
    // far over budget — no ladder rung fits.
    const r = recommendGrid({
      pointCount: 10_000_000,
      widthM: 200_000,
      depthM: 200_000,
      reliefM: 100,
      memoryBudgetCells: 1_000_000,
    });
    expect(r.feasible).toBe(false);
    expect(r.cellOptionsM.length).toBe(0);
    expect(r.reasons.some((m) => /do not allocate this grid as-is/.test(m))).toBe(true);
  });
});
