import { describe, expect, it } from 'vitest';

import {
  observationFreshnessBreach,
  OBSERVATION_FRESHNESS_REFUSALS,
} from '../src/science/analysisFreshness';
import { now, sameTarget, stamp } from './helpers/observatoryFixtures';

/** OB-INT-03 / OB-INV-09: the extended stamp refuses on any of its own four extra facts, naming which one moved. */

describe('OB-INT-03 observationFreshnessBreach', () => {
  it('passes when every fact still matches', () => {
    expect(observationFreshnessBreach(stamp(), now(), sameTarget)).toBeNull();
  });

  it('reports the shared facts (scan, classification, frame) exactly as the terrain check does, checked first', () => {
    expect(observationFreshnessBreach(stamp(), now({ targetId: 'scan_2' }), sameTarget)).toBe('scan');
    expect(observationFreshnessBreach(stamp(), now({ classificationEpoch: 4 }), sameTarget)).toBe('classification');
    expect(observationFreshnessBreach(stamp(), now({ crsRevision: 8 }), sameTarget)).toBe('frame');
  });

  it('OB-INV-09: names "source" when the source digest moves', () => {
    expect(observationFreshnessBreach(stamp(), now({ sourceDigest: 'sha256:other' }), sameTarget)).toBe('source');
  });

  it('OB-INV-09: names "roi" when the ROI digest moves (SPEC F14: "ROI changed mid-run")', () => {
    expect(observationFreshnessBreach(stamp(), now({ roiDigest: 'sha256:other' }), sameTarget)).toBe('roi');
  });

  it('OB-INV-09: names "stationSet" when the station-set digest moves', () => {
    expect(observationFreshnessBreach(stamp(), now({ stationSetDigest: 'sha256:other' }), sameTarget)).toBe('stationSet');
  });

  it('OB-INV-09: names "parameters" when the parameter digest moves', () => {
    expect(observationFreshnessBreach(stamp(), now({ parameterDigest: 'sha256:other' }), sameTarget)).toBe('parameters');
  });

  it('a null stamp is always current: no result exists to protect', () => {
    expect(observationFreshnessBreach(null, now(), sameTarget)).toBeNull();
  });

  it('checks facts in a fixed order, so two simultaneous changes report one name consistently', () => {
    // scan and source both moved; scan (the shared check) wins, matching
    // analysisFreshnessBreach's own stated order.
    expect(
      observationFreshnessBreach(stamp(), now({ targetId: 'scan_2', sourceDigest: 'sha256:other' }), sameTarget),
    ).toBe('scan');
    // roi and stationSet both moved; roi is checked first among Observatory's own four.
    expect(
      observationFreshnessBreach(stamp(), now({ roiDigest: 'sha256:other', stationSetDigest: 'sha256:other' }), sameTarget),
    ).toBe('roi');
  });
});

describe('OBSERVATION_FRESHNESS_REFUSALS', () => {
  it('has one refusal string for every breach the function can return', () => {
    const breaches = ['scan', 'classification', 'frame', 'source', 'roi', 'stationSet', 'parameters'] as const;
    for (const b of breaches) {
      expect(typeof OBSERVATION_FRESHNESS_REFUSALS[b]).toBe('string');
      expect(OBSERVATION_FRESHNESS_REFUSALS[b].length).toBeGreaterThan(0);
    }
  });

  it('reuses the shared refusal text verbatim rather than restating it', () => {
    expect(OBSERVATION_FRESHNESS_REFUSALS.scan).toContain('terrain analysis');
  });
});
