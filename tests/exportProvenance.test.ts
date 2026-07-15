/**
 * exportProvenance.test.ts
 *
 * The single provenance object every export stamps. Verifies the builder
 * derives the right fields from an analysis result (CRS known vs unknown,
 * export-ready vs preview, accuracy present vs null, style / interval, software
 * + metric version), that honesty is preserved (no fabrication, always carries
 * the export-readiness verdict + not-survey-grade note), and that the two
 * formatters agree verbatim.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildExportProvenance,
  processingManifestFromProvenance,
  provenanceLines,
  provenanceJson,
  NOT_SURVEY_GRADE_NOTE,
  SOFTWARE_NAME,
  type ExportProvenance,
} from '../src/terrain/export/exportProvenance';
import { verifyProcessingManifest } from '../src/science/processingManifest';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

/** A complete, full-coverage, export-ready analysis result with everything known. */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      coverageMode: 'full',
      meanConfidence: 82,
    },
    intervalM: 1,
    model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode: 'full' },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: ['Removed 2 outlier ground cell(s) before building the surface.'],
  } as unknown as AnalyseContoursResult;
}

const OPTS = { basename: 'site', generatedAt: '2026-06-05T00:00:00.000Z', softwareVersion: '9.9.9', metricVersion: 'v0.4.1', verticalUnitToMetres: 1 } as const;

it('labels the contour interval in the resolved vertical unit, never a hard-coded metre', () => {
  const metre = provenanceLines(buildExportProvenance(readyResult(), OPTS)).join('\n');
  expect(metre).toMatch(/Contour interval\s+1 m\b/);
  const foot = provenanceLines(buildExportProvenance(readyResult(), { ...OPTS, verticalUnitToMetres: 0.3048 })).join('\n');
  expect(foot).toMatch(/Contour interval\s+1 ft\b/);
  const unknown = provenanceLines(buildExportProvenance(readyResult(), { basename: 'site', softwareVersion: '9.9.9', metricVersion: 'v0.4.1' })).join('\n');
  expect(unknown).toMatch(/Contour interval\s+1 \(vertical unit unverified\)/);
});

describe('buildExportProvenance — field derivation', () => {
  it('derives software + version + metric version + date + source', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.software).toBe(SOFTWARE_NAME);
    expect(p.softwareVersion).toBe('9.9.9');
    expect(p.metricVersion).toBe('v0.4.1');
    expect(p.generated).toBe('2026-06-05T00:00:00.000Z');
    expect(p.source).toBe('site');
  });

  it('stamps the Contour Studio method + purpose when supplied, and carries them into the file JSON', () => {
    const p = buildExportProvenance(readyResult(), {
      ...OPTS,
      contourMethod: 'olv.contour.analytical@1',
      deliverablePurpose: 'survey-review',
    });
    expect(p.contourMethod).toBe('olv.contour.analytical@1');
    expect(p.deliverablePurpose).toBe('survey-review');
    // The serialized provenance the writers embed must carry them too.
    const json = provenanceJson(p) as Record<string, unknown>;
    expect(json.contourMethod).toBe('olv.contour.analytical@1');
    expect(json.deliverablePurpose).toBe('survey-review');
  });

  it('leaves the Contour Studio method + purpose null when not supplied (non-Studio exports)', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.contourMethod).toBeNull();
    expect(p.deliverablePurpose).toBeNull();
  });

  it('reports a known CRS + datum and the ready verdict honestly', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.horizontalCrs).toBe('EPSG:32610');
    expect(p.crsKnown).toBe(true);
    expect(p.verticalDatum).toBe('EPSG:5703');
    expect(p.datumKnown).toBe(true);
    expect(p.surfaceQuality).toBe('Good');
    expect(p.exportReadiness).toBe('Ready');
    expect(p.exportReason).toBe('');
  });

  it('reports style, interval and coverage from the run', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.contourStyle).toBe('smooth');
    expect(p.contourStyleLabel).toBe('Smooth');
    expect(p.contourIntervalM).toBe(1);
    expect(p.coverageMode).toBe('full');
  });

  it('carries the accuracy block when present', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.accuracy).not.toBeNull();
    expect(p.accuracy?.rmseZM).toBeCloseTo(0.14);
    expect(p.accuracy?.usgsQualityLevel).toBe('QL2');
    expect(p.pointDensityPerM2).toBeCloseTo(4.2);
  });

  it('always carries the not-survey-grade note', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(p.notSurveyGrade).toMatch(/not survey-grade/i);
    // v0.4.5 wording — plain "Suitability" language; the "Fitness-for-use"
    // QA jargon confused users and must never come back.
    expect(p.notSurveyGrade).toMatch(/^Suitability:/);
    expect(p.notSurveyGrade).not.toMatch(/fitness/i);
  });

  it('says "not georeferenced" / "unknown" for missing CRS + datum (no fabrication)', () => {
    const base = readyResult() as unknown as { dtm: Record<string, unknown>; model: Record<string, unknown>; quality: Record<string, unknown> };
    const noGeoref = {
      ...(base as unknown as AnalyseContoursResult),
      dtm: { ...base.dtm, crs: null, verticalDatum: null },
      model: { ...base.model, crs: null, verticalDatum: null },
      quality: { ...base.quality, crsKnown: false, datumKnown: false, exportReadiness: 'previewOnly' },
    } as unknown as AnalyseContoursResult;
    const p = buildExportProvenance(noGeoref, OPTS);
    expect(p.horizontalCrs).toBe('not georeferenced');
    expect(p.crsKnown).toBe(false);
    expect(p.verticalDatum).toBe('unknown');
    expect(p.datumKnown).toBe(false);
    // Unknown CRS/datum caps export readiness to Preview with a naming reason.
    expect(p.exportReadiness).toBe('Preview');
    expect(p.exportReason).toMatch(/unknown/i);
  });

  it('null accuracy when the run measured no RMSEz', () => {
    const base = readyResult() as unknown as { accuracyStandards: Record<string, unknown> };
    const noAcc = {
      ...(base as unknown as AnalyseContoursResult),
      accuracyStandards: { rmseZM: null, nvaM: null, vvaM: null, pointDensityPerM2: 0, qualityLevel: 'unknown', qualityLevelReason: 'x' },
    } as unknown as AnalyseContoursResult;
    const p = buildExportProvenance(noAcc, OPTS);
    expect(p.accuracy).toBeNull();
    expect(p.pointDensityPerM2).toBeNull();
  });

  it('says contourStyle null + "none" interval when neither is present', () => {
    const base = readyResult() as unknown as Record<string, unknown>;
    delete base.generationParams;
    delete base.model;
    delete base.intervalM;
    const p = buildExportProvenance(base as unknown as AnalyseContoursResult, OPTS);
    expect(p.contourStyle).toBeNull();
    expect(p.contourStyleLabel).toBe('unknown');
    expect(p.contourIntervalM).toBeNull();
  });

  it('defaults software + metric version to "unknown" when not supplied', () => {
    const p = buildExportProvenance(readyResult());
    expect(p.softwareVersion).toBe('unknown');
    expect(p.metricVersion).toBe('unknown');
    expect(p.source).toBeNull();
  });
});

describe('provenanceLines / provenanceJson — shape + identical values', () => {
  const p: ExportProvenance = buildExportProvenance(readyResult(), OPTS);

  it('lines carry every meaningful field with consistent wording', () => {
    const text = provenanceLines(p).join('\n');
    expect(text).toMatch(/Software\s+OpenLiDARViewer 9\.9\.9/);
    expect(text).toMatch(/Metric version\s+v0\.4\.1/);
    expect(text).toMatch(/Generated\s+2026-06-05T00:00:00\.000Z/);
    expect(text).toMatch(/Horizontal CRS\s+EPSG:32610/);
    expect(text).toMatch(/Vertical datum\s+EPSG:5703/);
    expect(text).toMatch(/Coverage\s+full/);
    expect(text).toMatch(/Contour interval\s+1 m/);
    expect(text).toMatch(/Contour style\s+Smooth/);
    expect(text).toMatch(/Surface quality\s+Good/);
    expect(text).toMatch(/Export readiness\s+Ready/);
    // "(estimated)" is load-bearing: the QL's RMSEz leg is hold-out-based,
    // so the stamped grade must carry the same qualifier the panel chip does.
    expect(text).toMatch(/USGS 3DEP\s+QL2 \(estimated\)/);
    // "-style (hold-out)" is equally load-bearing: the stamp must not claim
    // an ASPRS checkpoint assessment for hold-out figures.
    expect(text).toMatch(/NVA-style \(95%, hold-out\)/);
    expect(text).toMatch(/VVA-style \(95th pct, hold-out\)/);
    expect(text).toMatch(/not survey-grade/i);
    // The evidence gate is stamped on the artifact: below required level today,
    // so every terrain export is marked exploratory.
    expect(text).toMatch(/Evidence\s+.*exploratory/i);
  });

  it('json mirrors the line values exactly', () => {
    const j = provenanceJson(p);
    expect(j.software).toBe(SOFTWARE_NAME);
    expect(j.softwareVersion).toBe('9.9.9');
    expect(j.metricVersion).toBe('v0.4.1');
    expect(j.horizontalCrs).toBe('EPSG:32610');
    expect(j.verticalDatum).toBe('EPSG:5703');
    expect(j.contourStyle).toBe('smooth');
    expect(j.contourStyleLabel).toBe('Smooth');
    expect(j.surfaceQuality).toBe('Good');
    expect(j.exportReadiness).toBe('Ready');
    expect((j.accuracy as { usgsQualityLevel: string }).usgsQualityLevel).toBe('QL2');
    expect(j.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(j.evidence).toMatch(/exploratory/i);
    expect(Array.isArray(j.warnings)).toBe(true);
    // The canonical ScientificAnalysisRecord is embedded in the ONE provenance
    // object every terrain exporter (GeoJSON / DXF / SVG / DEM README / PDF)
    // stamps — so it is present in every export's metadata, not just one path.
    const rec = j.record as { contentHash: string; methods: string[]; schemaVersion: number };
    expect(typeof rec.contentHash).toBe('string');
    expect(rec.contentHash.length).toBeGreaterThan(0);
    expect(Array.isArray(rec.methods)).toBe(true);
    expect(rec.methods).toContain('olv.ground.smrf@1');
    expect(rec.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('preview / unknown-CRS provenance shows the reason in the readiness line', () => {
    const base = readyResult() as unknown as { dtm: Record<string, unknown>; quality: Record<string, unknown> };
    const preview = {
      ...(base as unknown as AnalyseContoursResult),
      dtm: { ...base.dtm, crs: null },
      quality: { ...base.quality, crsKnown: false },
    } as unknown as AnalyseContoursResult;
    const pv = buildExportProvenance(preview, OPTS);
    const line = provenanceLines(pv).find((l) => l.startsWith('Export readiness'));
    expect(line).toMatch(/Preview\s+—\s+.*unknown/i);
  });
});

describe('provenanceLines — key/value separation', () => {
  it('every line keeps at least two spaces between key and value, even past the key column', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    for (const line of provenanceLines(p)) {
      // A key at or beyond the column width must still get a gutter — never
      // "NVA-style (95%, hold-out)0.27 m" jammed into one token.
      expect(line).toMatch(/^\S.*?\s{2,}\S/);
    }
  });

  it('the hold-out accuracy keys (wider than the column) separate from their values', () => {
    const lines = provenanceLines(buildExportProvenance(readyResult(), OPTS));
    expect(lines.find((l) => l.startsWith('NVA-style'))).toMatch(
      /^NVA-style \(95%, hold-out\)\s{2,}0\.27 m$/,
    );
    expect(lines.find((l) => l.startsWith('VVA-style'))).toMatch(
      /^VVA-style \(95th pct, hold-out\)\s{2,}0\.30 m$/,
    );
  });
});

describe('processingManifestFromProvenance — the verify-only manifest assembly', () => {
  /** readyResult() with the derived-complexity block the VRM/TPI ops bind from. */
  function complexResult(): AnalyseContoursResult {
    return {
      ...(readyResult() as unknown as Record<string, unknown>),
      complexity: {
        band: 'moderate',
        vrmMedian: 0.034, vrmIqr: 0.021, vrmWindowCells: 3, vrmWindowGroundM: 3.2,
        vrmText: 'median 0.0340 [IQR 0.0210], 3×3-cell window (≈3 m), dimensionless',
        tpiRadiusCells: 5, tpiRadiusGroundM: 5.5, tpiDominantClass: 'Flat',
        tpiText: 'Flat, median 0.1 [IQR 0.2] m, 5-cell radius',
        zUnitLabel: 'm', slopeAspectConvention: 'Horn 1981; aspect downslope from north',
        confidence: 80, warnings: [],
      },
    } as unknown as AnalyseContoursResult;
  }

  it('orders one op per method the run actually executed, in pipeline order', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    const m = processingManifestFromProvenance(p);
    expect(m.schemaVersion).toBe(1);
    expect(m.build).toBe(p.build);
    expect(m.source).toBe('site');
    // Accuracy present, complexity absent, no contour method supplied:
    // ground → grid → hold-out validation, and nothing fabricated beyond that.
    expect(m.ops.map((op) => op.method)).toEqual([
      'olv.ground.smrf@1',
      'olv.dtm.idw-fill@1',
      'olv.validation.holdout-rmse@2',
    ]);
    expect(m.ops.map((op) => op.seq)).toEqual([0, 1, 2]);
  });

  it('binds the params the provenance actually carries and verifies intact', () => {
    const p = buildExportProvenance(complexResult(), {
      ...OPTS,
      contourMethod: 'olv.contour.analytical@1',
    });
    const m = processingManifestFromProvenance(p);
    const byMethod = new Map(m.ops.map((op) => [op.method, op]));
    // Grid op binds the coverage scope the provenance holds.
    expect(byMethod.get('olv.dtm.idw-fill@1')?.params).toMatchObject({ coverageMode: 'full' });
    // Complexity ops bind their window/radius parameters from the run.
    expect(byMethod.get('olv.terrain.vrm@1')?.params).toEqual({ windowCells: 3, windowGroundM: 3.2 });
    expect(byMethod.get('olv.terrain.tpi@1')?.params).toEqual({ radiusCells: 5, radiusGroundM: 5.5, zUnit: 'm' });
    // The contour geometry op is appended last with the interval + style.
    const last = m.ops[m.ops.length - 1];
    expect(last.method).toBe('olv.contour.analytical@1');
    expect(last.params).toEqual({ intervalM: 1, style: 'smooth' });
    expect(verifyProcessingManifest(m)).toEqual({ ok: true });
  });

  it('honestly notes params the provenance does not carry instead of fabricating them', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    const m = processingManifestFromProvenance(p);
    const smrf = m.ops.find((op) => op.method === 'olv.ground.smrf@1');
    const holdout = m.ops.find((op) => op.method === 'olv.validation.holdout-rmse@2');
    expect(smrf?.params).toEqual({});
    expect(smrf?.note).toBe('params not captured in this slice');
    expect(holdout?.params).toEqual({});
    expect(holdout?.note).toBe('params not captured in this slice');
  });

  it('omits complexity ops and the contour op when the run produced neither', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    const m = processingManifestFromProvenance(p);
    const methods = m.ops.map((op) => op.method);
    expect(methods).not.toContain('olv.terrain.vrm@1');
    expect(methods).not.toContain('olv.terrain.tpi@1');
    expect(methods.some((id) => id.startsWith('olv.contour.'))).toBe(false);
  });

  it('is deterministic and survives the JSON round trip every export performs', () => {
    const p = buildExportProvenance(complexResult(), OPTS);
    const a = processingManifestFromProvenance(p);
    const b = processingManifestFromProvenance(p);
    expect(a).toEqual(b);
    const back = JSON.parse(JSON.stringify(a)) as typeof a;
    expect(verifyProcessingManifest(back)).toEqual({ ok: true });
    expect(back.head).toBe(a.head);
  });

  it('provenanceJson embeds the manifest beside the record, and it verifies', () => {
    const p = buildExportProvenance(complexResult(), OPTS);
    const j = provenanceJson(p);
    const m = j.processingManifest as import('../src/science/processingManifest').ProcessingManifest;
    expect(m.schemaVersion).toBe(1);
    expect(m.ops.length).toBeGreaterThan(0);
    expect(verifyProcessingManifest(JSON.parse(JSON.stringify(m)) as typeof m)).toEqual({ ok: true });
    // Beside the record, not replacing it.
    expect(j.record).toBeTruthy();
  });

  it('provenanceLines carries exactly ONE Manifest line with schema, head, count', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    const m = processingManifestFromProvenance(p);
    const manifestLines = provenanceLines(p).filter((l) => l.startsWith('Manifest'));
    expect(manifestLines).toHaveLength(1);
    expect(manifestLines[0]).toBe(
      `Manifest          schema 1 · ${m.head.slice(0, 12)} · 3 ops · verifiable`,
    );
  });

  it('never uses re-execution wording anywhere in the provenance module', () => {
    const src = readFileSync(
      new URL('../src/terrain/export/exportProvenance.ts', import.meta.url),
      'utf8',
    );
    expect(/replay/i.test(src)).toBe(false);
  });
});
