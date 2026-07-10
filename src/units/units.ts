/**
 * units.ts
 *
 * Compile-time unit safety for the measurement and CRS boundaries. A recurring
 * class of bug in this codebase has been mixing a raw source-unit coordinate
 * (US survey feet, an ungeoreferenced local unit) with a value the rest of the
 * app treats as metres. The numbers are both `number`, so the compiler never
 * caught it; the fixes were all runtime (native→metres reconciliation in the
 * lasso toast, the scan report, the export path).
 *
 * These branded types make that mistake a type error instead. A `Metres` and a
 * `SourceUnits` are both a `number` at runtime (zero cost), but the compiler
 * refuses to pass one where the other is required. Conversion is explicit and
 * one-directional through the named helpers, so every unit change is visible in
 * the source.
 *
 * Pure, deterministic, no dependencies. Runtime behaviour is identical to the
 * bare numbers; the whole value is at compile time.
 */

declare const unitBrand: unique symbol;
type Branded<B extends string> = number & { readonly [unitBrand]: B };

/** A length in metres — the app's canonical linear unit. */
export type Metres = Branded<'Metres'>;
/** A length in international feet (1 ft = 0.3048 m exactly). */
export type Feet = Branded<'Feet'>;
/** A length in the source file's own linear unit, before any conversion. */
export type SourceUnits = Branded<'SourceUnits'>;
/** An angle in degrees. */
export type Degrees = Branded<'Degrees'>;
/** An angle in radians. */
export type Radians = Branded<'Radians'>;
/** An area in square metres. */
export type SqMetres = Branded<'SqMetres'>;
/** A volume in cubic metres. */
export type CubicMetres = Branded<'CubicMetres'>;

/**
 * Reject a non-finite value at the point a unit is asserted. A NaN / Infinity
 * measurement is never valid physical data; catching it at construction turns a
 * silent poison value (that propagates through every downstream computation) into
 * a loud error at its source.
 */
function finite(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`unit value must be finite, got ${n}`);
  return n;
}

// ── Constructors. Assert the unit of a raw number at the point it is known. ──
export const metres = (n: number): Metres => finite(n) as Metres;
export const feet = (n: number): Feet => finite(n) as Feet;
export const sourceUnits = (n: number): SourceUnits => finite(n) as SourceUnits;
export const degrees = (n: number): Degrees => finite(n) as Degrees;
export const radians = (n: number): Radians => finite(n) as Radians;
export const sqMetres = (n: number): SqMetres => finite(n) as SqMetres;
export const cubicMetres = (n: number): CubicMetres => finite(n) as CubicMetres;

/** Drop the brand to hand a plain number to formatting / rendering / IO. */
export const raw = (v: Branded<string>): number => v;

// ── Exact conversion factors. ────────────────────────────────────────────────
/** International foot: 1 ft = 0.3048 m exactly. */
const M_PER_FT = 0.3048;
/** US survey foot: 1 ft = 1200/3937 m exactly (differs from intl foot by ~2 ppm). */
const M_PER_US_FT = 1200 / 3937;
const DEG_PER_RAD = 180 / Math.PI;

// ── Linear conversions. ──────────────────────────────────────────────────────
export const feetToMetres = (ft: Feet): Metres => metres(raw(ft) * M_PER_FT);
export const metresToFeet = (m: Metres): Feet => feet(raw(m) / M_PER_FT);

/**
 * Convert a source-unit length to metres using the CRS's own factor. This is
 * the honest boundary: the factor comes from the file's linear-unit definition
 * (LAS GeoKey / WKT), NOT a guess. When the unit is unknown the caller passes
 * `1` and must NOT then present the result as metres — see the CRS docs.
 */
export const sourceToMetres = (v: SourceUnits, unitToMetres: number): Metres =>
  metres(raw(v) * unitToMetres);

/** US-survey-foot helper, kept separate so the ~2 ppm difference is explicit. */
export const usSurveyFeetToMetres = (ft: number): Metres => metres(ft * M_PER_US_FT);

/**
 * A source frame's linear-unit scale, as a DISCRIMINATED union so an unknown
 * unit can never be silently treated as metres. When the CRS names its linear
 * unit we carry the exact metres-per-unit factor; when it does not, the scale is
 * explicitly `unknown` and no metre value can be produced from it.
 */
export type LinearUnitScale =
  | { readonly known: true; readonly metresPerUnit: number }
  | { readonly known: false };

export const knownUnit = (metresPerUnit: number): LinearUnitScale => ({
  known: true,
  metresPerUnit,
});
export const unknownUnit = (): LinearUnitScale => ({ known: false });

/**
 * Human display label for a metres-per-unit scale: 'm' at unity, 'ft' at either
 * the international (0.3048) or US-survey (1200/3937) foot, else 'units'. Used to
 * label source-unit numbers honestly (a foot interval must read "ft", never "m")
 * without threading a separate name field alongside the numeric scale.
 */
export function verticalUnitLabel(metresPerUnit: number): 'm' | 'ft' | 'units' {
  if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) return 'units';
  if (Math.abs(metresPerUnit - 1) < 1e-6) return 'm';
  if (Math.abs(metresPerUnit - M_PER_FT) < 1e-4 || Math.abs(metresPerUnit - M_PER_US_FT) < 1e-4) {
    return 'ft';
  }
  return 'units';
}

/**
 * Convert a source-unit length to metres ONLY when the unit is known. Returns
 * `null` for an unknown unit, so the caller is forced to handle it (show source
 * units, refuse a metric claim) rather than receiving a `Metres` it would
 * present as if it were real metres. This is the type-level guard against the
 * "unknown unit branded as metres" bug.
 */
export function toMetresIfKnown(v: SourceUnits, scale: LinearUnitScale): Metres | null {
  return scale.known ? metres(raw(v) * scale.metresPerUnit) : null;
}

// ── Angular conversions. ─────────────────────────────────────────────────────
export const radToDeg = (r: Radians): Degrees => degrees(raw(r) * DEG_PER_RAD);
export const degToRad = (d: Degrees): Radians => radians(raw(d) / DEG_PER_RAD);

// ── Area / volume, derived from the exact linear factor. ─────────────────────
export const sqMetresToSqFeet = (a: SqMetres): number => raw(a) / (M_PER_FT * M_PER_FT);
export const cubicMetresToCubicFeet = (v: CubicMetres): number =>
  raw(v) / (M_PER_FT * M_PER_FT * M_PER_FT);

/** The exact factors, exposed for tests and for callers that must document them. */
export const UNIT_FACTORS = {
  M_PER_FT,
  M_PER_US_FT,
  DEG_PER_RAD,
} as const;
