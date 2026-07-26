/**
 * provenanceIntegrity.test.ts — suite 5: can a stranger holding one artifact
 * say what produced it, and can they tell if the account was altered?
 *
 * The suite asks four questions of every exported artifact the project can
 * produce from pure data — the contour GeoJSON, the text stamp that goes into
 * DXF/SVG/README/PDF, the scientific record, the processing manifest, the
 * integrity report, and the published benchmark result tree:
 *
 *   COMPLETENESS  — does the artifact name its source, its method chain with
 *                   bound parameters, the build and commit, and the evidence
 *                   level or limitation the project's model attaches to it?
 *   ACCURACY      — do the declared parameters equal the parameters the run
 *                   actually used? This is the drift class: a manifest naming
 *                   a tolerance the geometry does not have.
 *   TAMPER        — is an edit detectable in BOTH directions: bytes altered
 *                   with the account left alone, and the account altered with
 *                   every digest inside it refreshed?
 *   BLINDNESS     — is the verifier blind to any file it emits itself, and can
 *                   two different artifacts compose to one identity key?
 *
 * The tamper cases never stop at "a stale digest no longer matches". A stale
 * digest catches an editor, not an attacker. Each tamper case that can be
 * re-stamped IS re-stamped — every hash in the chain recomputed, the head
 * refreshed — and the detection then has to come from re-deriving the account
 * from something the attacker did not control. Where nothing can re-derive it,
 * the test PINS that limit instead of implying a guarantee that is not there.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildExportProvenance,
  processingManifestFromProvenance,
  analysisRecordFromProvenance,
  provenanceJson,
  provenanceLines,
  EVIDENCE_GATE_NOTE,
  NOT_SURVEY_GRADE_NOTE,
  type ExportProvenance,
  type ExportPermitStamp,
} from '../../src/terrain/export/exportProvenance';
import {
  buildProcessingManifest,
  verifyProcessingManifest,
  type ProcessingManifest,
} from '../../src/science/processingManifest';
import { canonicalHash, canonicalJson } from '../../src/canonicalHash';
import { METHOD_REGISTRY, isMethodId, method, methodRef } from '../../src/science/methodRegistry';
import { SCIENTIFIC_EXPORTERS, resolveExportDecision } from '../../src/export/exportManifest';
import { permitStamp } from '../../src/export/permitStamp';
import { resolveContourExportPermit } from '../../src/export/contourExportPermit';
import { buildReportManifest } from '../../src/render/measure/reportManifest';
import { canonicalize, fnv1a, sha256 } from '../../src/render/measure/auditLog';
import { verifyReportFile } from '../../src/export/verifyReport';
import { toGeoJSON } from '../../src/terrain/contour/geojsonContours';
import {
  writeLas,
  writeLas14,
  composeGeneratingSoftware,
  lasGeneratingSoftware,
} from '../../src/convert/writeLas';
import type { GlobalPoints } from '../../src/convert/globalPoints';
import { parseLasHeader } from '../../src/io/lasHeader';
import { BUILD_IDENTITY } from '../../src/build/buildIdentity';
import type { AnalyseContoursResult } from '../../src/terrain/contour/analyseContours';
import type { ContourFeatureModel } from '../../src/terrain/contour/contourFeatureModel';

import { hashArtifact, toHashable } from '../../benchmarks/framework/artifacts';
import { runReproducibilitySuite } from '../../benchmarks/runner/reproducibility';
import { writeResults } from '../../benchmarks/runner/writer';
import { verifyResultsDir } from '../../benchmarks/runner/verify';
import type { ReproducibilityConfig } from '../../benchmarks/runner/config';
import { nodeSha256Hex } from '../../benchmarks/framework/node';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete, export-ready run: CRS known, accuracy measured, complexity derived. */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', coverageMode: 'full', meanConfidence: 82 },
    intervalM: 1,
    model: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      intervalM: 1,
      contourStyle: 'generalized',
      coverageMode: 'full',
    },
    accuracyStandards: {
      rmseZM: 0.14,
      nvaM: 0.27,
      vvaM: 0.3,
      pointDensityPerM2: 4.2,
      qualityLevel: 'QL2',
      qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready',
      exportReadiness: 'available',
      crsKnown: true,
      datumKnown: true,
      coverageMode: 'full',
      reasons: [],
      exportReasons: [],
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    complexity: {
      band: 'moderate',
      vrmMedian: 0.034,
      vrmIqr: 0.021,
      vrmWindowCells: 3,
      vrmWindowGroundM: 6,
      vrmText: 'median 0.0340 [IQR 0.0210], 3×3-cell window (≈6 m), dimensionless',
      tpiRadiusCells: 5,
      tpiRadiusGroundM: 10,
      tpiDominantClass: 'open slope',
      tpiText: 'open slope, median 0.02 [IQR 0.11] m, 5-cell radius',
      zUnitLabel: 'm',
      slopeAspectConvention: 'Slope = rise/run tangent; aspect downslope, 0° = north.',
      confidence: 74,
      warnings: ['Ground return density is below 4 pts/m²; ruggedness is less reliable.'],
    },
    generationParams: {
      interpolation: 'geodesic',
      contourStyle: 'generalized',
      generalizeToleranceCells: 0.35,
      smoothing: true,
      despike: true,
      aggregation: 'median',
    },
    warnings: ['Removed 2 outlier ground cell(s) before building the surface.'],
  } as unknown as AnalyseContoursResult;
}

const OPTS = {
  basename: 'site-a',
  generatedAt: '2026-06-05T00:00:00.000Z',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.1',
  verticalUnitToMetres: 1,
  contourMethod: 'olv.contour.generalize@1',
  deliverablePurpose: 'survey-review',
} as const;

function readyProvenance(overrides: Record<string, unknown> = {}): ExportProvenance {
  return buildExportProvenance(readyResult(), { ...OPTS, ...overrides });
}

/** The permit an exploratory launch mints — the downgrade path. */
function exploratoryPermitStamp(): ExportPermitStamp {
  const permit = resolveContourExportPermit('geojson', {
    launchStatus: 'exploratory',
    verticalUnitsKnown: true,
    crsProjected: true,
    analyticalGeometry: true,
  });
  const stamp = permitStamp(permit);
  if (!stamp) throw new Error('fixture: the exploratory permit must grant a stamp');
  return stamp;
}

/** A one-feature contour model, enough to produce a real GeoJSON artifact. */
function contourModel(): ContourFeatureModel {
  return {
    intervalM: 1,
    crs: 'EPSG:32610',
    verticalDatum: 'EPSG:5703',
    coverageMode: 'full',
    contourStyle: 'generalized',
    interpolatedFraction: 0.05,
    warnings: [],
    features: [
      {
        value: 10,
        grade: 'measured',
        isIndex: true,
        meanConfidence: 82,
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
  } as unknown as ContourFeatureModel;
}

/** Three georeferenced points — enough for a real LAS header and body. */
function lasPoints(): GlobalPoints {
  return {
    count: 3,
    x: Float64Array.from([500000.123, 500001.5, 500002]),
    y: Float64Array.from([4100000, 4100000.25, 4100001]),
    z: Float64Array.from([12.34, 13, 14.5]),
  };
}

/** The GeoJSON a receiver actually holds: serialized, then parsed back. */
function geojsonArtifact(p: ExportProvenance): Record<string, unknown> {
  return JSON.parse(JSON.stringify(toGeoJSON(contourModel(), p))) as Record<string, unknown>;
}

function metadataOf(artifact: Record<string, unknown>): Record<string, unknown> {
  return artifact.metadata as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Completeness
// ---------------------------------------------------------------------------

describe('completeness — what the artifact declares on its own', () => {
  test('the GeoJSON a receiver holds names source, build, methods, parameters and limits', () => {
    const meta = metadataOf(geojsonArtifact(readyProvenance()));

    expect(meta.source).toBe('site-a');
    expect(meta.software).toBe('OpenLiDARViewer');
    expect(meta.softwareVersion).toBe('9.9.9');
    // The build line carries version AND commit, so two builds of one release
    // stay apart.
    expect(String(meta.build)).toMatch(/\S+/);
    expect(meta.generated).toBe('2026-06-05T00:00:00.000Z');
    expect(meta.horizontalCrs).toBe('EPSG:32610');
    expect(meta.verticalDatum).toBe('EPSG:5703');

    const record = meta.record as Record<string, unknown>;
    expect(record.kind).toBe('terrain-dtm');
    expect(record.contentHash).toMatch(/^[0-9a-f]{8}$/);
    expect(Array.isArray(record.methods)).toBe(true);
    for (const tag of record.methods as string[]) {
      const [id, version] = tag.split('@');
      expect(isMethodId(id), `${id} must be a registered method`).toBe(true);
      expect(Number(version)).toBe(METHOD_REGISTRY[id].version);
    }

    const manifest = meta.processingManifest as ProcessingManifest;
    expect(manifest.ops.length).toBeGreaterThan(0);
    expect(manifest.head).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyProcessingManifest(manifest).ok).toBe(true);

    // The limitation statement and the evidence level, not just the numbers.
    expect(String(meta.notSurveyGrade)).toMatch(/not survey-grade/i);
    expect(meta.evidence).toBe(EVIDENCE_GATE_NOTE);
  });

  test('the GeoJSON words the standing limitation exactly as every other artifact does', () => {
    // One claim, one string. The GeoJSON reader and the DXF/SVG/README reader
    // get the same sentence, from the same constant.
    const meta = metadataOf(geojsonArtifact(readyProvenance()));
    expect(meta.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(provenanceLines(readyProvenance()).join('\n')).toContain(NOT_SURVEY_GRADE_NOTE);
  });

  test('every op either binds parameters or says in words why it binds none', () => {
    const manifest = processingManifestFromProvenance(readyProvenance());
    for (const op of manifest.ops) {
      const bound = Object.keys(op.params).length > 0;
      expect(
        bound || (op.note ?? '').trim().length > 0,
        `${op.method} binds no parameters and offers no note`,
      ).toBe(true);
    }
  });

  test('the text stamp every non-JSON artifact carries answers the same questions', () => {
    const lines = provenanceLines(readyProvenance()).join('\n');
    for (const key of [
      'Software',
      'Build',
      'Generated',
      'Source',
      'Horizontal CRS',
      'Vertical datum',
      'Methods',
      'Record',
      'Manifest',
      'Note',
      'Evidence',
    ]) {
      expect(lines, `the stamp must carry a ${key} row`).toContain(key);
    }
  });

  test('every registered scientific product resolves an evidence decision, none silently exports', () => {
    for (const reg of SCIENTIFIC_EXPORTERS) {
      const decision = resolveExportDecision(reg.exporterId, {
        launchStatus: 'available',
        unitClaim: 'metric-supported',
      });
      expect(decision.status === 'blocked' || decision.caveats.length > 0).toBe(true);
    }
    expect(() =>
      resolveExportDecision('contour.unregistered', {
        launchStatus: 'available',
        unitClaim: 'metric-supported',
      }),
    ).toThrow(/not a registered scientific exporter/);
  });

  test('a LAS/LAZ export names the build that produced it, in 32 bytes', () => {
    // Read back through the real header parser, so this is what a receiver
    // holding the file gets — not what the writer meant to write.
    for (const bytes of [writeLas(lasPoints()), writeLas14(lasPoints())]) {
      const header = parseLasHeader(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      expect(header.systemIdentifier).toBe('OpenLiDARViewer');
      // Version at minimum; the commit too when it fits.
      expect(header.generatingSoftware).toContain('OpenLiDARViewer');
      expect(header.generatingSoftware).toContain(BUILD_IDENTITY.version);
      expect(header.generatingSoftware).toBe(lasGeneratingSoftware());

      // Exactly 32 bytes, and nothing truncated into a half-truth: whatever is
      // in the field is a whole field of the identity, never a prefix of one.
      const field = new Uint8Array(
        bytes.buffer,
        bytes.byteOffset + 58,
        32,
      );
      expect(field.length).toBe(32);
      expect(lasGeneratingSoftware().length).toBeLessThanOrEqual(32);
      for (const part of lasGeneratingSoftware().split(' ').slice(1)) {
        expect([BUILD_IDENTITY.version, BUILD_IDENTITY.commit, `${BUILD_IDENTITY.commit}+dirty`])
          .toContain(part);
      }
    }
  });

  test('a commit that cannot fit drops whole, leaving the product and version', () => {
    // Degrading has to stay honest: half a commit hash names a build that does
    // not exist. The composer drops the commit outright instead.
    expect(composeGeneratingSoftware({ version: '0.6.2', commit: 'a1b2c3d', dirty: false }))
      .toBe('OpenLiDARViewer 0.6.2 a1b2c3d');
    // 35 bytes with the marker. The commit leaves with it — keeping the hash
    // alone would assert a clean build of that commit, which is not what ran.
    expect('OpenLiDARViewer 0.6.2 a1b2c3d+dirty'.length).toBeGreaterThan(32);
    expect(composeGeneratingSoftware({ version: '0.6.2', commit: 'a1b2c3d', dirty: true }))
      .toBe('OpenLiDARViewer 0.6.2');
    // A long release string pushes the commit out entirely, never in part.
    const long = composeGeneratingSoftware({
      version: '0.6.2-rc.1234',
      commit: 'a1b2c3d',
      dirty: false,
    });
    expect(long).toBe('OpenLiDARViewer 0.6.2-rc.1234');
    expect(long.length).toBeLessThanOrEqual(32);
    // And a version that alone will not fit leaves the product name standing.
    const huge = composeGeneratingSoftware({
      version: '1.2.3-an-absurdly-long-prerelease',
      commit: 'a1b2c3d',
      dirty: false,
    });
    expect(huge).toBe('OpenLiDARViewer');
    // An unresolved commit is never fabricated into the field.
    expect(composeGeneratingSoftware({ version: '0.6.2', commit: 'unknown', dirty: false }))
      .toBe('OpenLiDARViewer 0.6.2');
  });
});

// ---------------------------------------------------------------------------
// 2. Accuracy — declared parameters vs the parameters actually used
// ---------------------------------------------------------------------------

describe('accuracy — the declared parameters are the parameters that ran', () => {
  test('the contour op binds the tolerance the geometry was actually simplified at', () => {
    const result = readyResult();
    const p = buildExportProvenance(result, OPTS);
    const contourOp = processingManifestFromProvenance(p).ops.at(-1);
    expect(contourOp?.method).toBe('olv.contour.generalize@1');
    expect(contourOp?.params.generalizeToleranceCells).toBe(
      (result.generationParams as unknown as { generalizeToleranceCells: number })
        .generalizeToleranceCells,
    );

    // Move the tolerance the run used; the manifest must move with it. A
    // manifest that reads the same for two different geometries is the drift
    // this check exists for.
    const other = readyResult();
    (other.generationParams as unknown as { generalizeToleranceCells: number })
      .generalizeToleranceCells = 0.9;
    const otherOp = processingManifestFromProvenance(buildExportProvenance(other, OPTS)).ops.at(-1);
    expect(otherOp?.params.generalizeToleranceCells).toBe(0.9);
    expect(otherOp?.hash).not.toBe(contourOp?.hash);
  });

  test('the surface and metric ops bind the coverage, window and radius the run used', () => {
    const result = readyResult();
    const ops = processingManifestFromProvenance(buildExportProvenance(result, OPTS)).ops;
    const byMethod = (needle: string) => ops.find((o) => o.method.startsWith(needle));

    expect(byMethod('olv.dtm.idw-fill')?.params.coverageMode).toBe(result.dtm!.coverageMode);
    const cx = result.complexity as unknown as Record<string, number>;
    expect(byMethod('olv.terrain.vrm')?.params.windowCells).toBe(cx.vrmWindowCells);
    expect(byMethod('olv.terrain.vrm')?.params.windowGroundM).toBe(cx.vrmWindowGroundM);
    expect(byMethod('olv.terrain.tpi')?.params.radiusCells).toBe(cx.tpiRadiusCells);
    expect(byMethod('olv.terrain.tpi')?.params.radiusGroundM).toBe(cx.tpiRadiusGroundM);
  });

  test('an op is only listed when its method actually ran', () => {
    const bare = readyResult();
    delete (bare as unknown as Record<string, unknown>).complexity;
    delete (bare as unknown as Record<string, unknown>).accuracyStandards;
    const methods = processingManifestFromProvenance(buildExportProvenance(bare, OPTS)).ops.map(
      (o) => o.method,
    );
    expect(methods.some((m) => m.startsWith('olv.terrain.vrm'))).toBe(false);
    expect(methods.some((m) => m.startsWith('olv.validation.holdout-rmse'))).toBe(false);
    expect(methods.some((m) => m.startsWith('olv.dtm.idw-fill'))).toBe(true);
  });

  test('a method tag never claims a version the registry does not carry', () => {
    const record = analysisRecordFromProvenance(readyProvenance());
    for (const ref of record.methods) {
      expect(METHOD_REGISTRY[ref.id]?.version).toBe(ref.version);
    }
  });

  test('GAP (pinned): the contour interval op binds `intervalM` whatever the vertical unit is', () => {
    // The interval is in the SOURCE vertical unit — the text stamp says so
    // ("1 ft"), and the top-level provenance carries `contourIntervalUnit`. The
    // manifest op does not: its key is `intervalM` and it binds no unit, so an
    // op read on its own reads a foot interval as metres.
    const foot = readyProvenance({ verticalUnitToMetres: 0.3048 });
    expect(foot.contourIntervalUnit).toBe('ft');
    expect(provenanceLines(foot).join('\n')).toMatch(/Contour interval\s+1 ft\b/);

    const op = processingManifestFromProvenance(foot).ops.at(-1)!;
    expect(op.params.intervalM).toBe(1);
    expect(Object.keys(op.params)).not.toContain('intervalUnit');
    // The metre run and the foot run bind identical parameters, so the op alone
    // cannot tell the two intervals apart.
    const metreOp = processingManifestFromProvenance(readyProvenance()).ops.at(-1)!;
    expect(op.params).toEqual(metreOp.params);
  });

  test('GAP (pinned): the top-level provenance block omits the generalization tolerance', () => {
    // A receiver re-deriving the contour op from the artifact's own top-level
    // fields cannot recover this one: it exists only inside the op it would be
    // checking.
    const json = provenanceJson(readyProvenance());
    expect(json.contourGeneralizeToleranceCells).toBeUndefined();
    expect(provenanceLines(readyProvenance()).join('\n')).not.toContain('0.35');
    const op = processingManifestFromProvenance(readyProvenance()).ops.at(-1)!;
    expect(op.params.generalizeToleranceCells).toBe(0.35);
  });
});

// ---------------------------------------------------------------------------
// 3. Tamper evidence — both directions
// ---------------------------------------------------------------------------

/** Re-chain a manifest over tampered contents: the attacker who does the work. */
function rechain(manifest: ProcessingManifest): ProcessingManifest {
  return buildProcessingManifest({
    build: manifest.build,
    source: manifest.source,
    ops: manifest.ops.map((op) => ({
      method: op.method,
      params: op.params,
      ...(op.note !== undefined ? { note: op.note } : {}),
    })),
  });
}

describe('tamper evidence — the artifact and the account describing it', () => {
  test('an edited parameter with the chain left alone is caught, and names the op', () => {
    const artifact = geojsonArtifact(readyProvenance());
    const manifest = metadataOf(artifact).processingManifest as ProcessingManifest;
    const clean = verifyProcessingManifest(manifest);
    expect(clean.ok).toBe(true);

    const tampered = JSON.parse(JSON.stringify(manifest)) as ProcessingManifest;
    const target = tampered.ops.findIndex((o) => 'coverageMode' in o.params);
    (tampered.ops[target].params as Record<string, unknown>).coverageMode = 'full';
    (tampered.ops[target].params as Record<string, unknown>).cellSizeM = 0.5;

    const verdict = verifyProcessingManifest(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.firstInvalid).toBe(target);
  });

  test('an edited envelope — a different build or source — breaks the chain at op 0', () => {
    const manifest = processingManifestFromProvenance(readyProvenance());
    for (const field of ['build', 'source'] as const) {
      const forged = { ...manifest, [field]: 'somebody-elses-scan' };
      const verdict = verifyProcessingManifest(forged);
      expect(verdict.ok, `an edited ${field} must not verify`).toBe(false);
      expect(verdict.firstInvalid).toBe(0);
    }
  });

  test('a truncated or reordered chain is caught', () => {
    const manifest = processingManifestFromProvenance(readyProvenance());
    const truncated = { ...manifest, ops: manifest.ops.slice(0, -1) };
    expect(verifyProcessingManifest(truncated).ok).toBe(false);

    const reordered = {
      ...manifest,
      ops: [manifest.ops[1], manifest.ops[0], ...manifest.ops.slice(2)],
    };
    expect(verifyProcessingManifest(reordered).ok).toBe(false);
  });

  test('the strong case: a re-chained manifest self-verifies, and re-derivation catches it', () => {
    const p = readyProvenance();
    const artifact = geojsonArtifact(p);
    const published = metadataOf(artifact).processingManifest as ProcessingManifest;

    // The attacker edits an op AND recomputes every hash and the head.
    const doctored = JSON.parse(JSON.stringify(published)) as ProcessingManifest;
    const target = doctored.ops.findIndex((o) => o.method.startsWith('olv.terrain.vrm'));
    (doctored.ops[target].params as Record<string, unknown>).windowCells = 9;
    const forged = rechain(doctored);

    // The chain alone cannot see it — an unkeyed hash chain never can. PINNED,
    // so nobody reads "verifiable" as "unforgeable".
    expect(verifyProcessingManifest(forged).ok).toBe(true);
    expect(forged.head).not.toBe(published.head);

    // Re-derivation from what the artifact independently declares does see it:
    // the VRM window is published in the top-level complexity block too, and a
    // manifest rebuilt from that block does not reproduce the forged head.
    const rederived = processingManifestFromProvenance(p);
    expect(rederived.head).toBe(published.head);
    expect(rederived.head).not.toBe(forged.head);
    const forgedOp = forged.ops[target];
    const trueOp = rederived.ops[target];
    expect(forgedOp.params.windowCells).not.toBe(trueOp.params.windowCells);
    expect(
      (metadataOf(artifact).complexity as Record<string, unknown>).vrmWindowCells,
    ).toBe(trueOp.params.windowCells);
  });

  test('re-derivation is deterministic — the same run rebuilds the identical head', () => {
    const a = processingManifestFromProvenance(readyProvenance());
    const b = processingManifestFromProvenance(readyProvenance());
    expect(a.head).toBe(b.head);
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  test('the record fingerprint moves when the science moves and holds when only time does', () => {
    const base = analysisRecordFromProvenance(readyProvenance());
    const later = analysisRecordFromProvenance(
      readyProvenance({ generatedAt: '2027-01-01T00:00:00.000Z' }),
    );
    expect(later.contentHash).toBe(base.contentHash);

    const worse = readyResult();
    (worse.accuracyStandards as unknown as { rmseZM: number }).rmseZM = 0.99;
    const moved = analysisRecordFromProvenance(buildExportProvenance(worse, OPTS));
    expect(moved.contentHash).not.toBe(base.contentHash);
  });

  test('an integrity report catches an altered figure whose digest was not refreshed', () => {
    const manifest = buildReportManifest({
      dataset: { id: 'site-a', crs: 'EPSG:32610', pointCount: 1000 },
      generatedAt: '2026-06-05T00:00:00.000Z',
      software: '9.9.9',
      findings: [{ label: 'Stockpile volume', value: 1234.5, unit: 'm³', sigma: 12, caveats: ['Not survey-grade.'] }],
    });
    const clean = verifyReportFile(JSON.stringify(manifest));
    expect(clean.valid).toBe(true);
    expect(clean.cryptographic).toBe(true);

    const edited = JSON.parse(JSON.stringify(manifest));
    edited.findings[0].value = 9999;
    const verdict = verifyReportFile(JSON.stringify(edited));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/modified|does not match/);
  });

  test('an integrity report drops a caveat and the digest notices', () => {
    const manifest = buildReportManifest({
      dataset: { id: 'site-a' },
      generatedAt: '2026-06-05T00:00:00.000Z',
      findings: [{ label: 'Volume', value: 10, unit: 'm³', caveats: ['Exploratory only.'] }],
    });
    const stripped = JSON.parse(JSON.stringify(manifest));
    delete stripped.findings[0].caveats;
    expect(verifyReportFile(JSON.stringify(stripped)).valid).toBe(false);
  });

  test('LIMIT (pinned): a report re-stamped with a fresh SHA-256 verifies — integrity, not identity', () => {
    const manifest = buildReportManifest({
      dataset: { id: 'site-a' },
      generatedAt: '2026-06-05T00:00:00.000Z',
      findings: [{ label: 'Volume', value: 10, unit: 'm³' }],
    });
    const forged = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    (forged.findings as { value: number }[])[0].value = 9999;
    delete forged.digest;
    forged.digest = sha256(canonicalize(forged));

    const verdict = verifyReportFile(JSON.stringify(forged));
    // No unkeyed digest can refuse this. What the verifier must NOT do is claim
    // more than it knows, so the wording is checked instead.
    expect(verdict.valid).toBe(true);
    expect(verdict.reason).toMatch(/intact/);
    expect(verdict.cryptographic).toBe(true);
  });

  test('a forgeable checksum is never reported as intact', () => {
    const manifest = buildReportManifest({
      dataset: { id: 'site-a' },
      generatedAt: '2026-06-05T00:00:00.000Z',
      findings: [{ label: 'Volume', value: 10, unit: 'm³' }],
    });
    const legacy = { ...manifest, digestAlgorithm: 'FNV-1a-32' } as Record<string, unknown>;
    delete legacy.digest;
    legacy.digest = fnv1a(canonicalize(legacy));
    const verdict = verifyReportFile(JSON.stringify(legacy));
    expect(verdict.valid).toBe(true);
    expect(verdict.cryptographic).toBe(false);
    expect(verdict.reason).toMatch(/does NOT prove|forge/);
  });
});

// ---------------------------------------------------------------------------
// 4. No self-blindness — the verifier over the files it emits
// ---------------------------------------------------------------------------

const TERRAIN = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', holdoutSeed: 1 };

const TINY_REPRO: ReproducibilityConfig = {
  suiteId: 'reproducibility',
  seed: 4242,
  pointCount: 25_000,
  warmupRuns: 3,
  recordedRuns: 5,
  terrain: TERRAIN,
  scalarTolerance: 0,
};

describe('no self-blindness — the verifier over its own publication files', () => {
  let repro: ReturnType<typeof runReproducibilitySuite>;

  beforeAll(() => {
    repro = runReproducibilitySuite(TINY_REPRO);
  }, 300_000);

  function publish(): { root: string; latest: string } {
    const root = mkdtempSync(join(tmpdir(), 'olv-prov-'));
    const outcome = writeResults({
      command: 'test',
      startedAtUtc: '2026-07-26T09:30:00.000Z',
      completedAtUtc: '2026-07-26T09:31:00.000Z',
      reproducibility: repro,
      scaling: null,
      resultsDir: root,
      forcedGcRequested: false,
    });
    return { root, latest: outcome.latestDir };
  }

  /** Refresh one manifest entry's digest — the attacker who does the work. */
  function rehash(latest: string, relPath: string, contents: string): void {
    const manifestPath = join(latest, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const bytes = Buffer.from(contents, 'utf8');
    const entry = manifest.files.find((f: { path: string }) => f.path === relPath);
    if (!entry) throw new Error(`rehash: ${relPath} is not listed`);
    entry.sha256 = nodeSha256Hex(new Uint8Array(bytes));
    entry.bytes = bytes.byteLength;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  function delist(latest: string, relPath: string): void {
    const manifestPath = join(latest, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files = manifest.files.filter((f: { path: string }) => f.path !== relPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  test('a freshly published tree verifies', () => {
    const { latest } = publish();
    expect(verifyResultsDir(latest).problems).toEqual([]);
  });

  test('every file the writer emits is listed in the manifest it writes', () => {
    const { latest } = publish();
    const manifest = JSON.parse(readFileSync(join(latest, 'manifest.json'), 'utf8')) as {
      files: { path: string }[];
    };
    const listed = new Set(manifest.files.map((f) => f.path));
    for (const rel of walk(latest)) {
      if (rel === 'manifest.json') continue;
      expect(listed.has(rel), `${rel} is emitted but not listed in manifest.files`).toBe(true);
    }
  });

  test('an emitted file dropped from the listing is still caught', () => {
    const { latest } = publish();
    const rel = 'reproducibility/artifacts/scientific-record-content.json';
    writeFileSync(join(latest, rel), '{"kind":"not-what-ran"}\n', 'utf8');
    delist(latest, rel);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toContain(rel);
  });

  test('an edited artifact hash table with a refreshed digest is caught by re-derivation', () => {
    const { latest } = publish();
    const rel = 'reproducibility/artifacts/science-hashes.json';
    const path = join(latest, rel);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      reference: Record<string, string>;
      perRun: { science: Record<string, string> }[];
    };
    const key = Object.keys(doc.reference)[0];
    doc.reference[key] = 'f'.repeat(64);
    const contents = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileSync(path, contents, 'utf8');
    rehash(latest, rel, contents);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toContain(rel);
  });

  test('a file added to the tree that no manifest entry covers is caught', () => {
    const { latest } = publish();
    writeFileSync(join(latest, 'reproducibility', 'extra-summary.md'), '# 99.9 ms\n', 'utf8');
    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toContain('extra-summary.md');
  });
});

/** Every file under `root`, as POSIX-relative paths. */
function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Collision resistance in identity keys
// ---------------------------------------------------------------------------

describe('collision resistance — two artifacts must never compose to one key', () => {
  test('canonicalisation separates keys from values that look like separators', () => {
    const a = canonicalHash({ a: '1,"b":2', b: 3 });
    const b = canonicalHash({ a: 1, b: 2, c: 3 });
    expect(a).not.toBe(b);
    // Key order is not identity; content is.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  test('an unregistered method id is refused, including a prototype key', () => {
    // `METHOD_REGISTRY['__proto__']` and `['toString']` resolve on the
    // prototype chain, so a plain index lookup returns a truthy non-entry and
    // the reference silently degrades to `undefined@undefined` — two different
    // unknown ids composing to one method tag, and one record fingerprint.
    for (const key of ['__proto__', 'toString', 'constructor', 'valueOf']) {
      expect(isMethodId(key)).toBe(false);
      expect(method(key)).toBeNull();
      expect(() => methodRef(key), `methodRef(${key}) must refuse`).toThrow(/Unknown method id/);
    }
  });

  test('a benchmark artifact keyed `__proto__` keeps a distinct hash', () => {
    const a = toHashable(JSON.parse('{"__proto__":"alpha","n":1}'));
    const b = toHashable(JSON.parse('{"__proto__":"beta","n":1}'));
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);

    // Nested too — a grid whose only difference is a `__proto__` value.
    const c = toHashable(JSON.parse('{"grid":{"__proto__":"alpha","cell":1}}'));
    const d = toHashable(JSON.parse('{"grid":{"__proto__":"beta","cell":1}}'));
    expect(hashArtifact('metrics', c).hash).not.toBe(hashArtifact('metrics', d).hash);
  });

  test('two runs that differ only in a summary value fingerprint differently', () => {
    const a = analysisRecordFromProvenance(readyProvenance());
    const worse = readyResult();
    (worse.cellStatusTally as unknown as { measured: number }).measured = 10;
    const b = analysisRecordFromProvenance(buildExportProvenance(worse, OPTS));
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  test('GAP (pinned): the GeoJSON metadata merge tests key presence through the prototype chain', () => {
    // `if (!(k in metadata))` resolves inherited keys, so a provenance field
    // named `constructor` or `toString` would be treated as already present and
    // dropped from the file. No such field exists today; the probe pins that.
    const meta: Record<string, unknown> = {};
    expect('constructor' in meta).toBe(true);
    const emitted = Object.keys(provenanceJson(readyProvenance()));
    for (const key of emitted) {
      expect(key in {}, `a provenance field named ${key} would be swallowed by the merge`).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Limitation propagation
// ---------------------------------------------------------------------------

describe('limitation propagation — a downgraded product says so in the file', () => {
  test('an exploratory permit carries its watermark and every reason into the artifact', () => {
    const stamp = exploratoryPermitStamp();
    expect(stamp.status).toBe('exploratory');
    expect(stamp.watermark).toBe('EXPLORATORY');
    expect(stamp.caveats.length).toBeGreaterThan(1);

    const p = readyProvenance({ exportPermit: stamp });
    const meta = metadataOf(geojsonArtifact(p));
    const permit = meta.exportPermit as Record<string, unknown>;
    expect(permit.status).toBe('exploratory');
    expect(permit.watermark).toBe('EXPLORATORY');
    expect(permit.caveats).toEqual([...stamp.caveats]);

    const lines = provenanceLines(p).join('\n');
    expect(lines).toContain('Export permit');
    expect(lines).toContain('EXPLORATORY');
  });

  test('a blocked export mints no stamp, so no file can carry a permit it was refused', () => {
    const refused = resolveContourExportPermit('geojson', {
      launchStatus: 'not-analyzed',
      verticalUnitsKnown: true,
      crsProjected: true,
      analyticalGeometry: true,
    });
    expect(refused.ok).toBe(false);
    expect(permitStamp(refused)).toBeNull();
  });

  test('an ungated export still carries the standing limitation and evidence level', () => {
    const meta = metadataOf(geojsonArtifact(readyProvenance()));
    expect(meta.exportPermit).toBeNull();
    expect(String(meta.notSurveyGrade)).toMatch(/not survey-grade/i);
    expect(meta.evidence).toBe(EVIDENCE_GATE_NOTE);
    expect((meta.record as Record<string, unknown>).evidenceExploratory).toBe(true);
  });

  test('an unknown CRS is declared as unknown, never filled in', () => {
    const bare = readyResult();
    const dtm = bare.dtm as unknown as Record<string, unknown>;
    dtm.crs = null;
    dtm.verticalDatum = null;
    (bare.model as unknown as Record<string, unknown>).crs = null;
    (bare.model as unknown as Record<string, unknown>).verticalDatum = null;
    const p = buildExportProvenance(bare, OPTS);
    expect(p.horizontalCrs).toBe('not georeferenced');
    expect(p.crsKnown).toBe(false);
    expect(p.verticalDatum).toBe('unknown');
    const record = analysisRecordFromProvenance(p);
    expect(record.crs.horizontalKnown).toBe(false);
    // The record never fabricates a linear unit it did not receive.
    expect(record.crs.linearUnit).toBeUndefined();
  });

  test('the derived complexity caveats survive into the file', () => {
    const meta = metadataOf(geojsonArtifact(readyProvenance()));
    const complexity = meta.complexity as Record<string, unknown>;
    expect(complexity.caveats).toEqual(
      (readyResult().complexity as unknown as { warnings: string[] }).warnings,
    );
  });

  test('the GeoJSON carries every warning the run produced, model and provenance alike', () => {
    // No warning present in the provenance may be absent from the file. The
    // model's own warnings come first, in model order; the provenance warnings
    // the model did not already state follow, in provenance order. Stable,
    // because these artifacts are hashed.
    const p = readyProvenance();
    expect(p.warnings).toEqual(readyResult().warnings);
    expect(provenanceJson(p).warnings).toEqual(readyResult().warnings);

    const meta = metadataOf(geojsonArtifact(p));
    expect(meta.warnings).toEqual(readyResult().warnings);
    for (const w of p.warnings) expect(meta.warnings).toContain(w);
  });

  test('the GeoJSON warning list is the de-duplicated union in a stable order', () => {
    const model = contourModel() as unknown as { warnings: string[] };
    model.warnings = ['Model-only caveat.', 'Shared caveat.'];
    const p = readyProvenance();
    (p as unknown as { warnings: string[] }).warnings = [
      'Shared caveat.',
      'Provenance-only caveat.',
    ];

    const meta = metadataOf(
      JSON.parse(
        JSON.stringify(toGeoJSON(model as unknown as ContourFeatureModel, p)),
      ) as Record<string, unknown>,
    );
    expect(meta.warnings).toEqual([
      'Model-only caveat.',
      'Shared caveat.',
      'Provenance-only caveat.',
    ]);
  });
});
