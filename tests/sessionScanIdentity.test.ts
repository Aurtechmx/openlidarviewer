/**
 * sessionScanIdentity.test.ts
 *
 * A session's geometry is local to the scan it was captured over. Rebasing it
 * onto whatever cloud happens to be loaded silently realigns scan A's analysis
 * onto scan B. `matchSessionToScan` is the guard: extents are the primary,
 * reduction-stable identity signal; point count corroborates but never conflicts
 * alone; file name and CRS are disclosure only.
 */

import { describe, test, expect } from 'vitest';
import { matchSessionToScan, type ScanFacts } from '../src/io/session';
import type { SessionScanSummary } from '../src/io/session';

const SCAN_A: SessionScanSummary = {
  fileName: 'site-a.laz',
  sourcePoints: 4_000_000,
  width: 120,
  depth: 80,
  height: 25,
  crs: 'NAD83 / UTM 13N',
  crsUnit: 'metre',
};

/** The loaded-cloud facts, defaulting to an exact match of SCAN_A. */
function loaded(over: Partial<ScanFacts> = {}): ScanFacts {
  return {
    fileName: 'site-a.laz',
    sourcePoints: 4_000_000,
    width: 120,
    depth: 80,
    height: 25,
    crs: 'NAD83 / UTM 13N',
    ...over,
  };
}

describe('matchSessionToScan', () => {
  test('an exact fingerprint match is strong, with nothing to disclose', () => {
    const m = matchSessionToScan(SCAN_A, loaded());
    expect(m.verdict).toBe('strong');
    expect(m.reasons).toEqual([]);
  });

  test('a point count within sampling tolerance still matches strongly', () => {
    const m = matchSessionToScan(SCAN_A, loaded({ sourcePoints: 4_000_010 }));
    expect(m.verdict).toBe('strong');
  });

  test('extents differing beyond tolerance is a conflict — refuse the rebase', () => {
    // A different area entirely: 300×200 vs 120×80.
    const m = matchSessionToScan(SCAN_A, loaded({ width: 300, depth: 200, height: 60 }));
    expect(m.verdict).toBe('conflict');
    expect(m.reasons[0]).toMatch(/extents differ/);
  });

  test('same extents but a very different point count downgrades to partial, not conflict', () => {
    // Same scan reduced for a smaller device legitimately reports fewer points.
    const m = matchSessionToScan(SCAN_A, loaded({ sourcePoints: 900_000 }));
    expect(m.verdict).toBe('partial');
    expect(m.reasons.some((r) => /point count differs/.test(r))).toBe(true);
  });

  test('loosely-agreeing extents (within 5%) are partial, not strong', () => {
    // 123 vs 120 ≈ 2.5% — consistent with, but not proof of, the same scan.
    const m = matchSessionToScan(SCAN_A, loaded({ width: 123 }));
    expect(m.verdict).toBe('partial');
  });

  test('a renamed file with identical geometry stays strong — geometry outranks the name', () => {
    // Extents + point count match exactly; a rename alone cannot demote a scan
    // that is spatially identical, so the verdict holds at strong.
    const m = matchSessionToScan(SCAN_A, loaded({ fileName: 'site-a-copy.laz' }));
    expect(m.verdict).toBe('strong');
  });

  test('a differing CRS label is disclosure only, never a standalone verdict', () => {
    // Extents conflict drives the verdict; the CRS mismatch rides along as context.
    const m = matchSessionToScan(SCAN_A, loaded({ width: 300, crs: 'EPSG:32613' }));
    expect(m.verdict).toBe('conflict');
    expect(m.reasons.some((r) => /CRS label differs/.test(r))).toBe(true);
  });

  test('a session with no scan fingerprint is partial, not silently trusted', () => {
    const m = matchSessionToScan(undefined, loaded());
    expect(m.verdict).toBe('partial');
    expect(m.reasons[0]).toMatch(/no scan fingerprint/);
  });
});
