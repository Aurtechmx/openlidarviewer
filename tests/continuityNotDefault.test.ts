/**
 * The Continuity Field is not on by default, proven over every input.
 *
 * Five conditions gate the default and none has been met: the browser matrix
 * has not run, mobile has not been benchmarked, performance is unmeasured,
 * edge leakage is controlled only against synthetic frames, and raw-point
 * parity has no device evidence. Until then the answer has to be no for every
 * combination of dial position, device and backend, not merely for the ones
 * someone thought to check.
 *
 * So this enumerates the whole product rather than sampling it. The dial
 * contributed a latent default when the rung joined its table: a capable
 * WebGPU desktop on Auto resolves to `closure`, which asks for gap filling.
 * That request is correct, and the grant is what must refuse it.
 */
import { describe, it, expect } from 'vitest';
import {
  QUALITY_MIN,
  QUALITY_MAX,
  autoQualityPosition,
  qualitySettingsFor,
  type QualityDevice,
} from '../src/render/quality/qualityPolicy';
import {
  grantedTier,
  grantedCapabilities,
  tierPermittedBy,
  tierCeilingFor,
  NO_OPT_IN,
  type CapabilityOptIn,
} from '../src/render/continuity/mobilePolicy';
import { tierFor, TIER_ORDER, type BackendSupport } from '../src/render/continuity/continuityTier';
import { parseDevFlags, DEV_FLAG_DEFAULTS } from '../src/perf/devFlags';

const DEVICES: readonly QualityDevice[] = [
  { tier: 'high', isMobile: false, backend: 'webgpu' },
  { tier: 'high', isMobile: false, backend: 'webgl2' },
  { tier: 'medium', isMobile: true, backend: 'webgpu' },
  { tier: 'medium', isMobile: false, backend: 'webgl2' },
  { tier: 'low', isMobile: false, backend: 'webgpu' },
  { tier: 'low', isMobile: true, backend: 'webgl2' },
];

/** Every backend the ladder can be told about. */
const BACKENDS: readonly BackendSupport[] = [true, false].flatMap((historyTextures) =>
  [true, false].flatMap((historyFits) =>
    [true, false].map((depthNeighbourhood) => ({ historyTextures, historyFits, depthNeighbourhood })),
  ),
);

describe('the shipped flags opt into nothing', () => {
  it('has every continuity flag off with no query string', () => {
    const flags = parseDevFlags('');
    expect(flags.continuityCoverageSizing).toBe(false);
    expect(flags.continuityMicroGapFill).toBe(false);
    expect(flags.continuityTemporalAccumulation).toBe(false);
    expect(flags.continuityEvidenceLens).toBe(false);
    expect(flags.continuityNodeCulling).toBe(false);
    expect(flags.continuityPackedAttributes).toBe(false);
  });

  it('ships those defaults rather than only parsing to them', () => {
    expect(DEV_FLAG_DEFAULTS.continuityMicroGapFill).toBe(false);
    expect(DEV_FLAG_DEFAULTS.continuityTemporalAccumulation).toBe(false);
    expect(DEV_FLAG_DEFAULTS.continuityCoverageSizing).toBe(false);
    expect(DEV_FLAG_DEFAULTS.continuityEvidenceLens).toBe(false);
  });

  it('turns one on only when a session asks for it', () => {
    expect(parseDevFlags('?continuityMicroGapFill=on').continuityMicroGapFill).toBe(true);
    expect(parseDevFlags('?continuityMicroGapFill=on').continuityTemporalAccumulation).toBe(false);
  });

  it('permits only the source rung when nothing is opted into', () => {
    expect(tierPermittedBy(NO_OPT_IN)).toBe('source');
  });
});

describe('the dial does ask for more, which is why the grant matters', () => {
  it('resolves a reconstructing rung on Auto for a capable desktop', () => {
    const desktop = DEVICES[0];
    const requested = qualitySettingsFor(autoQualityPosition(desktop), desktop).continuityTier;
    expect(requested).toBe('closure');
  });
});

describe('nothing is granted by default, over every combination', () => {
  it('returns source for every position, device and backend', () => {
    for (const device of DEVICES) {
      for (let position = QUALITY_MIN; position <= QUALITY_MAX; position += 1) {
        const requested = qualitySettingsFor(position, device).continuityTier;
        for (const backend of BACKENDS) {
          const granted = grantedTier(
            requested,
            tierFor(backend),
            tierCeilingFor(device.isMobile),
            NO_OPT_IN,
          );
          expect(granted, `${JSON.stringify({ device, position, backend })}`).toBe('source');
        }
      }
    }
  });

  it('reconstructs nothing and accumulates nothing, over the same product', () => {
    for (const device of DEVICES) {
      for (const position of [QUALITY_MIN, autoQualityPosition(device), QUALITY_MAX]) {
        const requested = qualitySettingsFor(position, device).continuityTier;
        for (const backend of BACKENDS) {
          const caps = grantedCapabilities(
            requested,
            tierFor(backend),
            tierCeilingFor(device.isMobile),
            NO_OPT_IN,
          );
          expect(caps.microGapFill).toBe(false);
          expect(caps.temporalAccumulation).toBe(false);
          expect(caps.coverageSizing).toBe(false);
          expect(caps.evidenceLens).toBe(false);
        }
      }
    }
  });
});

describe('a rung is granted whole or not at all', () => {
  const half: CapabilityOptIn = {
    ...NO_OPT_IN,
    coverageSizing: true,
    microGapFill: true,
    evidenceLens: true,
  };

  it('grants closure when exactly its capabilities are opted into', () => {
    expect(tierPermittedBy(half)).toBe('closure');
  });

  it('refuses full when one of its capabilities is missing', () => {
    expect(tierPermittedBy(half)).not.toBe('full');
  });

  it('falls to sizing when gap filling alone is withheld', () => {
    expect(tierPermittedBy({ ...half, microGapFill: false })).toBe('sizing');
  });

  it('grants full only when everything is opted into', () => {
    expect(
      tierPermittedBy({
        coverageSizing: true,
        microGapFill: true,
        temporalAccumulation: true,
        evidenceLens: true,
      }),
    ).toBe('full');
  });
});

describe('the grant never exceeds any one of its caps', () => {
  const all: CapabilityOptIn = {
    coverageSizing: true,
    microGapFill: true,
    temporalAccumulation: true,
    evidenceLens: true,
  };
  const rank = (t: string): number => TIER_ORDER.indexOf(t as never);

  it('stays at or below the request, the backend and the ceiling', () => {
    for (const requested of TIER_ORDER) {
      for (const backend of BACKENDS) {
        for (const touchFirst of [true, false]) {
          const ceiling = tierCeilingFor(touchFirst);
          const granted = grantedTier(requested, tierFor(backend), ceiling, all);
          expect(rank(granted)).toBeGreaterThanOrEqual(rank(requested));
          expect(rank(granted)).toBeGreaterThanOrEqual(rank(tierFor(backend)));
          expect(rank(granted)).toBeGreaterThanOrEqual(rank(ceiling));
        }
      }
    }
  });
});
