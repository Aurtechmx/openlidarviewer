/**
 * crossCheck.test.ts
 *
 * Exercises the cross-implementation comparison maths with SYNTHETIC arrays.
 * This proves the harness is correct; it does not validate any product. Every
 * reference slot ships `pending`, asserted below, so no claim reads as E4.
 */

import { describe, it, expect } from 'vitest';
import {
  crossCheck, pendingCrossCheck, REFERENCE_SLOTS, allReferencesPending,
} from '../src/validation/crossCheck';

describe('crossCheck comparison maths', () => {
  it('agrees when every cell is within tolerance', () => {
    const ours = [1.00, 2.00, 3.00, 4.00, 5.00, 6.00, 7.00, 8.00];
    const ref = [1.02, 1.99, 3.03, 3.98, 5.01, 6.00, 7.04, 7.97];
    const r = crossCheck(ours, ref, { toleranceAbs: 0.05 });
    expect(r.verdict).toBe('agree');
    expect(r.count).toBe(8);
    expect(r.maxAbsDiff).toBeLessThanOrEqual(0.05);
    expect(r.withinTolFraction).toBe(1);
  });

  it('disagrees when one cell exceeds tolerance', () => {
    const ours = [1, 2, 3, 4, 5, 6, 7, 8];
    const ref = [1, 2, 3, 4, 5, 6, 7, 8.5]; // last cell off by 0.5
    const r = crossCheck(ours, ref, { toleranceAbs: 0.05 });
    expect(r.verdict).toBe('disagree');
    expect(r.maxAbsDiff).toBeCloseTo(0.5, 9);
    expect(r.withinTolFraction).toBeCloseTo(7 / 8, 9);
  });

  it('reports insufficient overlap below minCells', () => {
    const r = crossCheck([1, 2, 3], [1, 2, 3], { toleranceAbs: 0.1 });
    expect(r.verdict).toBe('insufficient');
    expect(r.count).toBe(3);
  });

  it('skips nodata and non-finite cells on either side', () => {
    const nd = -9999;
    const ours = [1, nd, 3, NaN, 5, 6, 7, 8, 9, 10];
    const ref = [1, 2, nd, 4, 5, 6, 7, 8, 9, 10];
    // minCells 4 so the 7 surviving cells clear the overlap floor — this case
    // is testing nodata/NaN skipping, not the insufficient-overlap gate.
    const r = crossCheck(ours, ref, { toleranceAbs: 0.01, nodata: nd, minCells: 4 });
    // cells 1 and 2 (nodata) and 3 (NaN) are skipped → 7 compared
    expect(r.count).toBe(7);
    expect(r.skipped).toBe(3);
    expect(r.verdict).toBe('agree');
  });

  it('computes RMSE and signed bias correctly', () => {
    // ours − ref = +0.1 on every cell → bias +0.1, RMSE 0.1
    const ours = [1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1, 8.1];
    const ref = [1, 2, 3, 4, 5, 6, 7, 8];
    const r = crossCheck(ours, ref, { toleranceAbs: 0.2 });
    expect(r.meanDiff).toBeCloseTo(0.1, 9);
    expect(r.rmse).toBeCloseTo(0.1, 9);
    expect(r.verdict).toBe('agree');
  });

  it('counts a length mismatch as skipped coverage', () => {
    const ours = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const ref = [1, 2, 3, 4, 5, 6, 7, 8]; // one shorter
    const r = crossCheck(ours, ref, { toleranceAbs: 0.01 });
    expect(r.count).toBe(8);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it('honours a soft within-tolerance threshold', () => {
    const ours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ref = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]; // 9/10 within tol
    const strict = crossCheck(ours, ref, { toleranceAbs: 0.01 });
    expect(strict.verdict).toBe('disagree');
    const soft = crossCheck(ours, ref, { toleranceAbs: 0.01, withinTolThreshold: 0.9 });
    expect(soft.verdict).toBe('agree');
  });
});

describe('crossCheck cannot be tricked into a false AGREE (audit hardening)', () => {
  it('refuses to agree on a grid length mismatch (not aligned)', () => {
    const r = crossCheck([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7, 8], {
      toleranceAbs: 0.01,
    });
    expect(r.verdict).toBe('disagree');
    expect(r.summary).toMatch(/mismatch/i);
  });

  it('allows a prefix comparison only with the explicit opt-in', () => {
    const r = crossCheck([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7, 8], {
      toleranceAbs: 0.01,
      allowPartialOverlap: true,
    });
    expect(r.verdict).toBe('agree'); // 8 aligned cells all match
  });

  it('rejects a zero agreement threshold (would pass everything)', () => {
    const r = crossCheck([1, 2, 3, 4, 5, 6, 7, 8], [9, 9, 9, 9, 9, 9, 9, 9], {
      toleranceAbs: 0.01,
      withinTolThreshold: 0,
    });
    expect(r.verdict).not.toBe('agree'); // 0% within tol must not read as agree
  });

  it('rejects a non-finite / negative tolerance', () => {
    expect(crossCheck([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8], { toleranceAbs: Number.NaN }).verdict)
      .toBe('insufficient');
    expect(crossCheck([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8], { toleranceAbs: -1 }).verdict)
      .toBe('insufficient');
  });
});

describe('reference manifest honesty', () => {
  it('ships every reference slot as pending (nothing is E4)', () => {
    expect(REFERENCE_SLOTS.length).toBeGreaterThan(0);
    expect(REFERENCE_SLOTS.every((s) => s.status === 'pending')).toBe(true);
    expect(allReferencesPending()).toBe(true);
  });

  it('pendingCrossCheck returns a pending verdict with no invented numbers', () => {
    const p = pendingCrossCheck();
    expect(p.verdict).toBe('pending');
    expect(p.count).toBe(0);
    expect(p.rmse).toBe(0);
  });
});
