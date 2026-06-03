/**
 * CrsValidation.ts
 *
 * Pure-data answer to one practical question: "Is this CRS safe to do
 * metric measurements in?" The volume tool, the lasso volume tool, the
 * area / distance / height measurements, and the PDF report card all
 * need the same decision and they all need to surface the same caveats
 * — so the rule lives in one place.
 *
 * The verdict layer:
 *
 *   `safe-metric`
 *       Projected CRS with a known linear unit and a non-degenerate
 *       metres-per-unit ratio. Measurements display real cubic metres.
 *
 *   `safe-explicit-local`
 *       Local-coordinate dataset (phone scans, raw scanner output).
 *       Measurements display in source units, with no projection
 *       claim. The empty-state copy is "units assumed metres" — not
 *       "trust this for surveying".
 *
 *   `requires-projection`
 *       Geographic (lat/lon in degrees). Distance and volume in
 *       degrees is nonsense; the inspector must surface a "project
 *       before measuring" caveat AND the volume tool should refuse to
 *       claim a metric value without an explicit projection step.
 *
 *   `unknown-needs-confirmation`
 *       Confidence is `'none'` OR the kind is `'unknown'`. Block the
 *       cubic-metre headline; show the value as "—" with a "confirm CRS
 *       to measure" prompt.
 *
 *   `non-finite-unit`
 *       The CRS reports a `linearUnitToMetres` that is NaN, zero, or
 *       negative. Defensive — should be impossible from a well-formed
 *       VLR but easy to slip in from a hand-edited session file. We
 *       block the metric headline and surface a "linear unit invalid"
 *       reason.
 *
 * Pure, deterministic, allocation-light, importable in Node tests
 * with no DOM / proj4 stubbing.
 */

import type { ResolvedCrs } from './CoordinateTypes';

/** The verdict tags the inspector branches on. */
export type CrsValidity =
  | 'safe-metric'
  | 'safe-explicit-local'
  | 'requires-projection'
  | 'unknown-needs-confirmation'
  | 'non-finite-unit';

/** Severity of the verdict — drives the badge colour in the inspector. */
export type CrsValiditySeverity = 'ok' | 'caution' | 'warn' | 'block';

/** Structured outcome of `validateCrsForMeasurement`. */
export interface CrsValidationResult {
  /** The verdict tag. */
  readonly validity: CrsValidity;
  /** UI severity — `'ok'` is silent; everything else shows a badge. */
  readonly severity: CrsValiditySeverity;
  /** Whether the cubic-metre / square-metre headline is safe to display. */
  readonly canDisplayMetric: boolean;
  /**
   * Whether the volume tool should attach the result to the session.
   * `false` for `requires-projection` and `unknown-needs-confirmation`
   * so the user has to take a confirmation action (override the CRS,
   * project the dataset) before a misleading value is persisted.
   */
  readonly canSaveMeasurement: boolean;
  /** Human-readable reason, shown verbatim in the empty-state caveat. */
  readonly reason: string;
  /** Short next-step suggestion (e.g. "Choose a projected CRS"). */
  readonly suggestion: string;
}

/**
 * Classify a `ResolvedCrs` for measurement safety.
 *
 * The function intentionally does NOT consult `userConfirmed`. A user
 * who explicitly chose "treat as local" gets the `safe-explicit-local`
 * branch via `kind === 'local'`; a user who chose a projected CRS
 * gets `safe-metric` via `kind === 'projected'`. The override flag
 * matters for round-tripping in sessions, not for measurement gating.
 */
export function validateCrsForMeasurement(
  crs: ResolvedCrs | null | undefined,
): CrsValidationResult {
  // Defensive: a missing CRS is treated as unknown. Practically this
  // happens when the controller is wired before the loader has resolved
  // a CRS — a transient state, but the inspector reads better when the
  // verdict is structured rather than a thrown null.
  if (!crs) {
    return {
      validity: 'unknown-needs-confirmation',
      severity: 'warn',
      canDisplayMetric: false,
      canSaveMeasurement: false,
      reason: 'No CRS resolved for this scan yet.',
      suggestion: 'Wait for the loader to resolve a CRS, or pick one in the Inspector.',
    };
  }

  // ── Defensive: linear unit must be a positive real number. ──────────
  const ratio = crs.linearUnitToMetres;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return {
      validity: 'non-finite-unit',
      severity: 'block',
      canDisplayMetric: false,
      canSaveMeasurement: false,
      reason: `Linear unit ratio is invalid (${ratio}).`,
      suggestion: 'Pick a CRS in the Inspector — the loaded metadata is corrupt.',
    };
  }

  switch (crs.kind) {
    case 'projected':
      return {
        validity: 'safe-metric',
        severity: 'ok',
        canDisplayMetric: true,
        canSaveMeasurement: true,
        reason: `Projected CRS with linear unit ${crs.linearUnit}.`,
        suggestion: '',
      };

    case 'local':
      return {
        validity: 'safe-explicit-local',
        severity: 'caution',
        canDisplayMetric: true,
        canSaveMeasurement: true,
        reason:
          'Local coordinates — measurements assume the source units are metres.',
        suggestion:
          'For survey-grade values, pick a projected CRS in the Inspector.',
      };

    case 'geographic':
      return {
        validity: 'requires-projection',
        severity: 'warn',
        canDisplayMetric: false,
        canSaveMeasurement: false,
        reason:
          'Geographic CRS (lat/lon in degrees). Distance and volume in degrees are meaningless.',
        suggestion:
          'Pick a projected CRS (UTM, state plane, etc.) before measuring.',
      };

    case 'unknown':
      return {
        validity: 'unknown-needs-confirmation',
        severity: 'warn',
        canDisplayMetric: false,
        canSaveMeasurement: false,
        reason: 'No CRS metadata was detected for this scan.',
        suggestion:
          'Pick a CRS in the Inspector override panel before measuring.',
      };
  }
}

/**
 * Compact one-line CRS caveat for the volume / measurement headline,
 * tuned for the toast and panel-footer surfaces. Returns an empty
 * string when the verdict is `safe-metric` so callers can do
 * `if (caveat) hud.push(caveat)` without a special case.
 */
export function crsCaveatLine(result: CrsValidationResult): string {
  if (result.validity === 'safe-metric') return '';
  return result.reason;
}

/**
 * `true` when the inspector should NOT show a confident metric value
 * to the user. Sugar over `!canDisplayMetric` so call sites read
 * declaratively.
 */
export function shouldBlockMetricHeadline(result: CrsValidationResult): boolean {
  return !result.canDisplayMetric;
}
