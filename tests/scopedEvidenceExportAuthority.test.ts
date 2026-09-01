/**
 * scopedEvidenceExportAuthority.test.ts (§18/§55) — one authoritative resolver.
 *
 * The provenance stamp, the evidence note and the analysis-record gate for a DTM
 * export MUST all derive from the SAME {@link resolveExportEvidence} call, so no
 * two surfaces can ever disagree (one saying E5 while another says E4). These
 * cases use SYNTHETIC in-memory records only — no committed record ships. They
 * assert the three export surfaces AGREE for an in-scope, a no-context, and an
 * out-of-scope resolution.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveExportEvidence,
  type ScopedEvidenceRecord,
  type EvidenceContext,
} from '../src/validation/scopedEvidence';
import { scopedEvidenceNote } from '../src/validation/exportEvidenceNote';
import {
  buildExportProvenance,
  provenanceLines,
  provenanceJson,
  analysisRecordFromProvenance,
} from '../src/terrain/export/exportProvenance';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

// A synthetic frozen-study record: DTM validated to E5 for one exact method,
// CRS, geoid and terrain stratum. NOT a real study — test data only.
const STUDY: ScopedEvidenceRecord = {
  claimId: 'DTM',
  evidenceLevel: 'E5_EXTERNALLY_VALIDATED',
  studyId: 'SYNTH-STUDY-9',
  methodDigest: 'digest-xyz',
  horizontalEpsg: 32613,
  verticalEpsg: 5703,
  geoidModel: 'GEOID18',
  applicabilityEnvelope: {
    methodDigest: 'digest-xyz',
    horizontalEpsg: 32613,
    verticalEpsg: 5703,
    geoidModel: 'GEOID18',
  },
};
const RECORDS = [STUDY];

const IN_SCOPE: EvidenceContext = {
  methodDigest: 'digest-xyz',
  horizontalEpsg: 32613,
  verticalEpsg: 5703,
  geoidModel: 'GEOID18',
};

const OUT_OF_SCOPE: EvidenceContext = {
  methodDigest: 'digest-OTHER',
  horizontalEpsg: 25830,
  verticalEpsg: 5703,
  geoidModel: 'GEOID18',
};

/** An export-ready analysis result. This test only exercises evidence
 *  resolution, so it is assembled from named parts (not one inline literal) —
 *  the values it carries are incidental to what is asserted. */
function readyResult(): AnalyseContoursResult {
  const crs = 'EPSG:32613';
  const datum = 'EPSG:5703';
  const frame = { crs, verticalDatum: datum, coverageMode: 'full' as const };
  const accuracyStandards = {
    rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
    densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
  };
  const quality = {
    readiness: 'ready', exportReadiness: 'available',
    crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
  };
  const cellStatusTally = { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 };
  const generationParams = { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' };
  return {
    dtm: { ...frame, meanConfidence: 82 },
    intervalM: 1,
    model: { ...frame, intervalM: 1, contourStyle: 'smooth' },
    accuracyStandards, quality,
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally, generationParams,
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

function buildFor(context: EvidenceContext | undefined) {
  return buildExportProvenance(readyResult(), {
    basename: 'scan',
    generatedAt: '2026-01-01T00:00:00.000Z',
    softwareVersion: '0.6.9',
    metricVersion: 'v0.4.1',
    evidenceContext: context ?? null,
    scopedRecords: RECORDS,
  });
}

describe('resolveExportEvidence — the one authoritative export-evidence resolver', () => {
  it('in-scope: provenance, note and gate all AGREE on the scoped E5', () => {
    const res = resolveExportEvidence('DTM', IN_SCOPE, RECORDS, 'baseline');
    expect(res.effectiveEvidence).toBe('E5_EXTERNALLY_VALIDATED');
    expect(res.baselineEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(res.applicabilityStatus).toBe('validated-in-scope');
    expect(res.matchedStudy).toBe('SYNTH-STUDY-9');

    const p = buildFor(IN_SCOPE);
    // The provenance carries the SAME resolution object.
    expect(p.evidenceResolution?.effectiveEvidence).toBe('E5_EXTERNALLY_VALIDATED');
    expect(p.scopedEvidence?.effectiveEvidence).toBe('E5_EXTERNALLY_VALIDATED');

    // Every surface derives from that one resolution — none contradicts it.
    const line = provenanceLines(p).find((l) => l.startsWith('Evidence'));
    expect(line?.endsWith(p.evidenceResolution!.note)).toBe(true);
    expect(provenanceJson(p).evidence).toBe(p.evidenceResolution!.note);
    // The standalone note helper agrees with the provenance note for the same input.
    expect(scopedEvidenceNote('DTM', IN_SCOPE, RECORDS)).toContain('SYNTH-STUDY-9');

    // The gate tracks the EFFECTIVE level: an in-scope E5 match meets the
    // required E5, so the artifact exports as validated, not exploratory. The
    // baseline gate (empty runtime registry = E4) still reads exploratory and is
    // retained for the audit trail — the two are distinct, and no longer contradict.
    expect(res.gate.exploratoryOnly).toBe(false);
    expect(res.gate.allowed).toBe(true);
    expect(res.baselineGate.exploratoryOnly).toBe(true);
    const rec = analysisRecordFromProvenance(p);
    expect(rec.evidenceExploratory).toBe(false);
    expect(rec.evidenceExploratory).toBe(p.evidenceResolution!.gate.exploratoryOnly);
  });

  it('no context: baseline everywhere (conservative, no promotion)', () => {
    // With NO scoped record at all, the note is the caller's baseline wording.
    const bare = resolveExportEvidence('DTM', undefined, [], 'baseline');
    expect(bare.note).toBe('baseline');
    expect(bare.effectiveEvidence).toBe(bare.baselineEvidence);

    // With scoped records present but no context, applicability is unknown and
    // the level still stays at baseline (never promoted).
    const res = resolveExportEvidence('DTM', undefined, RECORDS, 'baseline');
    expect(res.effectiveEvidence).toBe(res.baselineEvidence);
    expect(res.applicabilityStatus).toBe('applicability-unknown');

    const p = buildFor(undefined);
    // No signal ⇒ the scoped disclosure block is absent, and the effective level
    // equals the baseline: nothing was promoted.
    expect(p.scopedEvidence).toBeNull();
    expect(p.evidenceResolution?.effectiveEvidence).toBe(
      p.evidenceResolution?.baselineEvidence,
    );
    const line = provenanceLines(p).find((l) => l.startsWith('Evidence'));
    expect(line?.endsWith(p.evidenceResolution!.note)).toBe(true);
    expect(provenanceJson(p).evidence).toBe(p.evidenceResolution!.note);
  });

  it('out-of-scope context: baseline everywhere (never the scoped level)', () => {
    const res = resolveExportEvidence('DTM', OUT_OF_SCOPE, RECORDS, 'baseline');
    expect(res.effectiveEvidence).toBe(res.baselineEvidence);
    expect(res.applicabilityStatus).toBe('external-evidence-out-of-scope');

    const p = buildFor(OUT_OF_SCOPE);
    expect(p.evidenceResolution?.effectiveEvidence).toBe(
      p.evidenceResolution?.baselineEvidence,
    );
    expect(p.scopedEvidence?.effectiveEvidence).toBe(
      p.scopedEvidence?.baselineEvidence,
    );
    // The note must not assert the scoped level.
    expect(provenanceJson(p).evidence).not.toContain('E5');
  });
});
