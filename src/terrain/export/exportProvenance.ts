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
import { contourShapeStyleLabel, type ContourShapeStyle } from '../contour/contourShapeStyle';

/** Producing software name — single source of truth for every export stamp. */
export const SOFTWARE_NAME = 'OpenLiDARViewer';

/**
 * The standing honesty note stamped on every artifact. Deliberately phrased as
 * fitness-for-use, never an affirmative survey-grade claim.
 */
export const NOT_SURVEY_GRADE_NOTE =
  'Fitness-for-use; not survey-grade unless validated against control.';

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

  return {
    software: SOFTWARE_NAME,
    softwareVersion: opts.softwareVersion ?? 'unknown',
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
    pointDensityPerM2,
    measuredCells: tally ? tally.measured : null,
    totalCells: tally ? tally.total : null,
    classScope: opts.classScope ?? null,
    warnings: result.warnings ?? [],
    notSurveyGrade: NOT_SURVEY_GRADE_NOTE,
  };
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
    kv('Metric version', p.metricVersion),
    kv('Generated', p.generated),
    kv('Source', p.source ?? 'unknown'),
    kv('Horizontal CRS', p.horizontalCrs),
    kv('Vertical datum', p.verticalDatum),
    kv('Coverage', p.coverageMode),
    kv('Contour interval', p.contourIntervalM != null ? `${p.contourIntervalM} m` : 'none'),
    kv('Contour style', p.contourStyleLabel),
    kv('Surface quality', p.surfaceQuality),
    kv(
      'Export readiness',
      p.exportReason ? `${p.exportReadiness} — ${p.exportReason}` : p.exportReadiness,
    ),
    kv('Vertical RMSEz', p.accuracy ? fmtM(p.accuracy.rmseZM) : 'unknown'),
    kv('NVA (95%)', p.accuracy ? fmtM(p.accuracy.nvaM) : 'unknown'),
    kv('VVA (95th pct)', p.accuracy ? fmtM(p.accuracy.vvaM) : 'unknown'),
    kv('USGS 3DEP', p.accuracy ? p.accuracy.usgsQualityLevel : 'unknown'),
    kv(
      'Point density',
      p.pointDensityPerM2 != null ? `${p.pointDensityPerM2.toFixed(1)} pts/m²` : 'unknown',
    ),
  ];
  if (p.classScope) lines.push(kv('Class scope', p.classScope));
  lines.push(kv('Note', p.notSurveyGrade));
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
    pointDensityPerM2: p.pointDensityPerM2,
    measuredCells: p.measuredCells,
    totalCells: p.totalCells,
    classScope: p.classScope,
    warnings: [...p.warnings],
    notSurveyGrade: p.notSurveyGrade,
  };
}
