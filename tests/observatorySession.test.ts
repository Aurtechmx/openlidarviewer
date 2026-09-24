import { describe, expect, it } from 'vitest';

import { commitObservationSession, verifyObservationRerun, type ObservationSessionRecord } from '../src/observation/session';
import type { ObservationFreshnessStamp } from '../src/science/analysisFreshness';
import type { ObservationDomain } from '../src/observation/ledger';
import type { ObservationParameters } from '../src/observation/types';

/** OB-SES-01 + F14: the session commit gate, and the rerun-digest check. */

const sameTarget = (a: string | null, b: string | null): boolean => a !== null && a === b;

const stamp = (over: Partial<ObservationFreshnessStamp> = {}): ObservationFreshnessStamp => ({
  targetId: 'scan_1',
  classificationEpoch: 3,
  crsRevision: 7,
  coverageMode: 'full',
  sourceDigest: 'sha256:source',
  basis: 'full',
  roiDigest: 'sha256:roi',
  stationSetDigest: 'sha256:stations',
  parameterDigest: 'sha256:params',
  methodTags: [],
  metresPerUnit: 1,
  ...over,
});

const now = (over: Partial<Pick<ObservationFreshnessStamp, 'targetId' | 'classificationEpoch' | 'crsRevision' | 'sourceDigest' | 'roiDigest' | 'stationSetDigest' | 'parameterDigest'>> = {}) => ({
  targetId: 'scan_1',
  classificationEpoch: 3,
  crsRevision: 7,
  sourceDigest: 'sha256:source',
  roiDigest: 'sha256:roi',
  stationSetDigest: 'sha256:stations',
  parameterDigest: 'sha256:params',
  ...over,
});

const domain: ObservationDomain = { min: [0, 0, 0], max: [10, 10, 10] };
const parameters: ObservationParameters = { p_solid: 0.9, p_empty: 0.1, n_min: 5, tau_abs: 0.1, tau_rel: 0 };

const result = {
  domain, voxelEdge: 0.5, parameters,
  fieldDigest: 'sha256:field-1',
  runRecordDigest: 'sha256:run-1',
};

describe('OB-SES-01 commitObservationSession', () => {
  it('commits a session record when every freshness fact still matches', () => {
    const verdict = commitObservationSession(stamp(), now(), sameTarget, result);
    expect(verdict.status).toBe('committed');
    if (verdict.status === 'committed') {
      expect(verdict.session.fieldDigest).toBe('sha256:field-1');
      expect(verdict.session.parameters).toEqual(parameters);
    }
  });

  it('F14: refuses with reason "roi" when the region of interest changed mid-run, and nothing else', () => {
    const verdict = commitObservationSession(stamp(), now({ roiDigest: 'sha256:roi-2' }), sameTarget, result);
    expect(verdict.status).toBe('refused');
    if (verdict.status === 'refused') {
      expect(verdict.reason).toBe('roi');
      expect(verdict.message).toMatch(/region of interest/i);
    }
  });

  it('refuses with reason "stationSet" when the station set changed, not "roi"', () => {
    const verdict = commitObservationSession(stamp(), now({ stationSetDigest: 'sha256:stations-2' }), sameTarget, result);
    expect(verdict.status).toBe('refused');
    if (verdict.status === 'refused') expect(verdict.reason).toBe('stationSet');
  });

  it('OB-INV-09: a refused commit never produces a session record', () => {
    const verdict = commitObservationSession(stamp(), now({ roiDigest: 'sha256:roi-2' }), sameTarget, result);
    expect((verdict as { session?: unknown }).session).toBeUndefined();
  });
});

describe('OB-SES-01 verifyObservationRerun', () => {
  const saved: ObservationSessionRecord = {
    schemaVersion: 1, stamp: stamp(), domain, voxelEdge: 0.5, parameters,
    fieldDigest: 'sha256:field-1', runRecordDigest: 'sha256:run-1',
  };

  it('marks a rerun current only when its fieldDigest matches the saved one', () => {
    expect(verifyObservationRerun(saved, 'sha256:field-1')).toBe('current');
  });

  it('marks a rerun stale on any digest mismatch', () => {
    expect(verifyObservationRerun(saved, 'sha256:field-DIFFERENT')).toBe('stale');
  });
});
