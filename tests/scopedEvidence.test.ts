/**
 * scopedEvidence.test.ts — the scoped external-evidence overlay MUST fail closed.
 *
 * Every case here uses SYNTHETIC in-memory records (no committed record ships): a
 * scoped E5 record raises effective evidence ONLY for an artifact inside its
 * envelope, and every mismatch — wrong method digest, wrong EPSG, wrong geoid,
 * broadened stratum, or missing context — falls back to the baseline registry
 * level. A committed record must be a non-claimable EXAMPLE template.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveEvidence,
  type ScopedEvidenceRecord,
  type EvidenceContext,
} from '../src/validation/scopedEvidence';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A synthetic frozen-study record: DTM validated to E5 for one exact method,
// CRS, geoid and terrain stratum. NOT a real study — test data only.
const STUDY: ScopedEvidenceRecord = {
  claimId: 'DTM',
  evidenceLevel: 'E5_EXTERNALLY_VALIDATED',
  studyId: 'SYNTH-STUDY-1',
  methodDigest: 'digest-abc',
  horizontalEpsg: 32613,
  verticalEpsg: 5703,
  geoidModel: 'GEOID18',
  terrainStratum: 'bare-earth',
  applicabilityEnvelope: {
    methodDigest: 'digest-abc',
    horizontalEpsg: 32613,
    verticalEpsg: 5703,
    geoidModel: 'GEOID18',
    terrainStratum: 'bare-earth',
  },
};

// The artifact context that exactly matches the study envelope.
const IN_ENVELOPE: EvidenceContext = {
  methodDigest: 'digest-abc',
  horizontalEpsg: 32613,
  verticalEpsg: 5703,
  geoidModel: 'GEOID18',
  terrainStratum: 'bare-earth',
};

const RECORDS = [STUDY];

describe('resolveEvidence — scoped overlay fails closed', () => {
  it('in-envelope artifact resolves to the scoped E5 (validated-in-scope)', () => {
    const r = resolveEvidence('DTM', IN_ENVELOPE, RECORDS);
    expect(r.effectiveEvidence).toBe('E5_EXTERNALLY_VALIDATED');
    expect(r.resolutionState).toBe('validated-in-scope');
    expect(r.matchedScopedStudy).toBe('SYNTH-STUDY-1');
    expect(r.baselineEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
  });

  it('wrong methodDigest → baseline (external-evidence-out-of-scope)', () => {
    const r = resolveEvidence('DTM', { ...IN_ENVELOPE, methodDigest: 'digest-XXX' }, RECORDS);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
    expect(r.matchedScopedStudy).toBeNull();
  });

  it('wrong horizontalEpsg → baseline (out-of-scope)', () => {
    const r = resolveEvidence('DTM', { ...IN_ENVELOPE, horizontalEpsg: 32614 }, RECORDS);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
  });

  it('wrong verticalEpsg → baseline (out-of-scope)', () => {
    const r = resolveEvidence('DTM', { ...IN_ENVELOPE, verticalEpsg: 5701 }, RECORDS);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
  });

  it('wrong geoidModel → baseline (out-of-scope)', () => {
    const r = resolveEvidence('DTM', { ...IN_ENVELOPE, geoidModel: 'GEOID12B' }, RECORDS);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
  });

  it('broadened terrainStratum (forest) not in envelope → baseline (out-of-scope)', () => {
    const r = resolveEvidence('DTM', { ...IN_ENVELOPE, terrainStratum: 'forest' }, RECORDS);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
  });

  it('NO context at all → baseline + applicability-unknown (conservative default)', () => {
    const r = resolveEvidence('DTM', undefined, RECORDS);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('applicability-unknown');
    expect(r.matchedScopedStudy).toBeNull();
  });

  it('incomplete context (missing safety-critical geoid) → applicability-unknown', () => {
    const { geoidModel: _omit, ...partial } = IN_ENVELOPE;
    const r = resolveEvidence('DTM', partial, RECORDS);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('applicability-unknown');
  });
});

describe('resolveEvidence — regression: no scoped record resolves as baseline', () => {
  it('a claim with NO scoped record resolves exactly as baseline (with default empty set)', () => {
    const r = resolveEvidence('DTM', IN_ENVELOPE);
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.baselineEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.matchedScopedStudy).toBeNull();
    // DTM is E4 but its required bar is E5, so absent scope it stays exploratory.
    expect(r.resolutionState).toBe('exploratory');
  });

  it('a claim that meets its E4 required bar reads cross-implementation', () => {
    // DSM: current E4, required E4 — meets its bar at the independence floor.
    const r = resolveEvidence('DSM');
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(r.resolutionState).toBe('cross-implementation');
  });

  it('a below-required claim with no scoped record stays exploratory', () => {
    const r = resolveEvidence('MEAS-DISTANCE');
    expect(r.effectiveEvidence).toBe('E3_SYNTHETICALLY_VALIDATED');
    expect(r.resolutionState).toBe('exploratory');
  });

  it('an unregistered claim is refused with a null baseline', () => {
    const r = resolveEvidence('NOPE-NOT-A-CLAIM');
    expect(r.baselineEvidence).toBeNull();
    expect(r.effectiveEvidence).toBeNull();
    expect(r.resolutionState).toBe('refused');
  });
});

describe('committed scoped records cannot promote a real artifact', () => {
  // A realistic real-artifact context that a real DTM export could carry.
  const REAL: EvidenceContext = {
    methodDigest: 'digest-abc',
    horizontalEpsg: 32613,
    verticalEpsg: 5703,
    geoidModel: 'GEOID18',
    terrainStratum: 'bare-earth',
  };

  const dir = resolve(ROOT, 'validation/evidence/scoped');
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.json') && !f.endsWith('.schema.json'),
  );

  it('there is at least one committed record file to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} is a non-claimable EXAMPLE template that cannot match a real artifact`, () => {
      // Every committed record file must be an EXAMPLE- template.
      expect(f.startsWith('EXAMPLE-')).toBe(true);
      const rec = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as ScopedEvidenceRecord;
      // Resolve any registered claim against the real artifact context using ONLY
      // this committed record — it must never rise above baseline.
      for (const claimId of ['DTM', 'DSM', 'CHM', rec.claimId]) {
        const r = resolveEvidence(claimId, REAL, [rec]);
        if (r.baselineEvidence !== null) {
          expect(r.effectiveEvidence).toBe(r.baselineEvidence);
        }
        expect(r.resolutionState).not.toBe('validated-in-scope');
      }
    });
  }
});
