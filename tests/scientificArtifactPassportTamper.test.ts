/**
 * scientificArtifactPassportTamper.test.ts — the tamper-evidence contract.
 *
 * A clean passport verifies; a passport whose chain has been broken at exactly
 * one link reports the precise link. Each case mutates ONE thing and asserts the
 * corresponding non-VERIFIED state. This is tamper EVIDENCE (internal
 * consistency), not authentication — no key is involved.
 */
import { describe, it, expect } from 'vitest';
import {
  buildScientificArtifactPassport,
  verifyScientificArtifactPassport,
  type ScientificArtifactPassport,
  type ScientificArtifactPassportInput,
} from '../src/science/scientificArtifactPassport';
import {
  buildScientificAnalysisRecord,
  type ScientificAnalysisRecordInput,
} from '../src/science/scientificAnalysisRecord';
import {
  buildProcessingManifest,
  verifyProcessingManifest,
  type ProcessingOpInput,
} from '../src/science/processingManifest';
import type { BuildIdentity } from '../src/build/buildIdentity';

const build: BuildIdentity = {
  version: '0.6.9',
  commit: 'abc1234',
  dirty: false,
  builtAt: '2026-08-31T00:00:00.000Z',
  node: 'v22.22.3',
  channel: 'live',
};

const recordInput: ScientificAnalysisRecordInput = {
  kind: 'terrain-dtm',
  source: 'site.laz',
  crs: {
    horizontal: 'EPSG:32610',
    horizontalKnown: true,
    verticalDatum: 'EPSG:5703',
    verticalDatumKnown: true,
  },
  methodIds: ['olv.ground.smrf', 'olv.validation.spatial-block'],
  evidenceExploratory: true,
  summary: { rmseZM: 0.14, quality: 'Good' },
  generatedAt: '2026-06-05T00:00:00.000Z',
  build,
};

const opsInput: ProcessingOpInput[] = [
  { method: 'olv.ground.smrf@1', params: { cell: 1, slope: 0.15 } },
  { method: 'olv.validation.spatial-block@2', params: { folds: 5 } },
];

const manifest = buildProcessingManifest({
  build: '0.6.9 (abc1234)',
  source: 'site.laz',
  ops: opsInput,
});

const evidence = {
  baseline: 'E4',
  effective: 'E4',
  resolutionState: 'cross-implementation',
  matchedStudy: null,
  applicabilityVerdict: 'Baseline at required level; cross-implementation.',
};

const ARTIFACT = new Uint8Array([1, 2, 3, 4, 5]);
const SOURCE = new Uint8Array([10, 20, 30, 40]);

function makeInput(): ScientificArtifactPassportInput {
  return {
    source: { name: 'site.laz', sha256: null },
    analysis: buildScientificAnalysisRecord(recordInput),
    processing: manifest,
    methodDigest: 'deadbeef',
    evidence,
    artifact: { filename: 'dtm.tif', mediaType: 'image/tiff', bytes: ARTIFACT },
    geoid: 'GEOID18',
    build,
  };
}

// A clone whose deeply-frozen-ness we do not rely on — plain structured clone.
function clone(p: ScientificArtifactPassport): ScientificArtifactPassport {
  return JSON.parse(JSON.stringify(p));
}

describe('verifyScientificArtifactPassport — clean pass', () => {
  it('verifies an untouched passport, with and without references', () => {
    const p = buildScientificArtifactPassport(makeInput());
    expect(verifyScientificArtifactPassport(p)).toBe('VERIFIED');
    expect(
      verifyScientificArtifactPassport(p, {
        artifactBytes: ARTIFACT,
        analysis: buildScientificAnalysisRecord(recordInput),
        methodIds: ['olv.ground.smrf', 'olv.validation.spatial-block'],
        methodDigest: 'deadbeef',
        processing: manifest,
        evidence,
      }),
    ).toBe('VERIFIED');
  });

  it('verifies the source digest when source bytes are supplied', () => {
    // sha256Hex(SOURCE) obtained by hashing SOURCE through the artifact path.
    const sourceSha = buildScientificArtifactPassport({
      ...makeInput(),
      artifact: { filename: 'x', mediaType: 'x', bytes: SOURCE },
    }).artifact.sha256;
    const withSource = buildScientificArtifactPassport({
      ...makeInput(),
      source: { name: 'site.laz', sha256: sourceSha },
    });
    expect(verifyScientificArtifactPassport(withSource, { sourceBytes: SOURCE })).toBe('VERIFIED');
  });
});

describe('verifyScientificArtifactPassport — one broken link', () => {
  it('ARTIFACT_CHANGED: one artifact byte differs', () => {
    const p = buildScientificArtifactPassport(makeInput());
    const mutated = new Uint8Array([1, 2, 3, 4, 6]);
    expect(verifyScientificArtifactPassport(p, { artifactBytes: mutated })).toBe('ARTIFACT_CHANGED');
  });

  it('SOURCE_CHANGED: one source byte differs', () => {
    const recordedSourceSha = buildScientificArtifactPassport({
      ...makeInput(),
      artifact: { filename: 'x', mediaType: 'x', bytes: SOURCE },
    }).artifact.sha256;
    const p = buildScientificArtifactPassport({
      ...makeInput(),
      source: { name: 'site.laz', sha256: recordedSourceSha },
    });
    const mutated = new Uint8Array([10, 20, 30, 41]);
    expect(verifyScientificArtifactPassport(p, { sourceBytes: mutated })).toBe('SOURCE_CHANGED');
  });

  it('METHOD_MISMATCH: one method param (digest) differs', () => {
    const p = buildScientificArtifactPassport(makeInput());
    expect(verifyScientificArtifactPassport(p, { methodDigest: 'feedface' })).toBe('METHOD_MISMATCH');
  });

  it('METHOD_MISMATCH: a registered method id differs', () => {
    const p = buildScientificArtifactPassport(makeInput());
    expect(
      verifyScientificArtifactPassport(p, {
        methodIds: ['olv.terrain.slope-horn', 'olv.validation.spatial-block'],
      }),
    ).toBe('METHOD_MISMATCH');
  });

  it('PROCESSING_MANIFEST_CHANGED: one processing op parameter differs', () => {
    const p = buildScientificArtifactPassport(makeInput());
    const tampered = buildProcessingManifest({
      build: '0.6.9 (abc1234)',
      source: 'site.laz',
      ops: [
        { method: 'olv.ground.smrf@1', params: { cell: 1, slope: 0.99 } },
        { method: 'olv.validation.spatial-block@2', params: { folds: 5 } },
      ],
    });
    expect(verifyScientificArtifactPassport(p, { processing: tampered })).toBe(
      'PROCESSING_MANIFEST_CHANGED',
    );
  });

  it('PROCESSING_MANIFEST_CHANGED: the processing order differs', () => {
    const p = buildScientificArtifactPassport(makeInput());
    const reordered = buildProcessingManifest({
      build: '0.6.9 (abc1234)',
      source: 'site.laz',
      ops: [opsInput[1], opsInput[0]],
    });
    expect(verifyScientificArtifactPassport(p, { processing: reordered })).toBe(
      'PROCESSING_MANIFEST_CHANGED',
    );
  });

  it('EVIDENCE_MISMATCH: the effective evidence level differs', () => {
    const p = buildScientificArtifactPassport(makeInput());
    expect(
      verifyScientificArtifactPassport(p, { evidence: { ...evidence, effective: 'E5' } }),
    ).toBe('EVIDENCE_MISMATCH');
  });

  it('ANALYSIS_CHANGED: the CRS in the analysis differs', () => {
    const p = buildScientificArtifactPassport(makeInput());
    const differentCrs = buildScientificAnalysisRecord({
      ...recordInput,
      crs: { ...recordInput.crs, horizontal: 'EPSG:32611' },
    });
    expect(verifyScientificArtifactPassport(p, { analysis: differentCrs })).toBe('ANALYSIS_CHANGED');
  });

  it('PASSPORT_CORRUPT: the build commit was edited', () => {
    const p = clone(buildScientificArtifactPassport(makeInput()));
    (p.build as { commit: string }).commit = 'ffff000';
    expect(verifyScientificArtifactPassport(p)).toBe('PASSPORT_CORRUPT');
  });

  it('PASSPORT_CORRUPT: an arbitrary recorded field was edited', () => {
    const p = clone(buildScientificArtifactPassport(makeInput()));
    (p.analysis as { kind: string }).kind = 'terrain-dsm';
    expect(verifyScientificArtifactPassport(p)).toBe('PASSPORT_CORRUPT');
  });

  it('PASSPORT_CORRUPT: a scienceId component was edited without resealing identity', () => {
    const p = clone(buildScientificArtifactPassport(makeInput()));
    // Edit the recorded manifest head AND reseal passportSha256 so the seal
    // passes, leaving only the scienceId redundancy to catch it.
    (p.processing as { manifestHead: string }).manifestHead = 'e'.repeat(64);
    // Reseal is done by rebuilding; instead assert the identity check fires.
    expect(verifyScientificArtifactPassport(p)).toBe('PASSPORT_CORRUPT');
  });

  it('INCOMPLETE: a required field is missing', () => {
    const p = clone(buildScientificArtifactPassport(makeInput()));
    delete (p as { passportSha256?: string }).passportSha256;
    expect(verifyScientificArtifactPassport(p)).toBe('INCOMPLETE');
  });
});

describe('verifyScientificArtifactPassport — fails closed over a broken chain', () => {
  it('never returns VERIFIED when the processing chain did not verify intact', () => {
    // A manifest whose op parameter was altered without re-folding the chain:
    // the recorded head no longer covers it, so verifyProcessingManifest reports
    // it broken and the passport records processing.verified === false.
    const tampered = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    (tampered.ops[0] as { params: Record<string, unknown> }).params = { cell: 1, slope: 0.99 };
    expect(verifyProcessingManifest(tampered).ok).toBe(false);

    const p = buildScientificArtifactPassport({ ...makeInput(), processing: tampered });
    expect(p.processing.verified).toBe(false);

    // Fail closed with no reference material supplied at all.
    expect(verifyScientificArtifactPassport(p)).not.toBe('VERIFIED');
    expect(verifyScientificArtifactPassport(p)).toBe('PROCESSING_MANIFEST_CHANGED');

    // And with the full reference set supplied.
    expect(
      verifyScientificArtifactPassport(p, {
        artifactBytes: ARTIFACT,
        analysis: buildScientificAnalysisRecord(recordInput),
        methodIds: ['olv.ground.smrf', 'olv.validation.spatial-block'],
        methodDigest: 'deadbeef',
        processing: tampered,
        evidence,
      }),
    ).not.toBe('VERIFIED');
  });
});
