/**
 * demAccuracyStandards.test.ts — ASPRS/USGS 3DEP accuracy expression.
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

  it('assigns USGS Quality Levels on joint density + RMSEz', () => {
    // ≥8 pts/m² and ≤0.05 m → QL0
    expect(demAccuracyStandards(0.04, 0.1, 9).qualityLevel).toBe('QL0');
    // ≥8 and ≤0.10 (but >0.05) → QL1
    expect(demAccuracyStandards(0.08, 0.1, 9).qualityLevel).toBe('QL1');
    // ≥2 and ≤0.10 → QL2 (the 3DEP baseline)
    expect(demAccuracyStandards(0.09, 0.1, 3).qualityLevel).toBe('QL2');
    // dense but inaccurate falls back to the accuracy it actually meets
    expect(demAccuracyStandards(0.18, 0.3, 9).qualityLevel).toBe('QL3');
    // too sparse / inaccurate for any level
    expect(demAccuracyStandards(0.5, 0.9, 0.1).qualityLevel).toBe('below-QL3');
  });

  it('is unknown when RMSEz or density is unavailable', () => {
    expect(demAccuracyStandards(null, null, 5).qualityLevel).toBe('unknown');
    expect(demAccuracyStandards(0.05, 0.1, 0).qualityLevel).toBe('unknown');
    const s = demAccuracyStandards(null, null, 5);
    expect(s.nvaM).toBeNull();
  });
});
