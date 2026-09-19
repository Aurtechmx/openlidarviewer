import { describe, it, expect } from 'vitest';
import {
  TIER_ORDER,
  capabilitiesForTier,
  tierFor,
  degrade,
  type ContinuityTier,
  type BackendSupport,
} from '../src/render/continuity/continuityTier';
import type { ContinuityCapabilities } from '../src/render/continuity/continuityField';

const on = (c: ContinuityCapabilities): string[] =>
  Object.entries(c)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();

const support = (o: Partial<BackendSupport> = {}): BackendSupport => ({
  historyTextures: true,
  historyFits: true,
  depthNeighbourhood: true,
  ...o,
});

describe('continuity tier ladder', () => {
  it('runs richest to poorest', () => {
    expect(TIER_ORDER).toEqual(['full', 'closure', 'sizing', 'source']);
  });

  // The rule that makes degrading safe. A rung that enabled something the rung
  // above did not would change what a viewer sees rather than simplify it, and
  // two machines would disagree about the picture for reasons neither can see.
  it('only ever removes capabilities as it descends', () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const above = new Set(on(capabilitiesForTier(TIER_ORDER[i - 1])));
      const below = on(capabilitiesForTier(TIER_ORDER[i]));
      for (const cap of below) expect(above.has(cap)).toBe(true);
      expect(below.length).toBeLessThan(above.size);
    }
  });

  // Reconstruction puts pixels on screen no point was recorded at. The lens is
  // the only way to see which, so it cannot be traded away for performance.
  it('never reconstructs without the lens', () => {
    for (const tier of TIER_ORDER) {
      const c = capabilitiesForTier(tier);
      if (c.microGapFill || c.temporalAccumulation) expect(c.evidenceLens).toBe(true);
    }
  });

  it('leaves the bottom rung as the renderer ships today', () => {
    expect(on(capabilitiesForTier('source'))).toEqual([]);
  });

  // These change how much work is done, not what is drawn, so they are gated on
  // their own evidence rather than riding a visual ladder.
  it('keeps culling and packing out of every rung', () => {
    for (const tier of TIER_ORDER) {
      const c = capabilitiesForTier(tier);
      expect(c.nodeCulling).toBe(false);
      expect(c.packedAttributes).toBe(false);
    }
  });

  it('takes the full rung when the backend carries everything', () => {
    expect(tierFor(support())).toBe('full');
  });

  it('drops to closure when history cannot be kept', () => {
    expect(tierFor(support({ historyTextures: false }))).toBe('closure');
    expect(tierFor(support({ historyFits: false }))).toBe('closure');
    expect(capabilitiesForTier('closure').temporalAccumulation).toBe(false);
    expect(capabilitiesForTier('closure').microGapFill).toBe(true);
  });

  it('drops to sizing when neighbouring depths cannot be read', () => {
    expect(tierFor(support({ depthNeighbourhood: false }))).toBe('sizing');
    expect(capabilitiesForTier('sizing').microGapFill).toBe(false);
  });

  it('removes only what is unsupported', () => {
    // No depth neighbourhood outranks the history question: closure is
    // impossible either way, so the result does not depend on it.
    for (const h of [true, false]) {
      expect(tierFor(support({ depthNeighbourhood: false, historyTextures: h }))).toBe('sizing');
    }
  });

  it('walks down one rung at a time and stops at the bottom', () => {
    let tier: ContinuityTier | null = 'full';
    const walked: ContinuityTier[] = [];
    while (tier) {
      walked.push(tier);
      tier = degrade(tier);
    }
    expect(walked).toEqual([...TIER_ORDER]);
    expect(degrade('source')).toBeNull();
  });
});
