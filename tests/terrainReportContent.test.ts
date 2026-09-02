/**
 * terrainReportContent.test.ts
 *
 * The pure, single-source content model behind the Terrain Intelligence Report
 * PDF. It is an ASSEMBLY of the existing terrain modules — terrainAssessment,
 * recommendedWorkflows, explainLimitations, the DEM accuracy standards and the
 * unified export provenance — so the report can never disagree with the panel.
 *
 * These tests verify, WITHOUT pdf-lib:
 *   - every section is present and fed from the real assessment / workflow /
 *     why-not / accuracy values;
 *   - the Executive Summary verdict sentence is assessment-minted (status +
 *     reason, readiness + reason) — never new prose;
 *   - the Terrain Products list IS the panel's terrainProducts view (six
 *     products, Ready→Available renamed), not a parallel derivation;
 *   - Dataset Statistics carries the Inspector card's intelligence bucket
 *     labels when (and only when) the caller supplies them;
 *   - a Good + Ready scan marks every terrain product Available, emits no "How
 *     to improve" section, and still carries the not-survey-grade note;
 *   - a Preview scan with an unknown datum marks the deliverable products
 *     Preview, populates Warnings + How-to-improve with their figures, and
 *     never claims survey-grade;
 *   - null accuracy renders as em-dash / "unknown", never a fabricated zero.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTerrainReportContent,
  type TerrainReportContent,
} from '../src/terrain/export/terrainReportContent';
import { NOT_SURVEY_GRADE_NOTE } from '../src/terrain/export/exportProvenance';
import { terrainAssessment } from '../src/terrain/contour/terrainAssessment';
import { recommendedWorkflows } from '../src/terrain/contour/recommendedWorkflow';
import { terrainProducts } from '../src/terrain/contour/terrainProducts';
import type { DatasetIntelligence } from '../src/terrain/datasetIntelligence';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

/**
 * A complete, full-coverage, export-ready analysis result with everything known
 * (Good surface + known CRS/datum + measured accuracy). Mirrors the fixture
 * shape used by exportProvenance.test.ts so the two stay aligned.
 */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      coverageMode: 'full',
      meanConfidence: 82,
      cols: 200,
      rows: 150,
      cellSizeM: 1,
      sourcePointCount: 1_200_000,
      analyzedPointCount: 900_000,
    },
    intervalM: 1,
    model: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      intervalM: 1,
      contourStyle: 'smooth',
      coverageMode: 'full',
      features: [{}, {}],
    },
    accuracyStandards: {
      rmseZM: 0.14,
      nvaM: 0.27,
      vvaM: 0.3,
      pointDensityPerM2: 4.2,
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
    },
    quality: {
      readiness: 'ready',
      exportReadiness: 'available',
      crsKnown: true,
      datumKnown: true,
      coverageMode: 'full',
      reasons: [],
      exportReasons: [],
      interpolatedCellRatio: 0.06,
      emptyCellRatio: 0.05,
      edgeRiskRatio: 0.02,
      meanCellConfidence: 82,
      groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: {
      measured: 90,
      interpolated: 5,
      lowConfidence: 0,
      edgeRisk: 0,
      empty: 5,
      total: 100,
    },
    excludedByClassification: 1200,
    generationParams: {
      interpolation: 'geodesic',
      contourStyle: 'smooth',
      smoothing: true,
      despike: true,
      aggregation: 'median',
    },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

/**
 * A Preview-grade result: high interpolation, resident-only coverage, unknown
 * vertical datum, and NO measured accuracy. The assessment caps it to Preview
 * and export readiness to Preview (the datum gap names the reason).
 */
function previewResult(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610',
      verticalDatum: null,
      coverageMode: 'resident-only',
      meanConfidence: 48,
      cols: 80,
      rows: 60,
      cellSizeM: 2,
      sourcePointCount: 300_000,
      analyzedPointCount: 120_000,
    },
    intervalM: 2,
    model: {
      crs: 'EPSG:32610',
      verticalDatum: null,
      intervalM: 2,
      contourStyle: 'crisp',
      coverageMode: 'resident-only',
      features: [{}],
    },
    accuracyStandards: {
      rmseZM: null,
      nvaM: null,
      vvaM: null,
      pointDensityPerM2: 0,
      densityReferenceFloorsMet: [], densityReferenceNote: 'none',
    },
    quality: {
      readiness: 'previewOnly',
      exportReadiness: 'previewOnly',
      crsKnown: true,
      datumKnown: false,
      coverageMode: 'resident-only',
      reasons: ['Surface is preview-only — high interpolation.'],
      exportReasons: ['vertical datum unknown'],
      interpolatedCellRatio: 0.55,
      emptyCellRatio: 0.2,
      edgeRiskRatio: 0.05,
      meanCellConfidence: 48,
      groundPointRatio: 0.6,
    },
    qualityScore: { score: 41 },
    cellMetrics: { meanDensity: 1.4, boundaryMeasuredRatio: 0.05 },
    cellStatusTally: {
      measured: 40,
      interpolated: 40,
      lowConfidence: 0,
      edgeRisk: 0,
      empty: 20,
      total: 100,
    },
    excludedByClassification: 0,
    generationParams: {
      interpolation: 'idw',
      contourStyle: 'crisp',
      smoothing: false,
      despike: true,
      aggregation: 'median',
    },
    warnings: ['Void-filled 40% of cells by interpolation.'],
  } as unknown as AnalyseContoursResult;
}

const OPTS = {
  basename: 'site-42',
  generatedAt: '2026-06-05T00:00:00.000Z',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.1',
} as const;

/** Collect every value string in a content's sections. */
function allValues(c: TerrainReportContent): string {
  return c.sections.flatMap((s) => s.rows.map((r) => `${r.label} ${r.value}`)).join(' | ');
}

describe('buildTerrainReportContent — section presence + sourcing', () => {
  it('produces every required section, leading with the Executive Summary', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const titles = c.sections.map((s) => s.title);
    expect(titles[0]).toBe('Executive Summary');
    expect(titles).toContain('Dataset Statistics');
    expect(titles).toContain('Terrain Assessment');
    expect(titles).toContain('Coverage Analysis');
    expect(titles).toContain('Quality Metrics');
    expect(titles).toContain('Recommended Workflows');
    expect(titles).toContain('Terrain Products Available');
  });

  it('Executive Summary is the assessment verdict sentence, not new prose', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const a = terrainAssessment(readyResult());
    const es = c.sections.find((s) => s.title === 'Executive Summary')!;
    const row = (label: string): string =>
      es.rows.find((r) => r.label === label)?.value ?? '(missing)';
    // Verdict = "<status> — <reason>" from terrainAssessment, verbatim parts.
    expect(row('Verdict')).toBe(`${a.status} — ${a.reason}`);
    expect(row('Verdict')).toMatch(/^Good — /); // hand-pinned for this fixture
    // Ready run carries no reason suffix — bare verdict, never " — ".
    expect(row('Export readiness')).toBe('Ready');
    // Best-for is the assessment's own suitability line.
    expect(row('Best for')).toBe(a.bestFor);
    expect(row('Best for').length).toBeGreaterThan(0);
  });

  it('Dataset Statistics carries the scan name, ground-point counts, software + date', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const ds = c.sections.find((s) => s.title === 'Dataset Statistics')!;
    const text = ds.rows.map((r) => `${r.label}: ${r.value}`).join('\n');
    expect(text).toMatch(/site-42/);
    expect(text).toMatch(/1,200,000/); // ground returns the DTM was built from, grouped
    expect(text).toMatch(/EPSG:32610/); // horizontal CRS
    expect(text).toMatch(/OpenLiDARViewer 9\.9\.9/);
    expect(text).toMatch(/2026-06-05/);
    // Honesty: these are the ground/DTM counts, labelled as such — never a bare
    // "Source points" that a client would read as the file's total point count.
    expect(ds.rows.some((r) => r.label === 'Ground points')).toBe(true);
    expect(ds.rows.some((r) => r.label === 'Used in DTM')).toBe(true);
    expect(ds.rows.some((r) => r.label === 'Source points')).toBe(false);
  });

  it('Dataset Statistics carries the intelligence bucket labels only when supplied', () => {
    // Hand-built summary in the card's own vocabulary — the report must echo
    // the labels verbatim (they are the card's strings, not re-derived).
    const intelligence: DatasetIntelligence = {
      density: { bucket: 'dense', label: 'Dense', basis: 'volumetric' },
      complexity: { bucket: 'moderate', label: 'Moderate' },
      groundVisibility: { bucket: 'good', label: 'Good' },
      coverage: { bucket: 'full', label: 'Full Dataset' },
      confidence: { value: 82, band: 'green', label: '82%' },
      details: {
        coverageMode: 'Full Dataset',
        sourcePointCount: 1_200_000,
        analyzedPointCount: 900_000,
        metricVersion: 'v0.4.4',
        engineStatus: 'active',
      },
    };
    const withIntel = buildTerrainReportContent(readyResult(), { ...OPTS, intelligence });
    const ds = withIntel.sections.find((s) => s.title === 'Dataset Statistics')!;
    const row = (label: string): string =>
      ds.rows.find((r) => r.label === label)?.value ?? '(missing)';
    expect(row('Volumetric point density (all returns, bounding box)')).toBe('Dense');
    expect(row('Terrain complexity')).toBe('Moderate');
    expect(row('Ground visibility')).toBe('Good');
    expect(row('Metric stability')).toBe('82%');

    // Without the summary the rows are OMITTED — never fabricated buckets.
    const without = buildTerrainReportContent(readyResult(), OPTS);
    const dsWithout = without.sections.find((s) => s.title === 'Dataset Statistics')!;
    const labels = dsWithout.rows.map((r) => r.label);
    expect(labels).not.toContain('Volumetric point density (all returns, bounding box)');
    expect(labels).not.toContain('Terrain complexity');
    expect(labels).not.toContain('Ground visibility');
    expect(labels).not.toContain('Metric stability');
  });

  it('Terrain Assessment carries the real verdict + score + export readiness', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const ta = c.sections.find((s) => s.title === 'Terrain Assessment')!;
    const text = ta.rows.map((r) => `${r.label}: ${r.value}`).join('\n');
    expect(text).toMatch(/Good/);
    expect(text).toMatch(/85\/100/);
    expect(text).toMatch(/Ready/);
  });

  it('Quality Metrics carries RMSEz / NVA / VVA / USGS QL from the standards', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const qm = c.sections.find((s) => s.title === 'Quality Metrics')!;
    const text = qm.rows.map((r) => `${r.label}: ${r.value}`).join('\n');
    expect(text).toMatch(/0\.14 m/); // RMSEz
    expect(text).toMatch(/0\.27 m/); // NVA
    expect(text).toMatch(/>= QL2 floor/);
    // The report's labels carry the honesty qualifiers, same as the panel
    // and the provenance stamp — hold-out formulas, not checkpoints.
    expect(text).toMatch(/NVA-style \(95%, hold-out\)/);
    expect(text).toMatch(/VVA-style \(95th pct, hold-out\)/);
  });

  it('the not-survey-grade note is always present in the footer', () => {
    const good = buildTerrainReportContent(readyResult(), OPTS);
    const prev = buildTerrainReportContent(previewResult(), OPTS);
    expect(good.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(prev.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(good.notSurveyGrade).toMatch(/not survey-grade/i);
    // never an affirmative survey-grade claim anywhere
    expect(allValues(good)).not.toMatch(/\bsurvey-grade\b(?!\s|$)/i);
  });
});

describe('buildTerrainReportContent — Good + Ready scan', () => {
  it('lists the SAME six products as the panel view, all Available', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const products = c.products;
    // The panel's terrainProducts view lists six take-aways — the report must
    // carry the identical list (Ready renamed Available), not a subset.
    expect(products.map((p) => p.label)).toEqual([
      'Profiles',
      'Measurements',
      'Terrain review',
      'DTM/DEM export',
      'Contours',
      'Map sheet',
    ]);
    for (const p of products) {
      expect(p.availability).toBe('Available');
      expect(p.note).toBeUndefined(); // ready rows carry no excuse
    }
  });

  it('the products list IS the terrainProducts view (no parallel derivation)', () => {
    const result = readyResult();
    const c = buildTerrainReportContent(result, OPTS);
    const a = terrainAssessment(result);
    const view = terrainProducts(a, recommendedWorkflows(a, result.quality));
    expect(c.products.map((p) => p.label)).toEqual(view.map((v) => v.label));
    expect(c.products.map((p) => p.availability)).toEqual(
      view.map((v) => (v.statusWord === 'Ready' ? 'Available' : v.statusWord)),
    );
  });

  it('omits the How-to-improve section and emits no warnings', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    expect(c.howToImprove).toHaveLength(0);
    expect(c.warnings).toHaveLength(0);
  });

  it('every recommended workflow is graded good (✓)', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    expect(c.workflows.length).toBeGreaterThan(0);
    for (const w of c.workflows) expect(w.mark).toBe('✓');
  });
});

describe('buildTerrainReportContent — Preview + datum-unknown scan', () => {
  it('marks every product Preview on a partial stream, each row quoting the verdict reason in full', () => {
    // This fixture is a resident-only PARTIAL STREAM (high interpolation, datum
    // unknown). A partial stream is preliminary, so the inspection-class rows
    // are held at caution → Preview (not promoted to a confident Available) and
    // the deliverable-class rows key off export readiness (Preview). The verdict
    // reason leads with the honest "Preliminary — only the streamed-in part …"
    // framing rather than the sparse streaming figures (which still live in the
    // supporting metrics + Why details). Each product row quotes that same
    // verdict reason, byte-identical.
    const result = previewResult();
    const c = buildTerrainReportContent(result, OPTS);
    expect(c.products).toHaveLength(6);
    const a = terrainAssessment(result);
    for (const p of c.products) {
      expect(p.availability).toBe('Preview');
      // The SAME engine string the panel renders, byte-identical and whole.
      expect(p.note).toBe(a.reason);
      expect(p.note).toMatch(/Preliminary/);
      expect(p.note).toMatch(/stream/i);
    }
  });

  it("the report's product notes are the panel view's reasons, row for row", () => {
    const result = previewResult();
    const c = buildTerrainReportContent(result, OPTS);
    const a = terrainAssessment(result);
    const view = terrainProducts(a, recommendedWorkflows(a, result.quality));
    expect(c.products.map((p) => p.note)).toEqual(view.map((v) => v.reason));
  });

  it('the Executive Summary readiness line names the datum gap', () => {
    const c = buildTerrainReportContent(previewResult(), OPTS);
    const es = c.sections.find((s) => s.title === 'Executive Summary')!;
    const readiness = es.rows.find((r) => r.label === 'Export readiness')?.value ?? '';
    expect(readiness).toMatch(/^Preview — /);
    expect(readiness).toMatch(/datum/i);
  });

  it('populates Warnings from result.warnings + explainLimitations causes, deduped, with figures', () => {
    const c = buildTerrainReportContent(previewResult(), OPTS);
    expect(c.warnings.length).toBeGreaterThan(0);
    const joined = c.warnings.join(' | ');
    // a real warning from the run
    expect(joined).toMatch(/Void-filled 40%/);
    // an explainLimitations cause, carrying its honest figure
    expect(joined).toMatch(/55% of the surface is interpolated/);
    // the datum gap is surfaced as a cause
    expect(joined).toMatch(/vertical datum is unknown/i);
    // no duplicate entries
    expect(new Set(c.warnings).size).toBe(c.warnings.length);
  });

  it('populates How-to-improve with the explainLimitations fixes', () => {
    const c = buildTerrainReportContent(previewResult(), OPTS);
    expect(c.howToImprove.length).toBeGreaterThan(0);
    const joined = c.howToImprove.join(' | ');
    expect(joined).toMatch(/datum/i);
  });

  it('never claims survey-grade', () => {
    const c = buildTerrainReportContent(previewResult(), OPTS);
    const everything = [
      allValues(c),
      ...c.warnings,
      ...c.howToImprove,
      ...c.workflows.map((w) => `${w.label} ${w.note ?? ''}`),
      ...c.products.map((p) => `${p.label} ${p.note ?? ''}`),
      c.notSurveyGrade,
    ].join(' ');
    // The only allowed mention is the standing negated note ("not survey-grade").
    const affirmative = everything.replace(/not survey-grade/gi, '');
    expect(affirmative).not.toMatch(/survey-grade/i);
  });
});

describe('buildTerrainReportContent — honest nulls', () => {
  it('renders null accuracy as em-dash / unknown, never a fabricated zero', () => {
    const c = buildTerrainReportContent(previewResult(), OPTS);
    const qm = c.sections.find((s) => s.title === 'Quality Metrics')!;
    const byLabel = (needle: string): string =>
      qm.rows.find((r) => r.label.includes(needle))?.value ?? '';
    expect(byLabel('RMSEz')).toMatch(/—|unknown/);
    expect(byLabel('NVA')).toMatch(/—|unknown/);
    expect(byLabel('VVA')).toMatch(/—|unknown/);
    expect(byLabel('USGS')).toMatch(/—|unknown/);
    // never "0.00 m" fabricated for a missing measurement
    expect(qm.rows.map((r) => r.value).join(' ')).not.toMatch(/0\.00 m/);
  });

  it('renders unknown vertical datum honestly in the Dataset Statistics', () => {
    const c = buildTerrainReportContent(previewResult(), OPTS);
    const ds = c.sections.find((s) => s.title === 'Dataset Statistics')!;
    const datum = ds.rows.find((r) => r.label.toLowerCase().includes('datum'))?.value ?? '';
    expect(datum).toMatch(/unknown/i);
  });
});

describe('buildTerrainReportContent — §19 permit stamp in provenance', () => {
  it('stamps the resolved evidence-gate permit into the provenance footer', () => {
    const c = buildTerrainReportContent(readyResult(), {
      ...OPTS,
      exportPermit: {
        status: 'exploratory',
        label: 'Exploratory',
        watermark: 'EXPLORATORY',
        caveats: ['One or more scientific prerequisites are incomplete.'],
      },
    });
    // The footer carries the gate decision, watermark included — the report
    // itself records the permit that authorised it.
    expect(c.provenanceLines.some((l) => /Export permit\s+Exploratory — EXPLORATORY/.test(l))).toBe(true);
    expect(c.provenance.exportPermit?.status).toBe('exploratory');
  });

  it('carries NO permit line when the export did not route through the gate', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    expect(c.provenance.exportPermit).toBeNull();
    expect(c.provenanceLines.some((l) => /Export permit/.test(l))).toBe(false);
  });

  /**
   * Reported from a real 151M-point survey: the verdict said 43% of the surface
   * was interpolated while the Coverage table said 37%, and both said only
   * "interpolated". The two are different questions, one over the whole grid
   * and one over the covered surface, and dtmQualityGate documents that they
   * are not interchangeable. A reader could not reconcile the numbers because
   * neither carried its basis. The same report used one label, "Ground
   * visibility", for a categorical bucket and for the classifier's ground
   * share, printing "-" for one and a percentage for the other.
   */
  describe('coverage figures name the basis they are measured against', () => {
    const coverage = (r: ReturnType<typeof readyResult>) =>
      buildTerrainReportContent(r, OPTS).sections.find((s) => s.title === 'Coverage Analysis');

    it('separates the grid share from the covered-surface share', () => {
      const base = readyResult();
      // Distinct on purpose: with empty cells present the two never agree.
      const r = {
        ...base,
        quality: { ...base.quality, interpolatedCellRatio: 0.37, interpolatedOfSurfaceRatio: 0.43 },
      } as ReturnType<typeof readyResult>;
      const rows = coverage(r)?.rows ?? [];
      const label = (l: string) => rows.find((x) => x.label === l)?.value;
      expect(label('Interpolated (of grid)')).toBe('37%');
      expect(label('Interpolated (of covered surface)')).toBe('43%');
      // No bare "Interpolated" survives, which is what made the two look like
      // one contradictory figure.
      expect(rows.some((x) => x.label === 'Interpolated')).toBe(false);
    });

    it('states the basis of every share that sums over the grid', () => {
      const rows = coverage(readyResult())?.rows ?? [];
      for (const l of ['Measured (of grid)', 'Empty (of grid)']) {
        expect(rows.some((x) => x.label === l)).toBe(true);
      }
    });

    it('does not reuse the Ground visibility label for the ground return share', () => {
      const c = buildTerrainReportContent(readyResult(), OPTS);
      const cov = c.sections.find((s) => s.title === 'Coverage Analysis');
      expect(
        cov?.rows.some((x) => x.label === 'Ground share of analysed candidates (after class exclusion)'),
      ).toBe(true);
      expect(cov?.rows.some((x) => x.label === 'Ground visibility')).toBe(false);
    });
  });
});

/**
 * Every row states the basis it is measured against. Reported from a real
 * report: "Ground returns (of all returns) 35%" was the SMRF ground share of
 * the analysed candidate sample AFTER class exclusion; "Measured reliability
 * 76% (|dz| <= 0.66 m)" used the hold-out RMSE itself as the tolerance;
 * "Ground visibility —" printed a dash for an unknown bucket; the blocked and
 * random RMSE sat side by side with no bridging text; "Classification
 * available Yes" said nothing about whether class 2 built the DTM.
 */
describe('buildTerrainReportContent — every row names its basis', () => {
  const section = (c: TerrainReportContent, title: string) =>
    c.sections.find((s) => s.title === title)!;
  const rowValue = (c: TerrainReportContent, title: string, label: string) =>
    section(c, title).rows.find((r) => r.label === label)?.value;
  const labels = (c: TerrainReportContent, title: string) =>
    section(c, title).rows.map((r) => r.label);

  it('#1 names the ground share as the analysed-candidate share after class exclusion', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    expect(labels(c, 'Coverage Analysis')).not.toContain('Ground returns (of all returns)');
    expect(rowValue(c, 'Coverage Analysis', 'Ground share of analysed candidates (after class exclusion)')).toBe('60%');
  });

  it('#1 prints "class 2 trusted" instead of a meaningless 100% on the trusted path', () => {
    const base = readyResult();
    const r = {
      ...base,
      generationParams: { ...base.generationParams, despike: false },
      quality: { ...base.quality, groundPointRatio: 1 },
    } as AnalyseContoursResult;
    const c = buildTerrainReportContent(r, OPTS);
    expect(rowValue(c, 'Coverage Analysis', 'Ground share of analysed candidates (after class exclusion)')).toBe(
      'class 2 trusted',
    );
  });

  it('#2 states that the reliability tolerance IS 1 × the hold-out RMSEz', () => {
    const base = readyResult();
    const r = {
      ...base,
      reliabilitySplit: {
        measured: { n: 500, reliability: 0.76, ciLow: 0.75, ciHigh: 0.76, tolerance: 0.66 },
        interpolated: null,
      },
    } as unknown as AnalyseContoursResult;
    const c = buildTerrainReportContent(r, OPTS);
    expect(labels(c, 'Quality Metrics')).not.toContain('Measured reliability');
    expect(rowValue(c, 'Quality Metrics', 'Within 1 × hold-out RMSEz (0.66 m)')).toBe(
      '76% of measured-cell hold-out residuals (95% CI 75%-76%)',
    );
  });

  it('#3 omits an intelligence row whose bucket is unknown instead of printing a dash', () => {
    const intelligence: DatasetIntelligence = {
      density: { bucket: 'dense', label: 'Dense', basis: 'areal' },
      complexity: { bucket: 'unknown', label: '—' },
      groundVisibility: { bucket: 'unknown', label: '—' },
      coverage: { bucket: 'full', label: 'Full Dataset' },
      confidence: { value: 0, band: 'unknown', label: '—' },
      details: {
        coverageMode: 'Full Dataset',
        sourcePointCount: 1,
        analyzedPointCount: 1,
        metricVersion: 'v0.4.4',
        engineStatus: 'idle',
      },
    };
    const c = buildTerrainReportContent(readyResult(), { ...OPTS, intelligence });
    const ds = labels(c, 'Dataset Statistics');
    expect(ds).toContain('Areal point density (all returns, header footprint)');
    expect(ds).not.toContain('Terrain complexity');
    expect(ds).not.toContain('Ground visibility');
    expect(ds).not.toContain('Metric stability');
    expect(section(c, 'Dataset Statistics').rows.some((r) => r.value === '—' && /visibility|stability|complexity/.test(r.label))).toBe(false);
  });

  it('#4 bridges the random hold-out and the blocked spatial CV with their true parameters', () => {
    const base = readyResult();
    const r = {
      ...base,
      blockedAccuracy: { n: 4, rmse: 3.87, mae: 2.1, ciLow: 3.5, ciHigh: 4.2 },
    } as unknown as AnalyseContoursResult;
    const c = buildTerrainReportContent(r, OPTS);
    const v = rowValue(c, 'Quality Metrics', 'Accuracy bases') ?? '';
    expect(v).toMatch(/Random hold-out RMSEz \(0\.14 m\)/);
    expect(v).toMatch(/interpolation between neighbouring ground points/);
    expect(v).toMatch(/feeds NVA\/VVA/);
    expect(v).toMatch(/8-cell blocks, 4 folds/);
    expect(v).toMatch(/<= 20,000 points/);
    expect(v).toMatch(/extrapolation across held-out blocks/);
    expect(v).toMatch(/blocked figure \(3\.87 m\) for map-scale use/);
  });

  it('#5 names the two density bases apart', () => {
    const intelligence: DatasetIntelligence = {
      density: { bucket: 'very-dense', label: 'Very Dense', basis: 'areal' },
      complexity: { bucket: 'low', label: 'Low' },
      groundVisibility: { bucket: 'good', label: 'Good' },
      coverage: { bucket: 'full', label: 'Full Dataset' },
      confidence: { value: 80, band: 'green', label: '80%' },
      details: { coverageMode: 'Full Dataset', sourcePointCount: 1, analyzedPointCount: 1, metricVersion: 'v', engineStatus: 'active' },
    };
    const c = buildTerrainReportContent(readyResult(), { ...OPTS, intelligence });
    const ds = labels(c, 'Dataset Statistics');
    expect(ds).not.toContain('Point density (class)');
    expect(ds).not.toContain('Ground density');
    expect(rowValue(c, 'Dataset Statistics', 'Areal point density (all returns, header footprint)')).toBe('Very Dense');
    expect(rowValue(c, 'Dataset Statistics', 'Ground density (measured cells, stride-scaled)')).toBe('4.2 pts/m²');
    // The provenance footer names the same figure the same way.
    expect(c.provenanceLines.some((l) => /^Ground density\s+4\.2 pts\/m²/.test(l))).toBe(true);
    expect(c.provenanceLines.some((l) => /^Point density\s/.test(l))).toBe(false);
  });

  it('#6 separates "non-ground classes excluded" from the ground source', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const ds = labels(c, 'Dataset Statistics');
    expect(ds).not.toContain('Classification available');
    expect(rowValue(c, 'Dataset Statistics', 'Non-ground classes excluded')).toBe('Yes');
    expect(rowValue(c, 'Dataset Statistics', 'Ground source')).toBe('SMRF filter (classification not trusted)');
    const base = readyResult();
    const trusted = {
      ...base,
      excludedByClassification: 0,
      generationParams: { ...base.generationParams, despike: false },
    } as AnalyseContoursResult;
    const t = buildTerrainReportContent(trusted, OPTS);
    expect(rowValue(t, 'Dataset Statistics', 'Non-ground classes excluded')).toBe('No');
    expect(rowValue(t, 'Dataset Statistics', 'Ground source')).toBe('ASPRS class 2 (trusted)');
  });

  it('#7 calls the complexity figure window completeness, not confidence', () => {
    const base = readyResult();
    const r = {
      ...base,
      complexity: {
        band: 'moderate', vrmMedian: 0.03, vrmIqr: 0.02, vrmWindowCells: 3, vrmWindowGroundM: 3,
        vrmText: 'vrm', tpiRadiusCells: 5, tpiRadiusGroundM: 5, tpiDominantClass: 'Flat', tpiText: 'tpi',
        zUnitLabel: 'm', slopeAspectConvention: 'c', confidence: 99, warnings: [],
      },
    } as unknown as AnalyseContoursResult;
    const c = buildTerrainReportContent(r, OPTS);
    expect(labels(c, 'Terrain Assessment')).not.toContain('Complexity confidence');
    expect(rowValue(c, 'Terrain Assessment', 'Complexity window completeness')).toBe('99/100');
  });

  it('#8 carries the registry evidence level per product, from the export resolver', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const byLabel = Object.fromEntries(c.products.map((p) => [p.label, p.evidence]));
    // DTM claim: the SAME resolution the provenance stamps.
    expect(byLabel['DTM/DEM export']).toBe('E4 — Cross-implementation validated (baseline)');
    expect(c.provenance.evidenceResolution?.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(byLabel['Contours']).toBe('E4 — Cross-implementation validated (baseline)');
    expect(byLabel['Map sheet']).toBe('E4 — Cross-implementation validated (baseline)');
    expect(byLabel['Profiles']).toBe('E4 — Cross-implementation validated (baseline)');
    expect(byLabel['Measurements']).toBe('no single registered claim');
    expect(byLabel['Terrain review']).toBe('no single registered claim');
    const ps = section(c, 'Terrain Products Available');
    expect(ps.rows.find((r) => r.label === 'Contours')?.value).toBe(
      'Available · Evidence level: E4 — Cross-implementation validated (baseline)',
    );
  });

  it('#9 carries the panel tooltips as Definitions, single-sourced', async () => {
    const { METRIC_TOOLTIPS } = await import('../src/terrain/contour/contourCopy');
    const c = buildTerrainReportContent(readyResult(), OPTS);
    expect(c.definitions).toEqual(Object.values(METRIC_TOOLTIPS));
  });

  it('#10 calls the cols·cell figure a grid extent', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    expect(labels(c, 'Dataset Statistics')).not.toContain('Footprint (extent)');
    expect(rowValue(c, 'Dataset Statistics', 'Grid extent')).toBe('200 × 150 m');
  });

  it('#11 qualifies the USGS density reference with its basis', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    expect(rowValue(c, 'Quality Metrics', 'USGS density reference')).toBe(
      '>= QL2 floor (stride-scaled ground density)',
    );
  });

  it('#12 prints Coverage mode once and no constant Export note', () => {
    const c = buildTerrainReportContent(readyResult(), OPTS);
    const all = c.sections.flatMap((s) => s.rows.filter((r) => r.label === 'Coverage mode'));
    expect(all).toHaveLength(1);
    expect(labels(c, 'Terrain Assessment')).not.toContain('Export note');
    expect(allValues(c)).not.toMatch(/ready to hand off/);
    const p = buildTerrainReportContent(previewResult(), OPTS);
    expect(rowValue(p, 'Terrain Assessment', 'Export note')).toMatch(/datum/i);
  });
});
