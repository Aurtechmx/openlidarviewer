/**
 * evidenceBoundaryInspector.test.ts
 *
 * The inspector is a VIEW, not an authority. Every case asserts two things:
 *   1. the view's decision fields are byte-equal to `resolveEvidence`'s output
 *      (the inspector never diverges from the authority), and
 *   2. the per-field envelope breakdown resolves each status correctly
 *      (match / mismatch / missing / unconstrained).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveEvidence,
  type ScopedEvidenceRecord,
  type EvidenceContext,
} from '../src/validation/scopedEvidence';
import {
  buildEvidenceContractView,
  type EnvelopeCheckStatus,
} from '../src/validation/evidenceBoundaryInspector';

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

const IN_ENVELOPE: EvidenceContext = {
  methodDigest: 'digest-abc',
  horizontalEpsg: 32613,
  verticalEpsg: 5703,
  geoidModel: 'GEOID18',
  terrainStratum: 'bare-earth',
};

const RECORDS = [STUDY];

/** The constrained fields of STUDY's envelope. */
const PINNED = ['methodDigest', 'horizontalEpsg', 'verticalEpsg', 'geoidModel', 'terrainStratum'];

function statusOf(
  checks: readonly { field: string; status: EnvelopeCheckStatus }[],
  field: string,
): EnvelopeCheckStatus {
  const row = checks.find((c) => c.field === field);
  if (!row) throw new Error(`no envelope check for ${field}`);
  return row.status;
}

/** The view's decision must equal the authority's decision, always. */
function assertMirrorsAuthority(
  claimId: string,
  context?: EvidenceContext,
  records?: readonly ScopedEvidenceRecord[],
) {
  const authority = resolveEvidence(claimId, context, records);
  const view = buildEvidenceContractView(claimId, context, records);
  expect(view.effectiveEvidence).toBe(authority.effectiveEvidence);
  expect(view.resolutionState).toBe(authority.resolutionState);
  expect(view.baselineEvidence).toBe(authority.baselineEvidence);
  expect(view.matchedStudy).toBe(authority.matchedScopedStudy);
  expect(view.applicabilityVerdict).toBe(authority.applicabilityVerdict);
  return view;
}

describe('buildEvidenceContractView — mirrors resolveEvidence, explains the envelope', () => {
  it('in-envelope context: effective = scoped E5, every pinned field matches', () => {
    const view = assertMirrorsAuthority('DTM', IN_ENVELOPE, RECORDS);
    expect(view.effectiveEvidence).toBe('E5_EXTERNALLY_VALIDATED');
    expect(view.resolutionState).toBe('validated-in-scope');
    expect(view.matchedStudy).toBe('SYNTH-STUDY-1');
    for (const f of PINNED) expect(statusOf(view.envelopeChecks, f)).toBe('match');
    // A field the record does not pin reads unconstrained.
    expect(statusOf(view.envelopeChecks, 'cellSize')).toBe('unconstrained');
  });

  it('methodDigest mismatch: that field mismatch, effective drops to baseline (out-of-scope)', () => {
    const view = assertMirrorsAuthority(
      'DTM',
      { ...IN_ENVELOPE, methodDigest: 'digest-XXX' },
      RECORDS,
    );
    expect(view.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(view.resolutionState).toBe('external-evidence-out-of-scope');
    expect(statusOf(view.envelopeChecks, 'methodDigest')).toBe('mismatch');
    expect(statusOf(view.envelopeChecks, 'horizontalEpsg')).toBe('match');
  });

  it('EPSG mismatch: that field mismatch, effective = baseline', () => {
    const view = assertMirrorsAuthority(
      'DTM',
      { ...IN_ENVELOPE, horizontalEpsg: 32614 },
      RECORDS,
    );
    expect(view.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(statusOf(view.envelopeChecks, 'horizontalEpsg')).toBe('mismatch');
  });

  it('geoid mismatch: that field mismatch, effective = baseline', () => {
    const view = assertMirrorsAuthority(
      'DTM',
      { ...IN_ENVELOPE, geoidModel: 'GEOID12B' },
      RECORDS,
    );
    expect(view.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(statusOf(view.envelopeChecks, 'geoidModel')).toBe('mismatch');
  });

  it('terrain mismatch (forest): that field mismatch, effective = baseline', () => {
    const view = assertMirrorsAuthority(
      'DTM',
      { ...IN_ENVELOPE, terrainStratum: 'forest' },
      RECORDS,
    );
    expect(view.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(statusOf(view.envelopeChecks, 'terrainStratum')).toBe('mismatch');
  });

  it('missing safety-critical geoid: that field missing, state applicability-unknown', () => {
    const { geoidModel: _omit, ...partial } = IN_ENVELOPE;
    const view = assertMirrorsAuthority('DTM', partial, RECORDS);
    expect(view.resolutionState).toBe('applicability-unknown');
    expect(view.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(statusOf(view.envelopeChecks, 'geoidModel')).toBe('missing');
    expect(statusOf(view.envelopeChecks, 'methodDigest')).toBe('match');
  });

  it('no scoped record for the claim: empty envelopeChecks, baseline reflected', () => {
    const view = assertMirrorsAuthority('DTM', IN_ENVELOPE);
    expect(view.envelopeChecks).toEqual([]);
    expect(view.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(view.matchedStudy).toBeNull();
  });

  it('unregistered claim: refused, null evidence, empty checks', () => {
    const view = assertMirrorsAuthority('NOPE-NOT-A-CLAIM', IN_ENVELOPE, RECORDS);
    expect(view.resolutionState).toBe('refused');
    expect(view.baselineEvidence).toBeNull();
    expect(view.effectiveEvidence).toBeNull();
    expect(view.envelopeChecks).toEqual([]);
  });

  it('no context at all: mirrors applicability-unknown; pinned fields read missing', () => {
    const view = assertMirrorsAuthority('DTM', undefined, RECORDS);
    expect(view.resolutionState).toBe('applicability-unknown');
    for (const f of PINNED) expect(statusOf(view.envelopeChecks, f)).toBe('missing');
  });
});
