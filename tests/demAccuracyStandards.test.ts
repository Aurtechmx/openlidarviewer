/**
 * demAccuracyStandards.test.ts — ASPRS accuracy expression + USGS density
 * REFERENCE (no quality-level grade is emitted from ground-return density).
 */

import { describe, it, expect } from 'vitest';
import { demAccuracyStandards, NVA_K } from '../src/terrain/quality/demAccuracyStandards';

describe('demAccuracyStandards', () => {
  it('NVA = RMSEz × 1.96 and VVA passes through the p95', () => {
    const s = demAccuracyStandards(0.08, 0.21, 3);
    expect(NVA_K).toBeCloseTo(1.96, 5);
    expect(s.nvaM).toBeCloseTo(0.08 * 1.96, 6);
    expect(s.vvaM).toBe(0.21);
    expect(s.rmseZM).toBe(0.08);
  });

  it('reports which USGS density FLOORS the ground-return density clears (reference only)', () => {
    // ≥8 pts/m² clears QL0/QL1 (8), QL2 (2) and QL3 (0.5) density floors.
    expect(demAccuracyStandards(0.04, 0.1, 9).densityReferenceFloorsMet).toEqual(['QL0', 'QL1', 'QL2', 'QL3']);
    // ≥2 but <8 clears QL2 and QL3 only.
    expect(demAccuracyStandards(0.09, 0.1, 3).densityReferenceFloorsMet).toEqual(['QL2', 'QL3']);
    // ≥0.5 but <2 clears QL3 only.
    expect(demAccuracyStandards(0.18, 0.3, 1).densityReferenceFloorsMet).toEqual(['QL3']);
    // below the QL3 density floor clears none.
    expect(demAccuracyStandards(0.5, 0.9, 0.1).densityReferenceFloorsMet).toEqual([]);
  });

  it('does NOT emit a quality-level grade, and never claims a determination', () => {
    const s = demAccuracyStandards(0.04, 0.1, 9);
    // The graded field is gone; the surface exposes a reference note instead.
    expect((s as unknown as Record<string, unknown>).qualityLevel).toBeUndefined();
    expect(s.densityReferenceNote).toMatch(/not a nominal-pulse-density/i);
    expect(s.densityReferenceNote).toMatch(/QL0/); // names the floor cleared as a reference
  });

  it('has no density floors and an explicit note when density is unavailable', () => {
    const s = demAccuracyStandards(0.05, 0.1, 0);
    expect(s.densityReferenceFloorsMet).toEqual([]);
    expect(s.densityReferenceNote).toMatch(/No measured ground-return density/i);
  });

  it('nulls the accuracy figures when RMSEz is unavailable', () => {
    const s = demAccuracyStandards(null, null, 5);
    expect(s.nvaM).toBeNull();
    expect(s.rmseZM).toBeNull();
  });
});
