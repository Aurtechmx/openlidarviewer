/**
 * contourLevelDefinition.ts
 *
 * Unit-safe contour level definitions (v0.5.9 spec §10). A contour interval and
 * base elevation are authored in the SOURCE vertical unit. This module records
 * both the source value and its metre equivalent — or `null` for the metre value
 * when the vertical unit is unknown, so no code downstream can present a
 * source-unit number as if it were real metres.
 *
 * It builds on the branded `units` primitives: `sourceUnits` rejects
 * non-finite input at the source, and `toMetresIfKnown` returns `null` exactly
 * when the unit is unknown — the type-level guard against the "unknown unit
 * branded as metres" bug the v0.5.8 work started closing.
 */

import {
  raw,
  sourceUnits,
  toMetresIfKnown,
  type LinearUnitScale,
} from '../../units/units';

export interface ContourLevelDefinition {
  /** Interval in the source vertical unit (always finite, > 0). */
  readonly intervalSource: number;
  /** Interval in metres, or null when the vertical unit is unknown. */
  readonly intervalMetres: number | null;
  /** Base elevation the level sequence is anchored to, in source units. */
  readonly baseSource: number;
  /** Base in metres, or null when the vertical unit is unknown. */
  readonly baseMetres: number | null;
  /** Unit label to show ('m', 'ft', …), or '' when the unit is unknown. */
  readonly sourceUnitLabel: string;
  readonly verticalUnitStatus: 'known' | 'unknown';
}

export interface ContourLevelInput {
  readonly intervalSource: number;
  readonly baseSource: number;
  /** The vertical unit scale (known metres-per-unit, or unknown). */
  readonly verticalUnit: LinearUnitScale;
  /** Label for the known unit, e.g. 'm' or 'ft'. Ignored when unit is unknown. */
  readonly sourceUnitLabel: string;
}

/**
 * Build a unit-safe level definition. Throws (via the branded constructor) on a
 * non-finite interval or base, and on a non-positive interval — a zero or
 * negative interval cannot generate levels. The metre fields are populated only
 * when the unit is known.
 */
export function buildContourLevelDefinition(
  input: ContourLevelInput,
): ContourLevelDefinition {
  const interval = sourceUnits(input.intervalSource); // rejects NaN / ±Infinity
  if (raw(interval) <= 0) {
    throw new RangeError('Contour interval must be a positive, finite number.');
  }
  const base = sourceUnits(input.baseSource); // rejects NaN / ±Infinity (may be < 0)
  const intervalM = toMetresIfKnown(interval, input.verticalUnit);
  const baseM = toMetresIfKnown(base, input.verticalUnit);
  const known = input.verticalUnit.known;
  return {
    intervalSource: raw(interval),
    intervalMetres: intervalM === null ? null : raw(intervalM),
    baseSource: raw(base),
    baseMetres: baseM === null ? null : raw(baseM),
    // No unit label is claimed when the unit is unknown.
    sourceUnitLabel: known ? input.sourceUnitLabel : '',
    verticalUnitStatus: known ? 'known' : 'unknown',
  };
}

export type ContourUnitClaim = 'metric-supported' | 'cartographic-only';

/**
 * Whether metric-supported contour intervals may be claimed for this level set
 * (spec §10.2/§10.3). Requires BOTH a known vertical unit AND a projected
 * (linear) horizontal frame — a geographic CRS measures the plane in degrees, so
 * its contours are cartographic (visual) only, never metric-supported. Unknown
 * vertical units likewise cap to cartographic-only.
 */
export function contourUnitClaim(
  def: ContourLevelDefinition,
  opts: { readonly crsProjected: boolean },
): ContourUnitClaim {
  return def.verticalUnitStatus === 'known' && opts.crsProjected
    ? 'metric-supported'
    : 'cartographic-only';
}

const FOOT_LABELS = new Set(['ft', 'foot', 'feet', 'us-ft', 'usft']);
function isFootLabel(label: string): boolean {
  return FOOT_LABELS.has(label.trim().toLowerCase());
}

function trimNum(n: number): string {
  // Compact, locale-independent: up to 3 decimals, no trailing zeros.
  return Number.parseFloat(n.toFixed(3)).toString();
}

/**
 * Display string for the interval (spec §10.2): metres show metres, feet show
 * feet plus the metric equivalent, and an unknown unit shows the bare value with
 * an explicit "units unverified" note — never a fabricated metre suffix.
 */
export function formatContourInterval(def: ContourLevelDefinition): string {
  if (def.verticalUnitStatus === 'unknown') {
    return `${trimNum(def.intervalSource)} (units unverified)`;
  }
  if (isFootLabel(def.sourceUnitLabel) && def.intervalMetres != null) {
    return `${trimNum(def.intervalSource)} ${def.sourceUnitLabel} (${trimNum(def.intervalMetres)} m)`;
  }
  return `${trimNum(def.intervalSource)} ${def.sourceUnitLabel}`.trimEnd();
}

/**
 * Export-visible unit fields (spec §10.1 stored + §21.1 vector attributes),
 * honest by construction: metre fields are null when the unit is unknown, and
 * the elevation unit is reported as 'unknown' rather than assumed.
 */
export function contourLevelExportFields(
  def: ContourLevelDefinition,
): Readonly<Record<string, string | number | null>> {
  return {
    interval_source: def.intervalSource,
    interval_m: def.intervalMetres,
    base_source: def.baseSource,
    base_m: def.baseMetres,
    elevation_unit: def.sourceUnitLabel || 'unknown',
    vertical_unit_status: def.verticalUnitStatus,
  };
}
