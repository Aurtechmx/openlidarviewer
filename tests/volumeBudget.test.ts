/**
 * volumeBudget.test.ts
 *
 * Tests for the adaptive-degradation budget that gates the volume
 * walk. Coverage targets: ceiling-driven downsample, density-driven
 * downsample, per-tier thresholds, caption rendering.
 */

import { describe, it, expect } from 'vitest';
import {
  decideVolumeBudget,
  volumeBudgetCaption,
} from '../src/render/measure/volumeBudget';

describe('decideVolumeBudget — exhaustive path', () => {
  it('walks every point when below the desktop ceiling', () => {
    const r = decideVolumeBudget({
      candidatePointCount: 1_000_000,
      footprintAreaM2: 1_000,
    });
    expect(r.downsample).toBe(false);
    expect(r.stride).toBe(1);
    expect(r.estimatedWalkedPoints).toBe(1_000_000);
    expect(r.coverageFraction).toBe(1);
  });

  it('returns zero-walk verdict for an empty candidate set', () => {
    const r = decideVolumeBudget({
      candidatePointCount: 0,
      footprintAreaM2: 100,
    });
    expect(r.downsample).toBe(false);
    expect(r.estimatedWalkedPoints).toBe(0);
  });

  it('walks every point on a sparse, medium-sized footprint', () => {
    // 1 M points over 10 000 m² = 100 pts/m² — comfortably below the
    // pathological density threshold.
    const r = decideVolumeBudget({
      candidatePointCount: 1_000_000,
      footprintAreaM2: 10_000,
    });
    expect(r.downsample).toBe(false);
  });
});

describe('decideVolumeBudget — ceiling-driven downsample', () => {
  it('downsamples when point count exceeds the desktop ceiling', () => {
    const r = decideVolumeBudget({
      candidatePointCount: 40_000_000,
      footprintAreaM2: 1_000_000,
      tier: 'desktop',
    });
    expect(r.downsample).toBe(true);
    expect(r.stride).toBeGreaterThan(1);
    expect(r.estimatedWalkedPoints).toBeLessThanOrEqual(8_000_000);
  });

  it('downsamples earlier on phone tier', () => {
    const desktop = decideVolumeBudget({
      candidatePointCount: 3_000_000,
      footprintAreaM2: 1_000_000,
      tier: 'desktop',
    });
    const phone = decideVolumeBudget({
      candidatePointCount: 3_000_000,
      footprintAreaM2: 1_000_000,
      tier: 'phone',
    });
    expect(desktop.downsample).toBe(false);
    expect(phone.downsample).toBe(true);
  });

  it('downsamples earlier on laptop than desktop', () => {
    const laptop = decideVolumeBudget({
      candidatePointCount: 6_000_000,
      footprintAreaM2: 1_000_000,
      tier: 'laptop',
    });
    expect(laptop.downsample).toBe(true);
  });

  it('caps stride so estimated walk fits the ceiling', () => {
    const r = decideVolumeBudget({
      candidatePointCount: 100_000_000,
      footprintAreaM2: 1_000_000,
      tier: 'desktop',
    });
    expect(r.estimatedWalkedPoints).toBeLessThanOrEqual(8_000_000);
  });
});

describe('decideVolumeBudget — density-driven downsample', () => {
  it('downsamples for high density on a small footprint', () => {
    // 1 M points over 50 m² = 20 000 pts/m² — pathological.
    const r = decideVolumeBudget({
      candidatePointCount: 1_000_000,
      footprintAreaM2: 50,
      tier: 'desktop',
    });
    expect(r.downsample).toBe(true);
    expect(r.reason).toMatch(/dense|pts\/m²/i);
  });

  it('ignores density on large footprints (only point-count ceiling fires)', () => {
    // Same density (20 000 pts/m²) but the area is large enough that
    // the density branch shouldn't apply. The ceiling DOES fire though,
    // so we still get a downsample — confirm the reason comes from the
    // ceiling, not from density.
    const r = decideVolumeBudget({
      candidatePointCount: 20_000_000,
      footprintAreaM2: 1_000,
      tier: 'desktop',
    });
    expect(r.downsample).toBe(true);
    expect(r.reason).toMatch(/ceiling|every/i);
  });

  it('does not downsample at moderate density', () => {
    // 500 K points over 1 000 m² = 500 pts/m² — well under the high
    // density threshold of 5 000 pts/m².
    const r = decideVolumeBudget({
      candidatePointCount: 500_000,
      footprintAreaM2: 1_000,
    });
    expect(r.downsample).toBe(false);
  });
});

describe('decideVolumeBudget — coverage fraction', () => {
  it('coverage fraction is always in (0, 1]', () => {
    for (const c of [10, 1_000, 1_000_000, 50_000_000]) {
      const r = decideVolumeBudget({
        candidatePointCount: c,
        footprintAreaM2: 1_000,
      });
      expect(r.coverageFraction).toBeGreaterThan(0);
      expect(r.coverageFraction).toBeLessThanOrEqual(1);
    }
  });

  it('coverage fraction reflects the stride', () => {
    const r = decideVolumeBudget({
      candidatePointCount: 32_000_000,
      footprintAreaM2: 1_000_000,
      tier: 'desktop',
    });
    expect(r.coverageFraction).toBeCloseTo(1 / r.stride, 2);
  });
});

describe('volumeBudgetCaption — surfaces sampling state for UI', () => {
  it('returns an empty string when not downsampling', () => {
    const decision = decideVolumeBudget({
      candidatePointCount: 1_000,
      footprintAreaM2: 100,
    });
    expect(volumeBudgetCaption(decision)).toBe('');
  });

  it('formats the caption with coverage and stride when downsampling', () => {
    const decision = decideVolumeBudget({
      candidatePointCount: 50_000_000,
      footprintAreaM2: 1_000_000,
      tier: 'desktop',
    });
    const caption = volumeBudgetCaption(decision);
    expect(caption).toMatch(/sampled/i);
    expect(caption).toMatch(/%/);
    expect(caption).toMatch(/\d+-th/);
  });
});
