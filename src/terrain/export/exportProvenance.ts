/**
 * exportProvenance.ts
 *
 * ONE provenance object for EVERY contour / terrain export. Before this module
 * each exporter stamped its own ad-hoc subset of metadata — GeoJSON carried a
 * lone `contourStyle`, DXF / SVG a single style comment, the DEM README a rich
 * block, the map sheet its own title-block rows — so the same scan could
 * describe itself five slightly different ways. This collapses all of that into
 * a single {@link ExportProvenance} derived ONCE from the analysis run, plus two
 * formatters so every artifact carries word-for-word identical provenance:
 *
 *   - {@link provenanceLines} — plain `Key  Value` lines for text / DXF / SVG /
 *     README stamps.
 *   - {@link provenanceJson} — a structured record for the GeoJSON `metadata`.
 *
 * Honesty contract (non-negotiable, mirrors the rest of the terrain stack):
 *   - We NEVER claim survey-grade. Every artifact carries the export-readiness
 *     verdict + its reason and the standing not-survey-grade note, so a preview
 *     / blocked export can never read as a finished, certified deliverable.
 *   - Where a value is genuinely absent we say "unknown" / "not georeferenced" /
 *     "none" — we never fabricate a CRS, datum, interval, style or accuracy.
 *
 * The Surface-Quality and Export-Readiness verdicts are sourced from
 * {@link terrainAssessment} — the SAME top-level verdict the panel shows the
 * user — so an exported file can never disagree with what was on screen.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic given a fixed
 * `generatedAt`.
 */

import type { AnalyseContoursResult } from '../contour/analyseContours';
import {
  terrainAssessment,
  type TerrainStatus,
  type ExportReadinessStatus,
} from '../contour/terrainAssessment';
import { readinessLine } from '../quality/readinessEngine';
import { contourShapeStyleLabel, type ContourShapeStyle } from '../contour/contourShapeStyle';
import { exportGate } from '../../validation/evidenceRegistry';
import { buildIdentityProvenance } from '../../build/buildIdentity';
import { methodTag } from '../../science/methodRegistry';
import {
  buildScientificAnalysisRecord,
  scientificRecordJson,
  type ScientificAnalysisRecord,
} from '../../science/scientificAnalysisRecord';

/** Producing software name — single source of truth for every export stamp. */
export const SOFTWARE_NAME = 'OpenLiDARViewer';

/**
 * The standing honesty note stamped on every artifact. Plain language about
 * what the output is suitable for — never an affirmative survey-grade claim.
 * (v0.4.5 wording: the previous "Fitness-for-use" QA jargon confused users.)
 */
export const NOT_SURVEY_GRADE_NOTE =
  'Suitability: not survey-grade unless validated against ground-truth control.';

/**
 * The evidence-gate note, DERIVED from the runtime evidence registry (not
 * asserted): the terrain raster products are all below their required evidence
 * level today, so `exportGate` marks every terrain export exploratory. Stamped
 * on the artifact so a downstream reader sees the gate verdict, per the evidence
 * model. When a product reaches its required level the note flips automatically.
 */
export const EVIDENCE_GATE_NOTE: string = exportGate('DTM').exploratoryOnly
  ? 'Evidence: exploratory export. Terrain products are validated only against synthetic known-truth (pre-E4) — not cross-validated against an independent tool, and not field-validated. Do not present as a validated deliverable.'
  : 'Evidence: meets the required validation level for this product.';

/**
 * Derived terrain-complexity record (v0.5.4), present only when the run
 * measured it. Reproducible parameters by construction: metric names,
 * window/radius in CELLS and ground METRES, TPI's Z unit, the slope/aspect
 * convention note, the derived confidence, and the ordered caveats
 * (including the cited density-reliability warning). The display strings
 * (`vrmText` / `tpiText`) are the SAME pre-formatted strings the panel and
 * card render, so no artifact can word the figures apart.
 */
export interface ExportProvenanceComplexity {
  /** VRM median over valid cells (Sappington et al. 2007), dimensionless. */
  readonly vrmMedian: number;
  /** VRM interquartile range (dispersion is mandatory). */
  readonly vrmIqr: number;
  /** VRM moving-window edge length in cells (3 = 3×3). */
  readonly vrmWindowCells: number;
  /** VRM window edge in ground metres, or null when metres were unknown. */
  readonly vrmWindowGroundM: number | null;
  /** 'median 0.0340 [IQR 0.0210], 3×3-cell window (≈3 m), dimensionless'. */
  readonly vrmText: string;
  /** TPI neighbourhood radius in cells (Weiss 2001). */
  readonly tpiRadiusCells: number;
  /** TPI radius in ground metres, or null when metres were unknown. */
  readonly tpiRadiusGroundM: number | null;
  /** Dominant Weiss slope-position class name, or null when not derived. */
  readonly tpiDominantClass: string | null;
  /** The TPI display line (dominant class, median [IQR] + Z unit, radius). */
  readonly tpiText: string;
  /** Z unit TPI is expressed in ('m' / 'ft' / 'z-units'). */
  readonly zUnit: string;
  /** Slope/aspect convention + metric definitions note. */
  readonly convention: string;
  /** Derived 0–100 confidence (valid fraction × window support, min of cores). */
  readonly confidence: number;
  /** Ordered caveats, incl. the cited < 4 pts/m² density-reliability warning. */
  readonly caveats: ReadonlyArray<string>;
}

/** Validated vertical-accuracy figures, present only when the run measured them. */
export interface ExportProvenanceAccuracy {
  /** Vertical RMSEz in metres. */
  readonly rmseZM: number | null;
  /** Non-vegetated Vertical Accuracy (95% conf) in metres. */
  readonly nvaM: number | null;
  /** Vegetated Vertical Accuracy (95th pct) in metres. */
  readonly vvaM: number | null;
  /** USGS 3DEP Quality Level (e.g. 'QL2'), or 'unknown'. */
  readonly usgsQualityLevel: string;
}

/**
 * The unified provenance of one analysis run, stamped identically into every
 * export. Absent values are honest: `null` / "unknown" / "not georeferenced".
 */
export interface ExportProvenance {
  /** Producing software name ('OpenLiDARViewer'). */
  readonly software: string;
  /** Producing software version (the `__APP_VERSION__` Vite stamps). */
  readonly softwareVersion: string;
  /**
   * Exact build identity that produced the artifact — version, commit, channel
   * and build time (from {@link buildIdentityProvenance}). Records which BUILD,
   * not just which release, so two builds of the same version stay traceable.
   */
  readonly build: string;
  /** Terrain metric version (e.g. 'v0.4.1'). */
  readonly metricVersion: string;
  /** ISO 8601 generation timestamp. */
  readonly generated: string;
  /** Source scan basename, or null when not supplied. */
  readonly source: string | null;
  /** Horizontal CRS string, or the literal 'not georeferenced' when unknown. */
  readonly horizontalCrs: string;
  /** True when a horizontal CRS is known. */
  readonly crsKnown: boolean;
  /** Vertical datum string, or the literal 'unknown' when unknown. */
  readonly verticalDatum: string;
  /** True when a vertical datum is known. */
  readonly datumKnown: boolean;
  /** Coverage mode ('full' / 'resident-only' / 'sampled' / 'unknown'). */
  readonly coverageMode: string;
  /** Contour interval (source units), or null when none was chosen. */
  readonly contourIntervalM: number | null;
  /** Contour shape style the geometry was produced with, or null when unknown. */
  readonly contourStyle: ContourShapeStyle | null;
  /** Human label for {@link contourStyle}, or 'unknown'. */
  readonly contourStyleLabel: string;
  /** Surface-quality verdict (Good / Preview / Limited / Blocked). */
  readonly surfaceQuality: TerrainStatus;
  /** Export-readiness verdict (Ready / Preview / Blocked). */
  readonly exportReadiness: ExportReadinessStatus;
  /** Why export readiness sits below Ready, or '' when Ready. */
  readonly exportReason: string;
  /** Validated accuracy, or null when the run could not measure it. */
  readonly accuracy: ExportProvenanceAccuracy | null;
  /** Derived terrain complexity, or null when the run measured none. */
  readonly complexity: ExportProvenanceComplexity | null;
  /** Mean ground returns per square metre, or null when unknown. */
  readonly pointDensityPerM2: number | null;
  /** Measured DTM cell count, or null when unavailable on the result. */
  readonly measuredCells: number | null;
  /** Total DTM cell count, or null when unavailable on the result. */
  readonly totalCells: number | null;
  /** Active class-filter scope (optional), or null when no filter was applied. */
  readonly classScope: string | null;
  /** The run's warnings (ordered, as produced by the pipeline). */
  readonly warnings: ReadonlyArray<string>;
  /** The standing not-survey-grade note ({@link NOT_SURVEY_GRADE_NOTE}). */
  readonly notSurveyGrade: string;
}

/** Options for {@link buildExportProvenance}. */
export interface ExportProvenanceOptions {
  /** Source scan basename (the downloaded-file base). */
  readonly basename?: string | null;
  /** Generation timestamp — a `Date` or ISO string. Default `new Date()`. */
  readonly generatedAt?: Date | string | null;
  /** Producing software version. Default 'unknown'. */
  readonly softwareVersion?: string | null;
  /** Terrain metric version. Default 'unknown'. */
  readonly metricVersion?: string | null;
  /** Active class-filter scope description, when a filter is in effect. */
  readonly classScope?: string | null;
}

/** Resolve the generation timestamp to an ISO string. */
function toIso(at: Date | string | null | undefined): string {
  if (at instanceof Date) return at.toISOString();
  if (typeof at === 'string' && at.length > 0) return at;
  return new Date().toISOString();
}

/**
 * Derive the single provenance object from an analysis result. SINGLE SOURCE OF
 * TRUTH — every exporter stamps from this so the values can never drift apart.
 * Missing values are reported honestly (never fabricated). Deterministic given a
 * fixed `generatedAt`.
 */
export function buildExportProvenance(
  result: AnalyseContoursResult,
  opts: ExportProvenanceOptions = {},
): ExportProvenance {
  // Surface-quality + export-readiness verdicts come from the SAME top-level
  // assessment the panel renders, so a file never disagrees with the UI.
  const assessment = terrainAssessment(result);

  // Resolve georeferencing + geometry provenance from the most reliable fields:
  // the DTM carries the resolved CRS / datum / coverage; the generation params
  // carry the style the geometry was actually produced with.
  const dtm = result.dtm;
  const crs = dtm?.crs ?? result.model?.crs ?? null;
  const datum = dtm?.verticalDatum ?? result.model?.verticalDatum ?? null;
  const coverageMode = dtm?.coverageMode ?? result.model?.coverageMode ?? 'unknown';
  const style =
    result.generationParams?.contourStyle ?? result.model?.contourStyle ?? null;
  const intervalM = result.intervalM ?? result.model?.intervalM ?? null;

  // Accuracy is present only when the hold-out validation measured an RMSEz;
  // otherwise the whole block is null (never a fabricated zero).
  const acc = result.accuracyStandards ?? null;
  const accuracy: ExportProvenanceAccuracy | null =
    acc && acc.rmseZM != null && Number.isFinite(acc.rmseZM)
      ? {
          rmseZM: acc.rmseZM,
          nvaM: acc.nvaM ?? null,
          vvaM: acc.vvaM ?? null,
          usgsQualityLevel: acc.qualityLevel ?? 'unknown',
        }
      : null;
  const pointDensityPerM2 =
    acc && Number.isFinite(acc.pointDensityPerM2) && acc.pointDensityPerM2 > 0
      ? acc.pointDensityPerM2
      : null;

  const tally = result.cellStatusTally ?? null;

  // Derived complexity — present only when the run produced a banded summary
  // (a run that measured nothing stays null: no fabricated figures). The
  // fields are a straight projection of the summary the core computed.
  const cx = result.complexity ?? null;
  const complexity: ExportProvenanceComplexity | null =
    cx && cx.band != null
      ? {
          vrmMedian: cx.vrmMedian,
          vrmIqr: cx.vrmIqr,
          vrmWindowCells: cx.vrmWindowCells,
          vrmWindowGroundM: cx.vrmWindowGroundM,
          vrmText: cx.vrmText,
          tpiRadiusCells: cx.tpiRadiusCells,
          tpiRadiusGroundM: cx.tpiRadiusGroundM,
          tpiDominantClass: cx.tpiDominantClass,
          tpiText: cx.tpiText,
          zUnit: cx.zUnitLabel,
          convention: cx.slopeAspectConvention,
          confidence: cx.confidence,
          caveats: [...cx.warnings],
        }
      : null;

  return {
    software: SOFTWARE_NAME,
    softwareVersion: opts.softwareVersion ?? 'unknown',
    build: buildIdentityProvenance(),
    metricVersion: opts.metricVersion ?? 'unknown',
    generated: toIso(opts.generatedAt),
    source: opts.basename ?? null,
    horizontalCrs: crs ?? 'not georeferenced',
    crsKnown: crs != null,
    verticalDatum: datum ?? 'unknown',
    datumKnown: datum != null,
    coverageMode,
    contourIntervalM: intervalM,
    contourStyle: style,
    contourStyleLabel: style ? contourShapeStyleLabel(style) : 'unknown',
    surfaceQuality: assessment.status,
    exportReadiness: assessment.exportReadiness,
    exportReason: assessment.exportReason,
    accuracy,
    complexity,
    pointDensityPerM2,
    measuredCells: tally ? tally.measured : null,
    totalCells: tally ? tally.total : null,
    classScope: opts.classScope ?? null,
    warnings: result.warnings ?? [],
    notSurveyGrade: NOT_SURVEY_GRADE_NOTE,
  };
}

/**
 * The registered methods a DTM/terrain export actually ran, derived from what
 * the provenance shows was computed. Ground extraction + gridded surface are
 * always present; the hold-out accuracy and complexity methods appear only when
 * the run produced those figures. (Spatial-block and reliability estimators run
 * on the analysis result, not on this provenance object; wiring their ids in is
 * a follow-up when the record is built from the result directly.)
 */
function terrainMethodIds(p: ExportProvenance): string[] {
  const ids = ['olv.ground.smrf', 'olv.dtm.idw-fill'];
  if (p.accuracy) ids.push('olv.validation.holdout-rmse');
  if (p.complexity) ids.push('olv.terrain.vrm', 'olv.terrain.tpi', 'olv.terrain.slope-horn');
  return ids;
}

/**
 * Derive the canonical {@link ScientificAnalysisRecord} for a terrain export
 * from its provenance — the FIRST consumer of the record (PR3). The linear unit
 * is intentionally omitted: this provenance object does not carry the resolved
 * unit token, and the record never fabricates one (a later step threads it from
 * the analysis result).
 */
export function analysisRecordFromProvenance(p: ExportProvenance): ScientificAnalysisRecord {
  return buildScientificAnalysisRecord({
    kind: 'terrain-dtm',
    source: p.source,
    generatedAt: p.generated,
    crs: {
      horizontal: p.horizontalCrs,
      horizontalKnown: p.crsKnown,
      verticalDatum: p.verticalDatum,
      verticalDatumKnown: p.datumKnown,
    },
    methodIds: terrainMethodIds(p),
    evidenceExploratory: exportGate('DTM').exploratoryOnly,
    summary: {
      surfaceQuality: p.surfaceQuality,
      exportReadiness: p.exportReadiness,
      rmseZM: p.accuracy?.rmseZM ?? null,
      usgsQualityLevel: p.accuracy?.usgsQualityLevel ?? 'unknown',
      pointDensityPerM2: p.pointDensityPerM2,
      measuredCells: p.measuredCells,
      totalCells: p.totalCells,
    },
  });
}

/** Format a metre value at 2 dp, or an em-dash when absent. */
function fmtM(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? `${v.toFixed(2)} m` : '—';
}

const KEY_WIDTH = 18;
function kv(key: string, value: string): string {
  return `${key.padEnd(KEY_WIDTH)}${value}`;
}

/**
 * Render the provenance as plain `Key  Value` lines for text stamps (DXF 999
 * comments, SVG metadata, the DEM README). The wording is identical to the
 * structured {@link provenanceJson} so every format agrees verbatim.
 */
export function provenanceLines(p: ExportProvenance): string[] {
  const lines: string[] = [
    kv('Software', `${p.software} ${p.softwareVersion}`),
    kv('Build', p.build),
    kv('Metric version', p.metricVersion),
    kv('Generated', p.generated),
    kv('Source', p.source ?? 'unknown'),
    kv('Horizontal CRS', p.horizontalCrs),
    kv('Vertical datum', p.verticalDatum),
    kv('Coverage', p.coverageMode),
    kv('Contour interval', p.contourIntervalM != null ? `${p.contourIntervalM} m` : 'none'),
    kv('Contour style', p.contourStyleLabel),
    kv('Surface quality', p.surfaceQuality),
    // The "Tier — reason" formatting is the readiness engine's, so this stamp
    // and the Terrain Intelligence Report row can never word the verdict apart.
    kv('Export readiness', readinessLine(p.exportReadiness, p.exportReason)),
    kv('Vertical RMSEz', p.accuracy ? fmtM(p.accuracy.rmseZM) : 'unknown'),
    // "-style (hold-out)": the stamp states the figures' true strength —
    // ASPRS 2014 FORMULAS on internally withheld points, not independent
    // checkpoints (see verticalAccuracy.ts for the honesty boundary).
    kv('NVA-style (95%, hold-out)', p.accuracy ? fmtM(p.accuracy.nvaM) : 'unknown'),
    kv('VVA-style (95th pct, hold-out)', p.accuracy ? fmtM(p.accuracy.vvaM) : 'unknown'),
    // "(estimated)" mirrors the panel chip: the QL's RMSEz leg is hold-out-
    // based (withheld points, not independent checkpoints), so the stamped
    // grade must carry the same qualifier the screen does.
    kv(
      'USGS 3DEP',
      p.accuracy && p.accuracy.usgsQualityLevel !== 'unknown'
        ? `${p.accuracy.usgsQualityLevel} (estimated)`
        : 'unknown',
    ),
    kv(
      'Point density',
      p.pointDensityPerM2 != null ? `${p.pointDensityPerM2.toFixed(1)} pts/m²` : 'unknown',
    ),
  ];
  // Derived complexity (v0.5.4): metric, window/radius in cells AND ground
  // metres, Z units and the convention note — reproducible parameters, worded
  // identically to the panel/card (the texts are the same strings).
  if (p.complexity) {
    lines.push(
      kv('Ruggedness (VRM)', p.complexity.vrmText),
      kv('Landform (TPI)', p.complexity.tpiText),
      kv('Convention', p.complexity.convention),
      kv('Complexity conf.', `${p.complexity.confidence}/100 (derived from data support)`),
    );
  }
  if (p.classScope) lines.push(kv('Class scope', p.classScope));
  // The registered methods (id@version) that produced these figures, so a reader
  // can trace each number to the algorithm and revision behind it.
  const record = analysisRecordFromProvenance(p);
  lines.push(kv('Methods', record.methods.map(methodTag).join(', ')));
  lines.push(kv('Record', `schema ${record.schemaVersion} · ${record.contentHash}`));
  lines.push(kv('Note', p.notSurveyGrade));
  lines.push(kv('Evidence', EVIDENCE_GATE_NOTE));
  return lines;
}

/**
 * Render the provenance as a structured record for the GeoJSON `metadata`
 * member. The human-readable values (CRS, datum, style label, verdicts,
 * accuracy) match {@link provenanceLines} exactly.
 */
export function provenanceJson(p: ExportProvenance): Record<string, unknown> {
  return {
    software: p.software,
    softwareVersion: p.softwareVersion,
    build: p.build,
    metricVersion: p.metricVersion,
    generated: p.generated,
    source: p.source,
    horizontalCrs: p.horizontalCrs,
    crsKnown: p.crsKnown,
    verticalDatum: p.verticalDatum,
    datumKnown: p.datumKnown,
    coverageMode: p.coverageMode,
    contourIntervalM: p.contourIntervalM,
    contourStyle: p.contourStyle,
    contourStyleLabel: p.contourStyleLabel,
    surfaceQuality: p.surfaceQuality,
    exportReadiness: p.exportReadiness,
    exportReason: p.exportReason,
    accuracy: p.accuracy
      ? {
          rmseZM: p.accuracy.rmseZM,
          nvaM: p.accuracy.nvaM,
          vvaM: p.accuracy.vvaM,
          usgsQualityLevel: p.accuracy.usgsQualityLevel,
        }
      : null,
    // The record is already plain data — copy it wholesale (fresh caveats
    // array so the JSON owns its own copy).
    complexity: p.complexity ? { ...p.complexity, caveats: [...p.complexity.caveats] } : null,
    pointDensityPerM2: p.pointDensityPerM2,
    measuredCells: p.measuredCells,
    totalCells: p.totalCells,
    classScope: p.classScope,
    warnings: [...p.warnings],
    notSurveyGrade: p.notSurveyGrade,
    evidence: EVIDENCE_GATE_NOTE,
    // The canonical analysis record (PR3): the single structure every output can
    // derive from — build, CRS, registered methods, evidence verdict, a summary,
    // and a build-stable content fingerprint.
    record: scientificRecordJson(analysisRecordFromProvenance(p)),
  };
}
