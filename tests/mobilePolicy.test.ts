import { describe, it, expect } from 'vitest';
import {
  historyPixelRatio,
  historyDprCeiling,
  allocatedHistoryDpr,
  tierCeilingFor,
  tierUnderPolicy,
  lowerTier,
  MOBILE_DEFAULT_CEILING,
  type MobileFrameEvidence,
} from '../src/render/continuity/mobilePolicy';
import { historyBytes, HISTORY_BYTES_CEILING, CONSERVATIVE_LAYOUT } from '../src/render/continuity/historyBudget';
import { tierFor, capabilitiesForTier, TIER_ORDER, type ContinuityTier } from '../src/render/continuity/continuityTier';
import { DPR_MOTION_FLOOR, DPR_QUANT_STEP } from '../src/render/adaptiveDpr';

describe('history sizing ignores motion-time ratio changes', () => {
  it('sizes from the parked ratio, not the one in force', () => {
    expect(historyPixelRatio(2, 1)).toBe(2);
    expect(historyPixelRatio(2, 1.5)).toBe(2);
    expect(historyPixelRatio(2, 2)).toBe(2);
  });

  it('gives the same answer across a whole motion episode', () => {
    const parked = 3;
    const duringMotion = [3, 2.5, 2, 1.5, 1, 1.5, 2.5, 3];
    const sizes = duringMotion.map((cur) => historyPixelRatio(parked, cur));
    expect(new Set(sizes).size).toBe(1);
  });

  it('falls back to one for a parked ratio that is not a ratio', () => {
    for (const bad of [NaN, 0, -2, Infinity]) expect(historyPixelRatio(bad, 1)).toBe(1);
  });
});

describe('the ratio ceiling is solved from the budget', () => {
  it('lands on a ratio whose history actually fits', () => {
    for (const [w, h] of [[390, 844], [1024, 768], [1920, 1080], [3840, 2160]]) {
      const r = historyDprCeiling(w, h);
      if (r <= 0) continue;
      expect(historyBytes(w * r, h * r)).toBeLessThanOrEqual(HISTORY_BYTES_CEILING);
    }
  });

  it('is the largest such ratio on its grid', () => {
    for (const [w, h] of [[390, 844], [1920, 1080]]) {
      const r = historyDprCeiling(w, h);
      if (r <= 0) continue;
      const next = r + DPR_QUANT_STEP;
      expect(historyBytes(w * next, h * next)).toBeGreaterThan(HISTORY_BYTES_CEILING);
    }
  });

  it('sits on the grid adaptive DPR quantises to', () => {
    const r = historyDprCeiling(1920, 1080);
    expect(Math.abs(r / DPR_QUANT_STEP - Math.round(r / DPR_QUANT_STEP))).toBeLessThan(1e-9);
  });

  it('never returns a ratio below the legibility floor', () => {
    for (const [w, h] of [[390, 844], [1920, 1080], [7680, 4320]]) {
      const r = historyDprCeiling(w, h);
      expect(r === 0 || r >= DPR_MOTION_FLOOR).toBe(true);
    }
  });

  it('reports no history rather than a ratio when even the floor will not fit', () => {
    const tiny = 1024;
    expect(historyDprCeiling(1920, 1080, CONSERVATIVE_LAYOUT, tiny)).toBe(0);
  });

  it('has no ratio for a viewport with no area', () => {
    expect(historyDprCeiling(0, 800)).toBe(0);
    expect(historyDprCeiling(NaN, 800)).toBe(0);
  });
});

describe('what a phone actually allocates', () => {
  it('never allocates above the parked render ratio', () => {
    // A small viewport can afford far more ratio than the display has.
    const parked = 3;
    expect(allocatedHistoryDpr(parked, 390, 844)).toBeLessThanOrEqual(parked);
  });

  it('never allocates above what the budget affords', () => {
    const parked = 4;
    const w = 3840;
    const h = 2160;
    const r = allocatedHistoryDpr(parked, w, h);
    if (r > 0) expect(historyBytes(w * r, h * r)).toBeLessThanOrEqual(HISTORY_BYTES_CEILING);
  });

  it('returns no history rather than shrinking the picture to afford one', () => {
    const r = allocatedHistoryDpr(2, 1920, 1080, CONSERVATIVE_LAYOUT, 1024);
    expect(r).toBe(0);
  });
});

describe('the mobile ceiling', () => {
  it('caps a touch-first device at coverage sizing with no measurement', () => {
    expect(tierCeilingFor(true)).toBe('sizing');
    expect(tierCeilingFor(true, null)).toBe(MOBILE_DEFAULT_CEILING);
  });

  it('does not cap a device that is not touch-first', () => {
    expect(tierCeilingFor(false)).toBe('full');
  });

  it('lets measured evidence raise the cap and nothing else', () => {
    const measured: MobileFrameEvidence = { deviceClass: 'tablet', sustainedTier: 'closure' };
    expect(tierCeilingFor(true, measured)).toBe('closure');
    const worse: MobileFrameEvidence = { deviceClass: 'old phone', sustainedTier: 'source' };
    expect(tierCeilingFor(true, worse)).toBe(MOBILE_DEFAULT_CEILING);
  });

  it('ignores evidence naming a rung that is not on the ladder', () => {
    const bogus = { deviceClass: 'x', sustainedTier: 'turbo' as ContinuityTier };
    expect(tierCeilingFor(true, bogus)).toBe(MOBILE_DEFAULT_CEILING);
  });
});

describe('policy meets capability', () => {
  it('never raises a tier the backend cannot carry', () => {
    const noHistory = tierFor({ historyTextures: false, historyFits: true, depthNeighbourhood: true });
    expect(noHistory).toBe('closure');
    expect(tierUnderPolicy(noHistory, 'full')).toBe('closure');
  });

  it('holds a capable backend down to the mobile cap', () => {
    const capable = tierFor({ historyTextures: true, historyFits: true, depthNeighbourhood: true });
    expect(capable).toBe('full');
    expect(tierUnderPolicy(capable, tierCeilingFor(true))).toBe('sizing');
  });

  it('leaves a capable desktop backend alone', () => {
    const capable = tierFor({ historyTextures: true, historyFits: true, depthNeighbourhood: true });
    expect(tierUnderPolicy(capable, tierCeilingFor(false))).toBe('full');
  });

  it('takes the lower of any two rungs', () => {
    for (const a of TIER_ORDER) {
      for (const b of TIER_ORDER) {
        const low = lowerTier(a, b);
        expect(TIER_ORDER.indexOf(low)).toBe(Math.max(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b)));
      }
    }
  });

  it('reconstructs nothing at the shipped mobile cap', () => {
    const caps = capabilitiesForTier(tierUnderPolicy('full', tierCeilingFor(true)));
    expect(caps.microGapFill).toBe(false);
    expect(caps.temporalAccumulation).toBe(false);
    expect(caps.coverageSizing).toBe(true);
  });

  it('gives a phone the full field under no combination of inputs available today', () => {
    const everyBackend = [true, false].flatMap((historyTextures) =>
      [true, false].flatMap((historyFits) =>
        [true, false].map((depthNeighbourhood) => ({ historyTextures, historyFits, depthNeighbourhood })),
      ),
    );
    for (const support of everyBackend) {
      const tier = tierUnderPolicy(tierFor(support), tierCeilingFor(true));
      expect(capabilitiesForTier(tier).temporalAccumulation).toBe(false);
    }
  });
});
