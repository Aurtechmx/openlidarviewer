/**
 * contourDeliverableJson.ts
 *
 * The two JSON products of the complete contour package that carry already-
 * computed facts, not new geometry: Validation.json (the hold-out validation
 * figures + their scope) and ContourStudio.json (the exact generation settings
 * that produced the deliverable). Both are pure: they reshape values the
 * analysis already holds into a stable, honest JSON object — no fabrication, no
 * I/O. Non-finite statistics become `null` rather than `NaN`, and the validation
 * object states plainly that its accuracy is internal hold-out, not external.
 */

import type { ValidationReport } from '../validate/ValidationReport';
import type { AnalyseGenerationParams } from '../contour/analyseContours';

/** A finite number, or null — so a `NaN`/`Infinity` statistic never ships as a bare value. */
function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/**
 * The Validation.json payload: the hold-out figures with their estimand and an
 * explicit statement of scope. Deliberately omits the raw per-point `samples`
 * (a calibration input, not a deliverable). `independentCheckpoints` is always
 * false here — this package supplies no external field checkpoints.
 */
export function validationDeliverableJson(v: ValidationReport): Record<string, unknown> {
  return {
    schemaVersion: VALIDATION_JSON_SCHEMA,
    estimand: v.estimand,
    method: v.method,
    coverageMode: v.coverageMode,
    rmse: finiteOrNull(v.rmse),
    mae: finiteOrNull(v.mae),
    p95: finiteOrNull(v.p95),
    bias: finiteOrNull(v.bias),
    nmad: finiteOrNull(v.nmad),
    sampleSize: v.sampleSize,
    uncoveredCount: v.uncoveredCount,
    holdoutFraction: v.holdoutFraction,
    perBand: v.perBand,
    perSlopeBand: v.perSlopeBand ?? null,
    perZone: v.perZone ?? null,
    warnings: v.warnings,
    independentCheckpoints: false,
    scope: 'Internal hold-out validation only; no independent field checkpoints. Not survey-grade.',
  };
}

/** Provenance/context stamped alongside the raw generation settings. */
export interface ContourStudioJsonContext {
  /** The registered contour geometry method as `id@version`, or null. */
  readonly contourMethod: string | null;
  /** The Contour Studio purpose that produced the deliverable, or null. */
  readonly purpose: string | null;
  /** The contour interval, in the SOURCE vertical unit (see {@link intervalUnit}). */
  readonly interval: number;
  /** The vertical unit the interval is in — `m` / `ft` / `ftUS` / `units` / `unknown`. */
  readonly intervalUnit: string;
  /**
   * Metres per vertical unit, when the source declares a resolvable vertical
   * unit — used to emit an SI `intervalMetres` alongside the source value. Null
   * when the unit is unknown, so no fake metre value is written.
   */
  readonly verticalUnitToMetres: number | null;
  readonly software: string;
  readonly softwareVersion: string;
  /** ISO timestamp the deliverable was generated. */
  readonly generatedAt: string;
}

/** Schema version of the {@link contourStudioDeliverableJson} payload. */
export const CONTOUR_STUDIO_JSON_SCHEMA = 2;
/** Schema version of the {@link validationDeliverableJson} payload. */
export const VALIDATION_JSON_SCHEMA = 1;

/**
 * The ContourStudio.json payload: the exact settings that produced this
 * deliverable, so the run can be understood and repeated. Reads the real
 * generation params (never a default) plus the method/purpose/build context.
 */
export function contourStudioDeliverableJson(
  params: AnalyseGenerationParams,
  ctx: ContourStudioJsonContext,
): Record<string, unknown> {
  const interval = finiteOrNull(ctx.interval);
  // SI value ONLY when the vertical unit resolves — an unknown unit ships no
  // metre value rather than a source-unit number in a metre-labelled field.
  const intervalMetres =
    interval !== null && ctx.verticalUnitToMetres != null && Number.isFinite(ctx.verticalUnitToMetres)
      ? interval * ctx.verticalUnitToMetres
      : null;
  return {
    schemaVersion: CONTOUR_STUDIO_JSON_SCHEMA,
    contourMethod: ctx.contourMethod,
    purpose: ctx.purpose,
    interval,
    intervalUnit: ctx.intervalUnit,
    intervalMetres,
    contourStyle: params.contourStyle,
    interpolation: params.interpolation,
    aggregation: params.aggregation,
    generalizeToleranceCells: params.generalizeToleranceCells ?? null,
    smoothing: params.smoothing,
    despike: params.despike,
    software: ctx.software,
    softwareVersion: ctx.softwareVersion,
    generatedAt: ctx.generatedAt,
  };
}
