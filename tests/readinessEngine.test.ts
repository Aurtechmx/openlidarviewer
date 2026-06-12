/**
 * readinessEngine.test.ts — THE single source of the export-readiness verdict.
 *
 * Two contracts under test:
 *
 *   1. The verdict matrix itself — {@link deriveReadiness} turns
 *      {surfaceTier, surfaceReason, crsKnown, datumKnown} into the exact
 *      tier / reason / product-grade strings the four consumer views used to
 *      mint separately. Every expectation below is hand-computed from the
 *      documented rules (and byte-identical to the pre-convergence strings,
 *      which provenanceConsistency / terrainReportContent still pin
 *      downstream).
 *
 *   2. SINGLE-SOURCE: every consumer (terrainAssessment, recommendedWorkflows,
 *      terrainProducts, buildExportProvenance / provenanceLines,
 *      buildTerrainReportContent) is a VIEW over the engine's output — proven
 *      by swapping the engine's return value for a sentinel verdict and
 *      watching the sentinel surface verbatim in every view, and by mutating
 *      an assessment's engine-sourced fields and watching the downstream
 *      views move in lockstep (no consumer re-derives from the raw result).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveReadiness,
  productGradesFor,
  productReasonFor,
  statusWordFor,
  glyphFor,
  readinessLine,
  joinReasons,
  type ReadinessVerdict,
} from '../src/terrain/quality/readinessEngine';
import { terrainAssessment, type TerrainAssessment } from '../src/terrain/contour/terrainAssessment';
import { recommendedWorkflows } from '../src/terrain/contour/recommendedWorkflow';
import { terrainProducts } from '../src/terrain/contour/terrainProducts';
import {
  buildExportProvenance,
  provenanceLines,
} from '../src/terrain/export/exportProvenance';
import { buildTerrainReportContent } from '../src/terrain/export/terrainReportContent';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

// The engine module is wrapped so the single-source test can swap
// deriveReadiness for a sentinel; by default the wrapper passes through to
// the real implementation, so every other test in this file (and the src
// modules importing the engine) behaves exactly as in production.
vi.mock('../src/terrain/quality/readinessEngine', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/terrain/quality/readinessEngine')>();
  return { ...actual, deriveReadiness: vi.fn(actual.deriveReadiness) };
});
const actualEngine = await vi.importActual<
  typeof import('../src/terrain/quality/readinessEngine')
>('../src/terrain/quality/readinessEngine');

afterEach(() => {
  // Restore the pass-through after any sentinel test.
  vi.mocked(deriveReadiness).mockImplementation(actualEngine.deriveReadiness);
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * A complete, export-ready analysis result (same shape as the
 * provenanceConsistency fixture): 90/95 measured cells, all caps pass, CRS +
 * datum known ⇒ surface 'Good', export 'Ready', reason ''.
 */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      z: new Float32Array([10, 20, 30, 40]),
      coverage: new Uint8Array([2, 2, 1, 0]),
      cols: 2, rows: 2, cellSizeM: 1,
      originH1: 0, originH2: 0,
      crs: 'EPSG:32610', verticalDatum: 'EPSG:5703',
      coverageMode: 'full', meanConfidence: 82,
      sourcePointCount: 1_200_000, analyzedPointCount: 900_000,
    },
    intervalM: 1,
    model: {
      crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1,
      contourStyle: 'smooth', coverageMode: 'full', features: [{}, {}],
    },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full',
      reasons: [], exportReasons: [],
      interpolatedCellRatio: 0.06, emptyCellRatio: 0.05, edgeRiskRatio: 0.02,
      meanCellConfidence: 82, groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    excludedByClassification: 1200,
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

/** The same run with no vertical datum — the classic georef-gapped scan. */
function noDatumResult(): AnalyseContoursResult {
  const base = readyResult() as unknown as {
    dtm: Record<string, unknown>;
    model: Record<string, unknown>;
    quality: Record<string, unknown>;
  };
  return {
    ...(base as unknown as AnalyseContoursResult),
    dtm: { ...base.dtm, verticalDatum: null },
    model: { ...base.model, verticalDatum: null },
    quality: { ...base.quality, datumKnown: false, exportReadiness: 'previewOnly' },
  } as unknown as AnalyseContoursResult;
}

const OPTS = {
  basename: 'site',
  generatedAt: '2026-06-10T00:00:00.000Z',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.1',
} as const;

/** The value of one `Key  Value` provenance line. */
function kvValue(lines: readonly string[], key: string): string {
  const hit = lines.find((l) => l.startsWith(key));
  return hit ? hit.slice(18).trim() : '(missing)';
}

// ── 1. the verdict matrix (hand-computed) ────────────────────────────────────

describe('deriveReadiness — tier + reason matrix', () => {
  it('Good surface + CRS + datum known ⇒ Ready with an empty reason', () => {
    const v = deriveReadiness({
      surfaceTier: 'Good', surfaceReason: 'fine', crsKnown: true, datumKnown: true,
    });
    expect(v.tier).toBe('Ready');
    expect(v.reason).toBe('');
  });

  it('Good surface, datum unknown ⇒ Preview naming exactly the gap', () => {
    const v = deriveReadiness({
      surfaceTier: 'Good', surfaceReason: 'fine', crsKnown: true, datumKnown: false,
    });
    expect(v.tier).toBe('Preview');
    expect(v.reason).toBe('vertical datum unknown');
  });

  it('Good surface, both gaps ⇒ Preview joining the gaps with "and"', () => {
    const v = deriveReadiness({
      surfaceTier: 'Good', surfaceReason: 'fine', crsKnown: false, datumKnown: false,
    });
    expect(v.reason).toBe('CRS unknown and vertical datum unknown');
  });

  it('sub-Good surface, fully georeferenced ⇒ Preview blaming the surface', () => {
    for (const surfaceTier of ['Preview', 'Limited'] as const) {
      const v = deriveReadiness({
        surfaceTier, surfaceReason: 'capped', crsKnown: true, datumKnown: true,
      });
      expect(v.tier).toBe('Preview');
      expect(v.reason).toBe(
        'surface quality is below export grade — validate before hand-off',
      );
    }
  });

  it('sub-Good surface AND a georef gap ⇒ one sentence naming both', () => {
    const v = deriveReadiness({
      surfaceTier: 'Limited', surfaceReason: 'capped', crsKnown: false, datumKnown: true,
    });
    expect(v.reason).toBe(
      'surface quality is below export grade; CRS unknown — validate before hand-off',
    );
    const both = deriveReadiness({
      surfaceTier: 'Preview', surfaceReason: 'capped', crsKnown: false, datumKnown: false,
    });
    expect(both.reason).toBe(
      'surface quality is below export grade; CRS unknown and vertical datum unknown — validate before hand-off',
    );
  });

  it('Blocked surface ⇒ Blocked, quoting the surface reason verbatim', () => {
    const v = deriveReadiness({
      surfaceTier: 'Blocked',
      surfaceReason: 'No usable bare-earth surface — too little measured ground to contour.',
      crsKnown: true,
      datumKnown: true,
    });
    expect(v.tier).toBe('Blocked');
    expect(v.reason).toBe(
      'No usable bare-earth surface — too little measured ground to contour.',
    );
  });
});

describe('deriveReadiness / productGradesFor — product grades', () => {
  it('Ready ⇒ both classes good, no notes', () => {
    const g = productGradesFor('Good', 'Ready');
    expect(g.inspection).toEqual({ status: 'good', statusWord: 'Ready', glyph: '✓' });
    expect(g.deliverable).toEqual({ status: 'good', statusWord: 'Ready', glyph: '✓' });
  });

  it('Good surface held at Preview ⇒ deliverables caution: "georeferencing incomplete"', () => {
    const g = productGradesFor('Good', 'Preview');
    expect(g.inspection.status).toBe('good');
    expect(g.deliverable.status).toBe('caution');
    expect(g.deliverable.note).toBe('georeferencing incomplete');
  });

  it('sub-Good surface at Preview ⇒ deliverables caution: preview-only note', () => {
    for (const surfaceTier of ['Preview', 'Limited'] as const) {
      const g = productGradesFor(surfaceTier, 'Preview');
      expect(g.deliverable.note).toBe('preview only — additional validation recommended');
    }
  });

  it('inspection grades off the surface tier: Preview good, Limited caution, Blocked blocked', () => {
    expect(productGradesFor('Preview', 'Preview').inspection.status).toBe('good');
    expect(productGradesFor('Limited', 'Preview').inspection.status).toBe('caution');
    expect(productGradesFor('Blocked', 'Blocked').inspection.status).toBe('blocked');
  });

  it('Blocked ⇒ deliverables blocked with the gate note', () => {
    const g = productGradesFor('Blocked', 'Blocked');
    expect(g.deliverable.status).toBe('blocked');
    expect(g.deliverable.note).toBe('quality gate stopped this surface');
  });

  it('deriveReadiness folds the SAME grading table into its verdict', () => {
    const v = deriveReadiness({
      surfaceTier: 'Good', surfaceReason: 'fine', crsKnown: true, datumKnown: false,
    });
    expect(v.productGrades).toEqual(productGradesFor('Good', v.tier));
  });
});

describe('productReasonFor — the per-product reason selection matrix', () => {
  const SURFACE = 'Insufficient quality for reliable terrain products — 72% of the surface is interpolated.';
  const EXPORT_GEOREF = 'CRS unknown and vertical datum unknown';
  const EXPORT_SUBGOOD = 'surface quality is below export grade — validate before hand-off';

  it('good rows carry NO reason, in either class', () => {
    for (const productClass of ['inspection', 'deliverable'] as const) {
      expect(
        productReasonFor({
          status: 'good', productClass, surfaceTier: 'Good',
          surfaceReason: 'fine', exportReason: '',
        }),
      ).toBeUndefined();
    }
  });

  it('inspection caution/blocked → the figure-quoting surface reason', () => {
    expect(
      productReasonFor({
        status: 'caution', productClass: 'inspection', surfaceTier: 'Limited',
        surfaceReason: SURFACE, exportReason: EXPORT_SUBGOOD,
      }),
    ).toBe(SURFACE);
    expect(
      productReasonFor({
        status: 'blocked', productClass: 'inspection', surfaceTier: 'Blocked',
        surfaceReason: 'No usable bare-earth surface — too little measured ground to contour.',
        exportReason: 'No usable bare-earth surface — too little measured ground to contour.',
      }),
    ).toBe('No usable bare-earth surface — too little measured ground to contour.');
  });

  it('deliverable caution on a Good surface → the export reason naming the exact georef gap', () => {
    expect(
      productReasonFor({
        status: 'caution', productClass: 'deliverable', surfaceTier: 'Good',
        surfaceReason: '100% measured ground — the surface passes the quality gate.',
        exportReason: EXPORT_GEOREF, note: 'georeferencing incomplete',
      }),
    ).toBe(EXPORT_GEOREF);
  });

  it('deliverable caution on a sub-Good surface → the figure-quoting surface reason', () => {
    for (const surfaceTier of ['Preview', 'Limited'] as const) {
      expect(
        productReasonFor({
          status: 'caution', productClass: 'deliverable', surfaceTier,
          surfaceReason: SURFACE, exportReason: EXPORT_SUBGOOD,
          note: 'preview only — additional validation recommended',
        }),
      ).toBe(SURFACE);
    }
  });

  it('deliverable blocked → the gate sentence (the surface reason) verbatim', () => {
    expect(
      productReasonFor({
        status: 'blocked', productClass: 'deliverable', surfaceTier: 'Blocked',
        surfaceReason: 'Too little coverage to form a surface.',
        exportReason: 'Too little coverage to form a surface.',
        note: 'quality gate stopped this surface',
      }),
    ).toBe('Too little coverage to form a surface.');
  });

  it('falls back down the chain when richer strings are blank — note last, never undefined prose', () => {
    // No surface reason → export reason.
    expect(
      productReasonFor({
        status: 'caution', productClass: 'deliverable', surfaceTier: 'Limited',
        surfaceReason: '', exportReason: EXPORT_SUBGOOD,
        note: 'preview only — additional validation recommended',
      }),
    ).toBe(EXPORT_SUBGOOD);
    // Nothing but the row note → the note.
    expect(
      productReasonFor({
        status: 'caution', productClass: 'deliverable', surfaceTier: 'Good',
        surfaceReason: '', exportReason: '', note: 'georeferencing incomplete',
      }),
    ).toBe('georeferencing incomplete');
    // Truly nothing → undefined (the view renders no Reason line, never '').
    expect(
      productReasonFor({
        status: 'caution', productClass: 'deliverable', surfaceTier: 'Good',
        surfaceReason: '', exportReason: '',
      }),
    ).toBeUndefined();
  });
});

describe('vocabulary helpers', () => {
  it('statusWordFor / glyphFor — the one grade → word/glyph table', () => {
    expect(statusWordFor('good')).toBe('Ready');
    expect(statusWordFor('caution')).toBe('Preview');
    expect(statusWordFor('blocked')).toBe('Blocked');
    expect(glyphFor('good')).toBe('✓');
    expect(glyphFor('caution')).toBe('⚠');
    expect(glyphFor('blocked')).toBe('✕');
  });

  it('readinessLine — "Tier — reason", or just the tier when Ready', () => {
    expect(readinessLine('Ready', '')).toBe('Ready');
    expect(readinessLine('Preview', 'vertical datum unknown')).toBe(
      'Preview — vertical datum unknown',
    );
  });

  it('joinReasons — "a", "a and b", "a, b, and c"', () => {
    expect(joinReasons(['a'])).toBe('a');
    expect(joinReasons(['a', 'b'])).toBe('a and b');
    expect(joinReasons(['a', 'b', 'c'])).toBe('a, b, and c');
  });
});

// ── 2. single-source contract ────────────────────────────────────────────────

describe('single source — every consumer is a view over the engine output', () => {
  it('all consumers quote the engine verdict for a georef-gapped run (no parallel derivation)', () => {
    const result = noDatumResult();
    const expected = actualEngine.deriveReadiness({
      surfaceTier: 'Good',
      surfaceReason: '100% measured ground — the surface passes the quality gate.',
      crsKnown: true,
      datumKnown: false,
    });

    const a = terrainAssessment(result);
    expect(a.exportReadiness).toBe(expected.tier);
    expect(a.exportReason).toBe(expected.reason);

    const workflows = recommendedWorkflows(a);
    const dem = workflows.find((w) => w.label === 'DEM export')!;
    expect(dem.status).toBe(expected.productGrades.deliverable.status);
    expect(dem.note).toBe(expected.productGrades.deliverable.note);

    const products = terrainProducts(a, workflows);
    const demProduct = products.find((p) => p.label === 'DTM/DEM export')!;
    expect(demProduct.statusWord).toBe(expected.productGrades.deliverable.statusWord);
    expect(demProduct.glyph).toBe(expected.productGrades.deliverable.glyph);

    const lines = provenanceLines(buildExportProvenance(result, OPTS));
    expect(kvValue(lines, 'Export readiness')).toBe(
      readinessLine(expected.tier, expected.reason),
    );

    const report = buildTerrainReportContent(result, OPTS);
    const summary = report.sections.find((s) => s.title === 'Executive Summary')!;
    expect(summary.rows.find((r) => r.label === 'Export readiness')!.value).toBe(
      readinessLine(expected.tier, expected.reason),
    );
  });

  it('a sentinel engine verdict propagates verbatim into every view', () => {
    // Swap THE engine function for a sentinel. If any consumer still derived
    // the verdict itself (from CRS/datum/status), its view would print the
    // real 'Ready' with an empty reason instead of the sentinel strings.
    // The sentinel holds export at Preview because Ready product rows carry
    // NO reason by contract — a Preview deliverable is where the engine's
    // reason string must surface in the products view.
    const sentinel: ReadinessVerdict = {
      tier: 'Preview',
      reason: 'SENTINEL-REASON minted only by the engine',
      productGrades: actualEngine.productGradesFor('Good', 'Preview'),
    };
    vi.mocked(deriveReadiness).mockReturnValue(sentinel);

    const result = readyResult();
    const a = terrainAssessment(result);
    expect(a.exportReadiness).toBe('Preview');
    expect(a.exportReason).toBe('SENTINEL-REASON minted only by the engine');

    // A caution deliverable on a Good surface quotes the assessment's
    // exportReason — the sentinel string — in full (productReasonFor prefers
    // it over the generic workflow note).
    const products = terrainProducts(a, recommendedWorkflows(a));
    expect(products.find((p) => p.label === 'DTM/DEM export')!.reason).toBe(
      'SENTINEL-REASON minted only by the engine',
    );

    // Provenance (and through it every exporter stamp) prints the sentinel.
    const lines = provenanceLines(buildExportProvenance(result, OPTS));
    expect(kvValue(lines, 'Export readiness')).toBe(
      'Preview — SENTINEL-REASON minted only by the engine',
    );

    // The Terrain Intelligence Report quotes it in both readiness rows.
    const report = buildTerrainReportContent(result, OPTS);
    const summary = report.sections.find((s) => s.title === 'Executive Summary')!;
    expect(summary.rows.find((r) => r.label === 'Export readiness')!.value).toBe(
      'Preview — SENTINEL-REASON minted only by the engine',
    );
    const assessSection = report.sections.find((s) => s.title === 'Terrain Assessment')!;
    expect(assessSection.rows.find((r) => r.label === 'Export note')!.value).toBe(
      'SENTINEL-REASON minted only by the engine',
    );
    // … and its products section carries the SAME engine string as the panel.
    expect(report.products.find((p) => p.label === 'DTM/DEM export')!.note).toBe(
      'SENTINEL-REASON minted only by the engine',
    );
  });

  it('mutating the engine-sourced fields on an assessment moves the downstream views', () => {
    // The workflow/product views must read the assessment's carried verdict,
    // never re-grade from the raw result: flip the tier on the object and the
    // views flip with it.
    const a = terrainAssessment(readyResult());
    const mutated = a as { -readonly [K in keyof TerrainAssessment]: TerrainAssessment[K] };
    mutated.exportReadiness = 'Blocked';

    const workflows = recommendedWorkflows(a);
    for (const label of ['DEM export', 'Contour generation', 'Map sheet (PDF)']) {
      const row = workflows.find((w) => w.label === label)!;
      expect(row.status).toBe('blocked');
      expect(row.note).toBe('quality gate stopped this surface');
    }
    const products = terrainProducts(a, workflows);
    expect(products.find((p) => p.label === 'Contours')!.statusWord).toBe('Blocked');
    expect(products.find((p) => p.label === 'Contours')!.glyph).toBe('✕');
  });
});
