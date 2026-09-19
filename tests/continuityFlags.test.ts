import { describe, it, expect } from 'vitest';
import { parseDevFlags, DEV_FLAG_DEFAULTS, type DevFlags } from '../src/perf/devFlags';
import { TIER_ORDER, capabilitiesForTier } from '../src/render/continuity/continuityTier';
import type { ContinuityCapabilities } from '../src/render/continuity/continuityField';

const CONTINUITY_FLAGS = [
  'continuityNodeCulling',
  'continuityPackedAttributes',
  'continuityCoverageSizing',
  'continuityMicroGapFill',
  'continuityTemporalAccumulation',
  'continuityEvidenceLens',
] as const satisfies readonly (keyof DevFlags)[];

describe('continuity development flags', () => {
  it('covers every capability the ladder can turn on', () => {
    const caps = Object.keys(capabilitiesForTier('full')) as (keyof ContinuityCapabilities)[];
    const flagged = CONTINUITY_FLAGS.map((f) =>
      f.replace(/^continuity/, '').replace(/^./, (c) => c.toLowerCase()),
    );
    expect([...flagged].sort()).toEqual([...caps].sort());
  });

  // A default nobody has measured on a device is the mistake the multi-layer
  // mount already made once.
  it('ships every capability off', () => {
    for (const f of CONTINUITY_FLAGS) expect(DEV_FLAG_DEFAULTS[f]).toBe(false);
  });

  it('parses each one independently, for bisection', () => {
    for (const f of CONTINUITY_FLAGS) {
      const parsed = parseDevFlags(`${f}=on`);
      expect(parsed[f]).toBe(true);
      for (const other of CONTINUITY_FLAGS) {
        if (other !== f) expect(parsed[other]).toBe(false);
      }
    }
  });

  it('leaves the flags alone when the query says nothing', () => {
    const parsed = parseDevFlags('');
    for (const f of CONTINUITY_FLAGS) expect(parsed[f]).toBe(DEV_FLAG_DEFAULTS[f]);
  });

  // parseOnOff reads an absent flag as ON, which is this module's convention for
  // a path that already shipped. Using it here would have an empty query turn
  // every capability on while the defaults record said they were off, which is
  // two sources of truth disagreeing about what the viewer is doing.
  it('agrees with the defaults record when the query is empty', () => {
    const parsed = parseDevFlags('');
    for (const f of CONTINUITY_FLAGS) {
      expect(parsed[f]).toBe(false);
      expect(parsed[f]).toBe(DEV_FLAG_DEFAULTS[f]);
    }
  });

  it('needs an explicit yes, not merely a mention', () => {
    for (const f of CONTINUITY_FLAGS) {
      expect(parseDevFlags(`${f}=`)[f]).toBe(false);
      expect(parseDevFlags(`${f}=off`)[f]).toBe(false);
      expect(parseDevFlags(`${f}=maybe`)[f]).toBe(false);
      expect(parseDevFlags(`${f}=on`)[f]).toBe(true);
      expect(parseDevFlags(`${f}=1`)[f]).toBe(true);
    }
  });

  it('survives a malformed query rather than throwing', () => {
    const parsed = parseDevFlags('%%%');
    for (const f of CONTINUITY_FLAGS) expect(parsed[f]).toBe(false);
  });
});

describe('the supported set', () => {
  // Six switches is sixty-four combinations. Claiming they all work would be a
  // promise nobody has kept, so the ladder is what is supported and the rest is
  // for bisecting a problem.
  it('is four configurations, not sixty-four', () => {
    expect(TIER_ORDER.length).toBe(4);
    expect(2 ** CONTINUITY_FLAGS.length).toBe(64);
  });

  it('gives each supported configuration a name', () => {
    const seen = new Set<string>();
    for (const tier of TIER_ORDER) {
      const caps = capabilitiesForTier(tier);
      const key = Object.entries(caps)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort()
        .join(',');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(TIER_ORDER.length);
  });
});
