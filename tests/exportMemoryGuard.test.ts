/**
 * exportMemoryGuard.test.ts
 *
 * Pins the full-resolution export memory gate: routine files export without a
 * prompt, multi-GB files trigger a confirm, and the estimated peak is a
 * conservative multiple of the file size. Guards the "preview loads, full-res
 * export crashes the tab" trap.
 */

import { describe, it, expect } from 'vitest';
import {
  assessFullExportMemory,
  FULL_EXPORT_CONFIRM_BYTES,
} from '../src/convert/exportMemoryGuard';

describe('assessFullExportMemory', () => {
  it('does not prompt for a routine-size file', () => {
    const a = assessFullExportMemory(50 * 1024 * 1024); // 50 MB
    expect(a.needsConfirm).toBe(false);
    expect(a.estimatedPeakBytes).toBe(50 * 1024 * 1024 * 3);
  });

  it('prompts above the confirm threshold', () => {
    const a = assessFullExportMemory(FULL_EXPORT_CONFIRM_BYTES + 1);
    expect(a.needsConfirm).toBe(true);
  });

  it('does not prompt exactly at the threshold (boundary)', () => {
    expect(assessFullExportMemory(FULL_EXPORT_CONFIRM_BYTES).needsConfirm).toBe(false);
  });

  it('estimates a conservative 3× peak for a multi-GB file', () => {
    const twoGiB = 2 * 1024 * 1024 * 1024;
    const a = assessFullExportMemory(twoGiB);
    expect(a.needsConfirm).toBe(true);
    expect(a.estimatedPeakBytes).toBe(twoGiB * 3);
  });

  it('clamps invalid sizes to zero (no prompt, no NaN)', () => {
    for (const bad of [NaN, -10, Number.POSITIVE_INFINITY]) {
      const a = assessFullExportMemory(bad);
      expect(a.fileBytes).toBe(0);
      expect(a.needsConfirm).toBe(false);
      expect(a.estimatedPeakBytes).toBe(0);
    }
  });
});
