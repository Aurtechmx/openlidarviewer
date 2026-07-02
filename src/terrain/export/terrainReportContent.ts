/**
 * terrainReportContent.ts
 *
 * The PURE content model behind the one-click "Terrain Intelligence Report" — the
 * client-facing deliverable that ASSEMBLES everything the app already computed
 * into one report. NO new analysis: every string is sourced from an existing
 * module so the report can never disagree with the on-screen Analyse panel.
 *
 * Source-of-truth map (each section is fed by an existing module):
 *   - Executive Summary     ← {@link terrainAssessment} (the verdict + reason
 *                             joined into the one sentence the panel leads with,
 *                             plus export readiness and "best for").
 *   - Dataset Statistics    ← the DtmGrid + {@link buildExportProvenance}, plus
 *                             (when the caller supplies it) the Inspector's
 *                             {@link DatasetIntelligence} bucket labels — the
 *                             SAME strings the Dataset Intelligence card shows.
 *   - Terrain Assessment    ← {@link terrainAssessment} (Surface Quality verdict
 *                             + 0–100 score + reason; Export Readiness + reason).
 *   - Coverage Analysis     ← the DTM quality gate ratios + mean confidence.
 *   - Quality Metrics       ← {@link demAccuracyStandards} (RMSEz / NVA / VVA /
 *                             USGS 3DEP Quality Level), honestly null-able.
 *   - Warnings              ← `result.warnings` + {@link explainLimitations}
 *                             causes (deduped, each carrying its figure).
 *   - Recommended Workflows ← {@link recommendedWorkflows} (✓ / ⚠ / ✕).
 *   - Terrain Products      ← {@link terrainProducts} — the SAME view the
 *                             Analyse panel's products list renders, so the PDF
 *                             and the panel can never grade a product apart.
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
import { readinessLine } from '../quality/readinessEngine';
import { recommendedWorkflows, type WorkflowItem } from '../contour/recommendedWorkflow';
import { terrainProducts } from '../contour/terrainProducts';
import { explainLimitations } from '../contour/whyNotReasons';
import type { DatasetIntelligence } from '../datasetIntelligence';
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

/**
 * Options for {@link buildTerrainReportContent}. Extends the provenance options
 * (the same bundle every other export passes) with the OPTIONAL Dataset
 * Intelligence summary — the pure bucket view the Inspector card renders. When
 * absent / null the intelligence rows are simply omitted (honest: the report
 * never re-derives buckets the card did not show).
 */
export interface TerrainReportContentOptions extends ExportProvenanceOptions {
  readonly intelligence?: DatasetIntelligence | null;
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

/**
 * Assemble the Terrain Intelligence Report content from an analysis result. This
 * is a PURE PROJECTION of the existing modules — it computes nothing new. Missing
 * values are reported honestly (em-dash / "unknown"); the footer always carries
 * the not-survey-grade note. Deterministic given a fixed `generatedAt`.
 */
export function buildTerrainReportContent(
  result: AnalyseContoursResult,
  opts: TerrainReportContentOptions = {},
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

  // ── Executive Summary ───────────────────────────────────────────────────
  // The one-glance verdict a client reads first. Every fragment is an
  // assessment-minted string — status, reason, readiness, bestFor — joined
  // with the same " — " separator the provenance lines already use, so the
  // sentence can never carry prose the panel did not show.
  const executiveSummary: TerrainReportSection = {
    title: 'Executive Summary',
    rows: [
      { label: 'Verdict', value: `${assessment.status} — ${assessment.reason}` },
      {
        label: 'Export readiness',
        // The readiness engine's own "Tier — reason" formatting — identical
        // to the Export readiness provenance line stamped on every artifact.
        value: readinessLine(assessment.exportReadiness, assessment.exportReason),
      },
      { label: 'Best for', value: assessment.bestFor },
    ],
  };

  // ── Dataset Statistics ──────────────────────────────────────────────────
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

  // Dataset Intelligence bucket rows — present ONLY when the caller passed the
  // card's summary through. The labels are the card's own strings (already
  // honest: 'unknown' buckets render as "—"), so the PDF and the Inspector can
  // never disagree on a bucket.
  const intel = opts.intelligence ?? null;
  const intelligenceRows: TerrainReportRow[] = intel
    ? [
        { label: 'Point density (class)', value: intel.density.label },
        { label: 'Terrain complexity', value: intel.complexity.label },
        { label: 'Ground visibility', value: intel.groundVisibility.label },
        { label: 'Metric stability', value: intel.confidence.label },
      ]
    : [];

  const datasetStatistics: TerrainReportSection = {
    title: 'Dataset Statistics',
    rows: [
      { label: 'Scan', value: provenance.source ?? 'Untitled scan' },
      // These count the GROUND returns the bare-earth DTM was built from (from
      // the analysis sample), not the file's total points — labelled plainly so
      // the client never reads them as the scan's point count. The scan's
      // file-scale density is the 'Ground density' row below.
      { label: 'Ground points', value: fmtInt(dtm?.sourcePointCount) },
      { label: 'Used in DTM', value: fmtInt(dtm?.analyzedPointCount) },
      { label: 'Footprint (extent)', value: footprint },
      {
        label: 'Ground density',
        value: density != null ? `${density.toFixed(1)} pts/m²` : DASH,
      },
      ...intelligenceRows,
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
  // Derived complexity rows (v0.5.4) source the SAME pre-formatted strings
  // the provenance stamps and the Analyse panel renders (metric, window in
  // cells AND ground metres, Z units, derived confidence). A run that
  // measured nothing renders an honest em-dash, never a fabricated band.
  const cx = provenance.complexity;
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
      { label: 'Ruggedness (VRM)', value: cx ? cx.vrmText : DASH },
      { label: 'Landform (TPI)', value: cx ? cx.tpiText : DASH },
      {
        label: 'Complexity confidence',
        value: cx ? `${cx.confidence}/100 (derived from data support)` : DASH,
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
      // "-style (hold-out)" / "(estimated)": the report carries the same
      // qualifiers as the Analyse panel and the provenance stamp — hold-out
      // figures via the ASPRS formulas, never a checkpoint assessment.
      { label: 'NVA-style (95%, hold-out)', value: hasAcc ? fmtM(provenance.accuracy?.nvaM) : DASH },
      { label: 'VVA-style (95th pct, hold-out)', value: hasAcc ? fmtM(provenance.accuracy?.vvaM) : DASH },
      { label: 'USGS 3DEP Quality Level', value: qlValue === DASH ? DASH : `${qlValue} (estimated)` },
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
  // Complexity caveats (ordered): envelope warnings + the cited density-
  // reliability caveat, deduped against the run warnings.
  for (const w of cx?.caveats ?? []) pushWarn(w);
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

  // ── Terrain Products Available — the SAME view the panel renders ─────────
  // {@link terrainProducts} is the Analyse panel's products list (a pure
  // projection of the graded workflows). Reusing it verbatim — rather than
  // re-deriving availability from export readiness here — means the PDF lists
  // the same six products, with the same Ready/Preview/Blocked words and the
  // SAME engine-selected reason text (productReasonFor: the figure-quoting
  // surface line or the georef-gap export reason), as the on-screen card.
  // 'Ready' renames to 'Available' (the report speaks in take-away
  // vocabulary); Ready rows carry no reason in the view, so they carry no
  // note here either — a ready product needs no excuse.
  const products: TerrainReportProduct[] = terrainProducts(assessment, workflowItems).map(
    (p) =>
      p.statusWord === 'Ready' || p.reason == null
        ? { label: p.label, availability: p.statusWord === 'Ready' ? ('Available' as const) : p.statusWord }
        : { label: p.label, availability: p.statusWord, note: p.reason },
  );

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
      executiveSummary,
      datasetStatistics,
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
