/**
 * terrainReportContent.ts
 *
 * The PURE content model behind the one-click "Terrain Intelligence Report" — the
 * client-facing deliverable that ASSEMBLES everything the app already computed
 * into one report. NO new analysis: every string is sourced from an existing
 * module so the report can never disagree with the on-screen Analyse panel.
 *
 * Source-of-truth map (each section is fed by an existing module):
 *   - Dataset Summary       ← the DtmGrid + {@link buildExportProvenance}.
 *   - Terrain Assessment    ← {@link terrainAssessment} (Surface Quality verdict
 *                             + 0–100 score + reason; Export Readiness + reason).
 *   - Coverage Analysis     ← the DTM quality gate ratios + mean confidence.
 *   - Quality Metrics       ← {@link demAccuracyStandards} (RMSEz / NVA / VVA /
 *                             USGS 3DEP Quality Level), honestly null-able.
 *   - Warnings              ← `result.warnings` + {@link explainLimitations}
 *                             causes (deduped, each carrying its figure).
 *   - Recommended Workflows ← {@link recommendedWorkflows} (✓ / ⚠ / ✕).
 *   - Terrain Products      ← export readiness + the contour gate, mirroring the
 *                             deliverable-class workflow grading.
 *   - How to improve        ← {@link explainLimitations} fixes (only when the
 *                             surface is not fully-good).
 *   - Footer                ← {@link provenanceLines} + the not-survey-grade note.
 *
 * Honesty contract (non-negotiable, mirrors the rest of the terrain stack):
 *   - We NEVER claim survey-grade. The only allowed mention is the standing,
 *     negated {@link NOT_SURVEY_GRADE_NOTE} in the footer.
 *   - Null / unknown values render as an em-dash or the literal "unknown" —
 *     never a fabricated zero or a guessed CRS / datum / accuracy.
 *
 * Pure data: NO pdf-lib, NO DOM, NO I/O. Deterministic given a fixed
 * `generatedAt`. The PDF renderer ({@link buildTerrainReportPdf}) consumes this
 * so the two can never drift.
 */

import type { AnalyseContoursResult } from '../contour/analyseContours';
import { terrainAssessment } from '../contour/terrainAssessment';
import { recommendedWorkflows, type WorkflowItem } from '../contour/recommendedWorkflow';
import { explainLimitations } from '../contour/whyNotReasons';
import {
  buildExportProvenance,
  provenanceLines,
  NOT_SURVEY_GRADE_NOTE,
  SOFTWARE_NAME,
  type ExportProvenance,
  type ExportProvenanceOptions,
} from './exportProvenance';

const DASH = '—';

/** One label/value line in a report section. */
export interface TerrainReportRow {
  readonly label: string;
  readonly value: string;
}

/** A titled block of label/value rows. */
export interface TerrainReportSection {
  readonly title: string;
  readonly rows: ReadonlyArray<TerrainReportRow>;
}

/** A graded workflow line (✓ / ⚠ / ✕) with an optional honest note. */
export interface TerrainReportWorkflow {
  readonly label: string;
  /** ✓ for good, ⚠ for caution, ✕ for blocked. */
  readonly mark: '✓' | '⚠' | '✕';
  readonly note?: string;
}

/** A take-away product the client can see the export status of at a glance. */
export interface TerrainReportProduct {
  readonly label: string;
  /** 'Available' (Ready) / 'Preview' (preview-only) / 'Blocked' (gate stopped). */
  readonly availability: 'Available' | 'Preview' | 'Blocked';
  /** Short, honest qualifier for Preview / Blocked products (absent for Available). */
  readonly note?: string;
}

/** The complete, pure content model the PDF renderer lays out. */
export interface TerrainReportContent {
  readonly title: string;
  readonly subtitle: string;
  /** Label/value sections, in print order. */
  readonly sections: ReadonlyArray<TerrainReportSection>;
  /** The recommended-workflow checklist (✓ / ⚠ / ✕), assembled from the verdicts. */
  readonly workflows: ReadonlyArray<TerrainReportWorkflow>;
  /** What the client can take away — DEM / Contours / Map sheet, each graded. */
  readonly products: ReadonlyArray<TerrainReportProduct>;
  /** Deduped warnings (run warnings + why-not causes, each with its figure). */
  readonly warnings: ReadonlyArray<string>;
  /** How-to-improve fixes — empty when the surface is fully-good. */
  readonly howToImprove: ReadonlyArray<string>;
  /** The unified provenance (header / footer fields). */
  readonly provenance: ExportProvenance;
  /** Provenance lines for the footer (single-sourced from `provenance`). */
  readonly provenanceLines: ReadonlyArray<string>;
  /** The standing not-survey-grade note ({@link NOT_SURVEY_GRADE_NOTE}). */
  readonly notSurveyGrade: string;
}

/** Format a metre value at 2 dp, or an em-dash when absent (never fabricated). */
function fmtM(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? `${v.toFixed(2)} m` : DASH;
}

/** Format an integer with thousands grouping, or an em-dash when absent. */
function fmtInt(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? Math.round(v).toLocaleString() : DASH;
}

/** Format a 0..1 fraction as a whole percent, or an em-dash when absent. */
function fmtPct(frac: number | null | undefined): string {
  return frac != null && Number.isFinite(frac) ? `${Math.round(frac * 100)}%` : DASH;
}

/** Format the YYYY-MM-DD HH:MM UTC slice of an ISO timestamp. */
function fmtGenerated(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** Map a workflow grade to its glyph mark. */
function markFor(status: WorkflowItem['status']): TerrainReportWorkflow['mark'] {
  return status === 'good' ? '✓' : status === 'caution' ? '⚠' : '✕';
}

/** Map an export-readiness verdict onto a product availability label + note. */
function productFromReadiness(
  label: string,
  readiness: 'Ready' | 'Preview' | 'Blocked',
  reason: string,
): TerrainReportProduct {
  if (readiness === 'Ready') return { label, availability: 'Available' };
  if (readiness === 'Blocked') {
    return { label, availability: 'Blocked', note: reason || 'quality gate stopped this surface' };
  }
  return {
    label,
    availability: 'Preview',
    note: reason || 'preview only — not for final deliverables',
  };
}

/**
 * Assemble the Terrain Intelligence Report content from an analysis result. This
 * is a PURE PROJECTION of the existing modules — it computes nothing new. Missing
 * values are reported honestly (em-dash / "unknown"); the footer always carries
 * the not-survey-grade note. Deterministic given a fixed `generatedAt`.
 */
export function buildTerrainReportContent(
  result: AnalyseContoursResult,
  opts: ExportProvenanceOptions = {},
): TerrainReportContent {
  // The unified provenance — the SAME object every other export stamps — gives
  // the header / footer fields (software, version, date, CRS, datum, coverage,
  // verdicts, accuracy) and guarantees they match the GeoJSON / DXF / map sheet.
  const provenance = buildExportProvenance(result, opts);
  // The top-level verdict the panel renders — Surface Quality + score + reason,
  // and Export Readiness + reason. Single source of truth for the assessment.
  const assessment = terrainAssessment(result);
  const limitations = explainLimitations(result);
  const workflowItems = recommendedWorkflows(assessment, result.quality);

  const dtm = result.dtm;
  const q = result.quality;
  const acc = result.accuracyStandards ?? null;
  const hasAcc = provenance.accuracy != null;

  // ── Dataset Summary ─────────────────────────────────────────────────────
  // Footprint = grid extent (cols/rows × cell size). Honest when the grid is
  // absent. Classification availability is inferred from whether the run
  // dropped any classified non-ground returns (excludedByClassification > 0)
  // OR a non-zero count was supplied — we say "yes" / "no" plainly.
  const cols = Number.isFinite(dtm?.cols) ? dtm.cols : null;
  const rows = Number.isFinite(dtm?.rows) ? dtm.rows : null;
  const cell = Number.isFinite(dtm?.cellSizeM) && dtm.cellSizeM > 0 ? dtm.cellSizeM : null;
  const footprint =
    cols != null && rows != null && cell != null
      ? `${Math.round(cols * cell).toLocaleString()} × ${Math.round(rows * cell).toLocaleString()} m`
      : DASH;
  const density = provenance.pointDensityPerM2;
  const classified =
    (result.excludedByClassification ?? 0) > 0 ? 'Yes' : 'No';

  const datasetSummary: TerrainReportSection = {
    title: 'Dataset Summary',
    rows: [
      { label: 'Scan', value: provenance.source ?? 'Untitled scan' },
      { label: 'Source points', value: fmtInt(dtm?.sourcePointCount) },
      { label: 'Analysed points', value: fmtInt(dtm?.analyzedPointCount) },
      { label: 'Footprint (extent)', value: footprint },
      {
        label: 'Ground density',
        value: density != null ? `${density.toFixed(1)} pts/m²` : DASH,
      },
      { label: 'Coverage mode', value: provenance.coverageMode },
      { label: 'Horizontal CRS', value: provenance.horizontalCrs },
      { label: 'Vertical datum', value: provenance.verticalDatum },
      { label: 'Classification available', value: classified },
      { label: 'Generated', value: fmtGenerated(provenance.generated) },
      {
        label: 'Software',
        value: `${SOFTWARE_NAME} ${provenance.softwareVersion}`,
      },
    ],
  };

  // ── Terrain Assessment ──────────────────────────────────────────────────
  const assessmentSection: TerrainReportSection = {
    title: 'Terrain Assessment',
    rows: [
      { label: 'Surface quality', value: assessment.status },
      {
        label: 'Quality score',
        value: assessment.scoreKnown ? `${assessment.score}/100` : 'unknown',
      },
      { label: 'Reason', value: assessment.reason },
      { label: 'Export readiness', value: assessment.exportReadiness },
      {
        label: 'Export note',
        value: assessment.exportReason ? assessment.exportReason : 'ready to hand off',
      },
    ],
  };

  // ── Coverage Analysis ───────────────────────────────────────────────────
  // The gate's measured/interpolated/empty/edge ratios + mean confidence and
  // ground visibility — the same figures the panel's coverage block shows.
  const coverageSection: TerrainReportSection = {
    title: 'Coverage Analysis',
    rows: [
      { label: 'Coverage mode', value: provenance.coverageMode },
      { label: 'Measured', value: fmtPct(q?.measuredCellRatio) },
      { label: 'Interpolated', value: fmtPct(q?.interpolatedCellRatio) },
      { label: 'Empty', value: fmtPct(q?.emptyCellRatio) },
      { label: 'Edge risk', value: fmtPct(q?.edgeRiskRatio) },
      {
        label: 'Ground visibility',
        value: fmtPct(q?.groundPointRatio),
      },
      {
        label: 'Mean confidence',
        value:
          q != null && Number.isFinite(q.meanCellConfidence)
            ? `${Math.round(q.meanCellConfidence)}/100`
            : DASH,
      },
    ],
  };

  // ── Quality Metrics ─────────────────────────────────────────────────────
  // ASPRS / USGS 3DEP vocabulary, honestly null-able: when the run measured no
  // RMSEz the whole block reads em-dash / unknown rather than a fabricated zero.
  const qlValue =
    hasAcc && provenance.accuracy && provenance.accuracy.usgsQualityLevel !== 'unknown'
      ? provenance.accuracy.usgsQualityLevel
      : acc && acc.qualityLevel !== 'unknown'
        ? acc.qualityLevel
        : DASH;
  const qualitySection: TerrainReportSection = {
    title: 'Quality Metrics',
    rows: [
      { label: 'Vertical RMSEz', value: hasAcc ? fmtM(provenance.accuracy?.rmseZM) : DASH },
      { label: 'NVA (95%)', value: hasAcc ? fmtM(provenance.accuracy?.nvaM) : DASH },
      { label: 'VVA (95th pct)', value: hasAcc ? fmtM(provenance.accuracy?.vvaM) : DASH },
      { label: 'USGS 3DEP Quality Level', value: qlValue },
    ],
  };

  // ── Warnings (run warnings + why-not causes, deduped, with figures) ──────
  const warnings: string[] = [];
  const seenWarn = new Set<string>();
  const pushWarn = (w: string): void => {
    const t = (w ?? '').trim();
    if (t.length === 0 || seenWarn.has(t)) return;
    seenWarn.add(t);
    warnings.push(t);
  };
  for (const w of result.warnings ?? []) pushWarn(w);
  for (const c of limitations.causes) pushWarn(c.text);

  // ── How to improve (only when not fully-good) ───────────────────────────
  const howToImprove: string[] = [];
  if (assessment.status !== 'Good' || assessment.exportReadiness !== 'Ready') {
    const seenFix = new Set<string>();
    for (const f of limitations.fixes) {
      const t = f.text.trim();
      if (t.length === 0 || seenFix.has(t)) continue;
      seenFix.add(t);
      howToImprove.push(t);
    }
  }

  // ── Recommended Workflows (✓ / ⚠ / ✕) ───────────────────────────────────
  const workflows: TerrainReportWorkflow[] = workflowItems.map((w) =>
    w.note != null
      ? { label: w.label, mark: markFor(w.status), note: w.note }
      : { label: w.label, mark: markFor(w.status) },
  );

  // ── Terrain Products Available (mirror the deliverable-class grading) ────
  // Each take-away product keys off export readiness (the surface verdict gated
  // by a known CRS + datum, which already folds in the contour gate), so the
  // client sees exactly what they can take away and why it is held back.
  const er = assessment.exportReadiness;
  const erReason = assessment.exportReason;
  const products: TerrainReportProduct[] = [
    productFromReadiness('DEM (elevation rasters)', er, erReason),
    productFromReadiness('Contours', er, erReason),
    productFromReadiness('Map sheet (PDF)', er, erReason),
  ];

  // The workflow + products lists are ALSO surfaced as label/value sections so
  // the `sections` array is the single canonical print order. The typed
  // `workflows` / `products` arrays above are kept for the renderer (glyph marks
  // / availability colouring); these section rows mirror them verbatim.
  const workflowSection: TerrainReportSection = {
    title: 'Recommended Workflows',
    rows: workflows.map((w) => ({
      label: `${w.mark} ${w.label}`,
      value: w.note ?? '',
    })),
  };
  const productsSection: TerrainReportSection = {
    title: 'Terrain Products Available',
    rows: products.map((p) => ({
      label: p.label,
      value: p.note ? `${p.availability} — ${p.note}` : p.availability,
    })),
  };

  return {
    title: provenance.source ?? 'Untitled scan',
    subtitle: 'Terrain Intelligence Report',
    sections: [
      datasetSummary,
      assessmentSection,
      coverageSection,
      qualitySection,
      workflowSection,
      productsSection,
    ],
    workflows,
    products,
    warnings,
    howToImprove,
    provenance,
    provenanceLines: provenanceLines(provenance),
    notSurveyGrade: NOT_SURVEY_GRADE_NOTE,
  };
}
