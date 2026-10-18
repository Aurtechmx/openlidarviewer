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
 *   `grid-only`
 *       Web Mercator (EPSG:3857 and its aliases). The grid has a metre unit
 *       but a grid metre is not a ground metre: the scale grows as 1/cos φ,
 *       so a 100-unit segment at 60° N is about 50 m on the ground. Horizontal
 *       lengths, areas, slopes and volumes are refused; a pure height
 *       difference (the vertical axis) stays available.
 *
 *   `unsupported-frame`
 *       Geocentric (Earth-centred Cartesian) CRS. X/Y are not a ground plane
 *       and Z is not elevation, so every metric and elevation claim is refused.
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
  | 'grid-only'
  | 'unsupported-frame'
  | 'non-finite-unit';

/** EPSG codes for Web Mercator (Pseudo-Mercator) and its historical aliases. */
const WEB_MERCATOR_EPSG: ReadonlySet<number> = new Set([3857, 900913, 3785, 102100, 102113]);

/**
 * Whether `crs` is Web Mercator: a known code, or a WKT / name that says
 * Pseudo-Mercator or Popular Visualisation.
 */
export function isWebMercator(crs: Pick<ResolvedCrs, 'epsg' | 'name' | 'wkt'>): boolean {
  if (crs.epsg !== undefined && WEB_MERCATOR_EPSG.has(crs.epsg)) return true;
  const text = `${crs.name} ${crs.wkt ?? ''}`.toLowerCase();
  return /pseudo[ -_]?mercator|popular[ _]visuali[sz]ation/.test(text);
}

/** The refusal reason for a Web Mercator grid. */
export const WEB_MERCATOR_REASON =
  'Web Mercator grid units are not ground metres (the scale grows with latitude), so horizontal lengths, areas, slopes and volumes are refused.';

/** The refusal reason for a geocentric frame. */
export const GEOCENTRIC_REASON =
  'Geocentric CRS (Earth-centred X/Y/Z): X/Y are not a ground plane and Z is not elevation, so metric and elevation workflows refuse it.';

/** Whether a verdict refuses horizontal ground metrics while the frame itself is identified. */
export function refusesHorizontalGround(validity: CrsValidity): boolean {
  return validity === 'grid-only' || validity === 'unsupported-frame';
}

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
      if (isWebMercator(crs)) {
        return {
          validity: 'grid-only',
          severity: 'block',
          canDisplayMetric: false,
          canSaveMeasurement: false,
          reason: WEB_MERCATOR_REASON,
          suggestion: 'Reproject to a conformal local CRS (UTM, state plane) before measuring.',
        };
      }
      return {
        validity: 'safe-metric',
        severity: 'ok',
        canDisplayMetric: true,
        canSaveMeasurement: true,
        reason: `Projected CRS with linear unit ${crs.linearUnitByFactor ? `of ${crs.linearUnitToMetres} m` : crs.linearUnit}.`,
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

    case 'geocentric':
      return {
        validity: 'unsupported-frame',
        severity: 'block',
        canDisplayMetric: false,
        canSaveMeasurement: false,
        reason: GEOCENTRIC_REASON,
        suggestion: 'Reproject to a projected CRS with a vertical datum before measuring.',
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
