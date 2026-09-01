/**
 * scientificArtifactPassport.test.ts — construction, the reproducibility line,
 * and the scienceId identity contract.
 *
 * The load-bearing property: the scienceId names the SCIENCE, not the file. The
 * same DTM exported to two formats shares a scienceId but differs in
 * artifact.sha256; changing a method or the source changes the scienceId.
 */
import { describe, it, expect } from 'vitest';
import {
  buildScientificArtifactPassport,
  reproducibilityLine,
  PASSPORT_CLAIM_SCOPE,
  SCIENTIFIC_ARTIFACT_PASSPORT_SCHEMA,
  type ScientificArtifactPassportInput,
} from '../src/science/scientificArtifactPassport';
import {
  buildScientificAnalysisRecord,
  type ScientificAnalysisRecordInput,
} from '../src/science/scientificAnalysisRecord';
import { buildProcessingManifest } from '../src/science/processingManifest';
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

const manifest = buildProcessingManifest({
  build: '0.6.9 (abc1234)',
  source: 'site.laz',
  ops: [
    { method: 'olv.ground.smrf@1', params: { cell: 1, slope: 0.15 } },
    { method: 'olv.validation.spatial-block@2', params: { folds: 5 } },
  ],
});

const evidence = {
  baseline: 'E4',
  effective: 'E4',
  resolutionState: 'cross-implementation',
  matchedStudy: null,
  applicabilityVerdict: 'Baseline at required level; cross-implementation.',
};

function baseInput(bytes: Uint8Array, filename = 'dtm.tif', mediaType = 'image/tiff'): ScientificArtifactPassportInput {
  return {
    source: { name: 'site.laz', sha256: 'a'.repeat(64) },
    analysis: buildScientificAnalysisRecord(recordInput),
    processing: manifest,
    methodDigest: 'deadbeef',
    evidence,
    artifact: { filename, mediaType, bytes },
    geoid: 'GEOID18',
    build,
  };
}

const GEOTIFF = new Uint8Array([1, 2, 3, 4, 5]);
const ASC = new Uint8Array([9, 8, 7]); // same science, different exported bytes

describe('buildScientificArtifactPassport', () => {
  it('composes every provenance field and seals the document', () => {
    const p = buildScientificArtifactPassport(baseInput(GEOTIFF));
    expect(p.schemaVersion).toBe(SCIENTIFIC_ARTIFACT_PASSPORT_SCHEMA);
    expect(p.source.digestStatus).toBe('verified');
    expect(p.analysis.kind).toBe('terrain-dtm');
    expect(p.analysis.legacyContentHash).toBe(
      buildScientificAnalysisRecord(recordInput).contentHash,
    );
    expect(p.processing.manifestHead).toBe(manifest.head);
    expect(p.processing.verified).toBe(true);
    expect(p.method.ids).toEqual(['olv.ground.smrf', 'olv.validation.spatial-block']);
    expect(p.method.methodDigest).toBe('deadbeef');
    expect(p.artifact.bytes).toBe(5);
    expect(p.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.scienceId).toMatch(/^[0-9a-f]{64}$/);
    expect(p.passportSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks the source digest unavailable when no whole-source hash was supplied', () => {
    const input = baseInput(GEOTIFF);
    const p = buildScientificArtifactPassport({
      ...input,
      source: { name: 'site.laz', sha256: null },
    });
    expect(p.source.digestStatus).toBe('unavailable');
    expect(p.source.sha256).toBeNull();
  });

  it('is deterministic — same inputs, same scienceId and seal', () => {
    const a = buildScientificArtifactPassport(baseInput(GEOTIFF));
    const b = buildScientificArtifactPassport(baseInput(GEOTIFF));
    expect(a.scienceId).toBe(b.scienceId);
    expect(a.passportSha256).toBe(b.passportSha256);
  });

  it('throws before any digest when a caller supplies an unregistered method id', () => {
    expect(() =>
      buildScientificArtifactPassport({ ...baseInput(GEOTIFF), methodIds: ['olv.not.real'] }),
    ).toThrow(/Unknown method id: olv\.not\.real/);
  });
});

describe('PASSPORT_CLAIM_SCOPE', () => {
  it('pins the tamper-evidence disclaimer and claims nothing stronger', () => {
    const scope = PASSPORT_CLAIM_SCOPE.toLowerCase();
    expect(scope).toContain('tamper-evident');
    expect(scope).toContain('not authenticated');
    expect(scope).not.toContain('certified accurate');
    expect(scope).not.toContain('authenticated by');
    expect(scope).not.toContain('survey-grade');
  });
});

describe('scienceId identity contract', () => {
  it('same science, different export format ⇒ same scienceId, different artifact sha', () => {
    const geotiff = buildScientificArtifactPassport(baseInput(GEOTIFF, 'dtm.tif', 'image/tiff'));
    const asc = buildScientificArtifactPassport(baseInput(ASC, 'dtm.asc', 'text/plain'));
    expect(asc.scienceId).toBe(geotiff.scienceId);
    expect(asc.artifact.sha256).not.toBe(geotiff.artifact.sha256);
  });

  it('changed method ⇒ different scienceId', () => {
    const before = buildScientificArtifactPassport(baseInput(GEOTIFF));
    const after = buildScientificArtifactPassport({
      ...baseInput(GEOTIFF),
      analysis: buildScientificAnalysisRecord({
        ...recordInput,
        methodIds: ['olv.terrain.slope-horn', 'olv.validation.spatial-block'],
      }),
      methodIds: ['olv.terrain.slope-horn', 'olv.validation.spatial-block'],
    });
    expect(after.scienceId).not.toBe(before.scienceId);
  });

  it('changed method digest ⇒ different scienceId', () => {
    const before = buildScientificArtifactPassport(baseInput(GEOTIFF));
    const after = buildScientificArtifactPassport({ ...baseInput(GEOTIFF), methodDigest: 'feedface' });
    expect(after.scienceId).not.toBe(before.scienceId);
  });

  it('changed source ⇒ different scienceId', () => {
    const before = buildScientificArtifactPassport(baseInput(GEOTIFF));
    const after = buildScientificArtifactPassport({
      ...baseInput(GEOTIFF),
      source: { name: 'site.laz', sha256: 'b'.repeat(64) },
    });
    expect(after.scienceId).not.toBe(before.scienceId);
  });

  it('export format and filename do NOT enter the scienceId', () => {
    const a = buildScientificArtifactPassport(baseInput(GEOTIFF, 'one.tif', 'image/tiff'));
    const b = buildScientificArtifactPassport(baseInput(GEOTIFF, 'two.asc', 'text/plain'));
    expect(a.scienceId).toBe(b.scienceId);
  });
});

describe('reproducibilityLine', () => {
  it('renders one line with build, science id, methods, evidence, CRS, geoid and source', () => {
    const line = reproducibilityLine(buildScientificArtifactPassport(baseInput(GEOTIFF)));
    expect(line).toContain('0.6.9 (abc1234)');
    expect(line).toContain('Science ID ');
    expect(line).toContain('olv.ground.smrf@1');
    expect(line).toContain('evidence E4');
    expect(line).toContain('EPSG:32610');
    expect(line).toContain('EPSG:5703');
    expect(line).toContain('geoid GEOID18');
    expect(line).toContain('source ');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('omits the source segment when no source digest was recorded', () => {
    const p = buildScientificArtifactPassport({
      ...baseInput(GEOTIFF),
      source: { name: 'site.laz', sha256: null },
    });
    expect(reproducibilityLine(p)).not.toContain('source ');
  });
});
