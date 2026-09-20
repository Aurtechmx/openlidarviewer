import { describe, expect, it } from 'vitest';

import {
  continuityRequest,
  NO_REQUEST,
  type ContinuityFlags,
} from '../src/render/continuity/continuityRequest';
import { capabilitiesForTier, TIER_ORDER, type ContinuityTier } from '../src/render/continuity/continuityTier';

function flags(over: Partial<ContinuityFlags> = {}): ContinuityFlags {
  return {
    tier: 'source',
    coverageSizing: false,
    microGapFill: false,
    temporalAccumulation: false,
    evidenceLens: false,
    ...over,
  };
}

describe('nothing asked for', () => {
  it('is the renderer as it shipped', () => {
    expect(continuityRequest(flags())).toEqual(NO_REQUEST);
  });
});

describe('the tier dial', () => {
  it('carries its own capabilities, whether or not a switch was set', () => {
    for (const tier of TIER_ORDER) {
      const request = continuityRequest(flags({ tier }));
      expect(request.requested).toBe(tier);
      const wanted = capabilitiesForTier(tier);
      expect(request.optIn.coverageSizing).toBe(wanted.coverageSizing);
      expect(request.optIn.microGapFill).toBe(wanted.microGapFill);
      expect(request.optIn.temporalAccumulation).toBe(wanted.temporalAccumulation);
      expect(request.optIn.evidenceLens).toBe(wanted.evidenceLens);
    }
  });

  it('is enough on its own to reach the top', () => {
    // The failure this rules out: asking for `full` and getting less because
    // the switches beneath it were left alone.
    const request = continuityRequest(flags({ tier: 'full' }));
    expect(request.requested).toBe('full');
    expect(Object.values(request.optIn).every((on) => on === true)).toBe(true);
  });
});

describe('the switches', () => {
  it('still ask for something on their own, so a bisect works', () => {
    const request = continuityRequest(flags({ coverageSizing: true }));
    expect(request.requested).toBe('sizing');
  });

  it('cannot take a capability away from the rung that was asked for', () => {
    // A switch that subtracted would put the sixty-four combinations back.
    const request = continuityRequest(flags({ tier: 'closure', evidenceLens: false }));
    expect(request.requested).toBe('closure');
    expect(request.optIn.evidenceLens).toBe(true);
  });

  it('raise the rung when they imply a richer one than the dial', () => {
    const request = continuityRequest(flags({
      tier: 'sizing',
      coverageSizing: true,
      microGapFill: true,
      temporalAccumulation: true,
      evidenceLens: true,
    }));
    expect(request.requested).toBe('full');
  });

  it('grant nothing on a half-set rung', () => {
    // `tierPermittedBy` is all-or-nothing: half of closure is not closure.
    const request = continuityRequest(flags({ microGapFill: true }));
    expect(request.requested).toBe('source');
  });
});

describe('the result is a request, never a grant', () => {
  it('names a rung even where no device could carry it', () => {
    // Nothing here consults a backend, a device class or a failure. Those
    // lower it later, and keeping them out of this function is what makes
    // "requested" mean what it says.
    const request = continuityRequest(flags({ tier: 'full' }));
    const tiers: readonly ContinuityTier[] = TIER_ORDER;
    expect(tiers).toContain(request.requested);
  });
});
