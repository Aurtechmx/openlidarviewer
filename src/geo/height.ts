/**
 * src/geo/height.ts
 *
 * An explicit vertical value type. The point of this module is to stop a height
 * travelling through the pipeline as a bare number whose unit and datum are only
 * implied by the field name it lands in. A horizontal conversion must not pass Z
 * through and let a downstream field call it `altMetres`; a height carried here
 * states what reference surface it is measured from, and admits `'unknown'` when
 * the datum is undeclared rather than borrowing one.
 *
 * Pure and dependency-free: no DOM, no three.js, no proj4, no CRS types. It
 * classifies a vertical datum into a coarse reference class and labels a height
 * honestly. The reference classification deliberately mirrors the identity
 * resolution in `model/layerCompatibility.ts` (EPSG-first, then a small explicit
 * name map) so the two never disagree about what "NAVD88" is — but it lives here,
 * one layer down, so the inspector, exporters and terrain tools can all reach a
 * single honest answer instead of re-deriving the reference three ways.
 */

import { UNIT_FACTORS } from '../units/units';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reference surface a height is measured from.
 *
 * `ellipsoidal` — height above the reference ellipsoid (GNSS / WGS 84 3D). NOT a
 *                 sea-level elevation: it differs from one by the geoid
 *                 separation, tens of metres in places.
 * `orthometric` — height above a vertical datum's reference surface (approximately
 *                 mean sea level): NAVD88, EGM2008/EGM96 geoid heights, ODN, etc.
 * `depth` — a downward axis (e.g. MSL depth); positive values go below the
 *           reference surface.
 * `local` — the dataset's own local frame; not tied to a geodetic datum.
 * `unknown` — no vertical datum is declared, so the reference is genuinely not
 *             known. Never silently upgraded to orthometric or ellipsoidal.
 */
export type VerticalReference =
  | 'ellipsoidal'
  | 'orthometric'
  | 'depth'
  | 'local'
  | 'unknown';

/**
 * A height as an explicit value + optional metres scale + reference.
 *
 * `value` is the magnitude in the source's own vertical unit — NOT assumed to be
 * metres. `metresPerUnit` is the scale that converts `value` to metres when the
 * source declared a vertical unit; `undefined` means the vertical scale is
 * unknown, which is the honest state for a file that carried no vertical unit and
 * must not be read as "metres". `reference` is the datum class above.
 *
 * The unit is carried as a metres-per-unit factor rather than a unit token to
 * match how the CRS layer already represents a distinct vertical unit
 * (`ResolvedCrs.verticalUnitToMetres`), so a height built from a CRS and the CRS
 * itself can never diverge about the vertical scale.
 */
export interface HeightValue {
  readonly value: number;
  readonly metresPerUnit?: number;
  readonly reference: VerticalReference;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

/** Build a {@link HeightValue}. `metresPerUnit` omitted ⇒ vertical scale unknown. */
export function makeHeight(
  value: number,
  reference: VerticalReference,
  metresPerUnit?: number,
): HeightValue {
  return metresPerUnit === undefined
    ? { value, reference }
    : { value, metresPerUnit, reference };
}

/**
 * The height in metres, or `undefined` when the vertical scale is unknown.
 *
 * Honest by construction: a height whose source never declared a vertical unit
 * has no metres value, and this returns `undefined` rather than treating the raw
 * magnitude as metres. A non-finite scale is likewise `undefined`.
 */
export function heightInMetres(h: HeightValue): number | undefined {
  if (h.metresPerUnit === undefined || !Number.isFinite(h.metresPerUnit)) return undefined;
  return h.value * h.metresPerUnit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference classification
// ─────────────────────────────────────────────────────────────────────────────

/** One vertical CRS the app recognises by EPSG code. */
export interface KnownVerticalCrs {
  /** Short label shown in the strip, Inspector and reports. */
  readonly label: string;
  /** Which way the axis points: up from the surface, or down. */
  readonly axis: 'height' | 'depth';
  /** Metres per axis unit, from the EPSG definition. */
  readonly metresPerUnit: number;
}

const FT = UNIT_FACTORS.M_PER_FT;
const FT_US = UNIT_FACTORS.M_PER_US_FT;

/**
 * Orthometric (height or depth from a level surface) vertical CRSs by EPSG
 * code, with the axis unit each code defines. Codes, names and units are
 * those of the EPSG dataset (proj.db). The strip, the Inspector and Measure
 * all read this one table through {@link knownVerticalCrs}, so they cannot
 * disagree about whether a declared code is recognised.
 */
const KNOWN_VERTICAL_CRS: Readonly<Record<number, KnownVerticalCrs>> = {
  5703: { label: 'NAVD88', axis: 'height', metresPerUnit: 1 },
  6360: { label: 'NAVD88 height (ftUS)', axis: 'height', metresPerUnit: FT_US },
  8228: { label: 'NAVD88 height (ft)', axis: 'height', metresPerUnit: FT },
  6357: { label: 'NAVD88 depth', axis: 'depth', metresPerUnit: 1 },
  6358: { label: 'NAVD88 depth (ftUS)', axis: 'depth', metresPerUnit: FT_US },
  7968: { label: 'NGVD29 height (m)', axis: 'height', metresPerUnit: 1 },
  5702: { label: 'NGVD29 height (ftUS)', axis: 'height', metresPerUnit: FT_US },
  6359: { label: 'NGVD29 depth (ftUS)', axis: 'depth', metresPerUnit: FT_US },
  5701: { label: 'ODN (Newlyn)', axis: 'height', metresPerUnit: 1 },
  5714: { label: 'MSL height', axis: 'height', metresPerUnit: 1 },
  8050: { label: 'MSL height (ft)', axis: 'height', metresPerUnit: FT },
  8052: { label: 'MSL height (ftUS)', axis: 'height', metresPerUnit: FT_US },
  5715: { label: 'MSL depth', axis: 'depth', metresPerUnit: 1 },
  8051: { label: 'MSL depth (ft)', axis: 'depth', metresPerUnit: FT },
  8053: { label: 'MSL depth (ftUS)', axis: 'depth', metresPerUnit: FT_US },
  3855: { label: 'EGM2008 height', axis: 'height', metresPerUnit: 1 },
  5773: { label: 'EGM96 height', axis: 'height', metresPerUnit: 1 },
  5798: { label: 'EGM84 height', axis: 'height', metresPerUnit: 1 },
  6647: { label: 'CGVD2013', axis: 'height', metresPerUnit: 1 },
  5705: { label: 'Baltic 1977', axis: 'height', metresPerUnit: 1 },
  5612: { label: 'Baltic 1977 depth', axis: 'depth', metresPerUnit: 1 },
  5728: { label: 'LN02 height', axis: 'height', metresPerUnit: 1 },
};

/** The recognised vertical CRS for an EPSG code, or `undefined`. */
export function knownVerticalCrs(epsg: number | undefined): KnownVerticalCrs | undefined {
  return epsg === undefined ? undefined : KNOWN_VERTICAL_CRS[epsg];
}

/** Orthometric (height-above-datum) vertical CRS codes. */
const ORTHOMETRIC_EPSG: ReadonlySet<number> = new Set(
  Object.entries(KNOWN_VERTICAL_CRS).filter(([, v]) => v.axis === 'height').map(([k]) => Number(k)),
);

/** Depth (downward) vertical CRS codes. */
const DEPTH_EPSG: ReadonlySet<number> = new Set(
  Object.entries(KNOWN_VERTICAL_CRS).filter(([, v]) => v.axis === 'depth').map(([k]) => Number(k)),
);

/**
 * Ellipsoidal-height vertical CRS codes. Deliberately narrow, like the RFC-7946
 * allow-list in `terrain/contour/geojsonContours.ts`: EPSG:4979 is WGS 84 3D
 * (geographic lat/lon + ellipsoidal height). A guess in the permissive direction
 * is what puts a height tens of metres out, so free-text "ellipsoid" is not
 * accepted here.
 */
const ELLIPSOIDAL_EPSG: ReadonlySet<number> = new Set([
  4979, // WGS 84 (3D) — ellipsoidal height
]);

/**
 * Known vertical-datum names → EPSG. The same small, explicit map
 * `model/layerCompatibility.ts` uses, so a datum that arrives as a catalog name
 * ("NAVD88") and one that arrives as a code ("EPSG:5703") resolve to one identity.
 */
const NAME_TO_EPSG: Readonly<Record<string, number>> = {
  // Every label the table prints reads back to its own code.
  ...Object.fromEntries(Object.entries(KNOWN_VERTICAL_CRS).map(([code, v]) => [v.label.toLowerCase(), Number(code)])),
  navd88: 5703,
  'odn (newlyn)': 5701,
  'msl height': 5714,
  'msl depth': 5715,
  'egm2008 height': 3855,
  'egm96 height': 5773,
  cgvd2013: 6647,
  'baltic 1977': 5705,
  'egm84 height': 5798,
};

/** Known datum names, longest first, so a match takes the most specific. */
const NAMES_BY_LENGTH: readonly string[] = Object.keys(NAME_TO_EPSG).sort((a, b) => b.length - a.length);

/**
 * Linear units a citation may name after the datum. A unit says nothing about
 * which reference surface the datum is, so carrying one does not change it.
 */
const CITATION_UNITS = new Set([
  'm', 'metre', 'metres', 'meter', 'meters',
  'ft', 'foot', 'feet', 'ftus', 'usft', 'us-ft', 'ift',
]);

/**
 * Whether the qualifiers a citation carries after its datum name are the
 * harmless kind.
 *
 * A WKT citation states the datum and then its axis, its realisation and its
 * unit: "NAVD88 height - Geoid12B (m)". Those describe the SAME datum, so the
 * name still identifies it. Anything else does not: "NAVD88 local adjustment"
 * and "NAVD88-derived local datum" name a DIFFERENT vertical reference derived
 * from that one, and "NAVD88? uncertain" declares doubt. Accepting the datum
 * for those would assert a geodetic identity the source did not, so they stay
 * unresolved and travel as free text.
 *
 * `axisWord` is the axis the resolved code actually has, so a citation whose
 * axis contradicts its datum ("NAVD88 depth") is refused too.
 */
function qualifiersAreHarmless(rest: string, axisWord: 'height' | 'depth'): boolean {
  if (rest === '') return true;
  // Detach dashes so "-derived" reads as its own word rather than a separator.
  const tokens = rest.replace(/-/g, ' - ').split(/\s+/).filter((t) => t !== '');
  for (const t of tokens) {
    if (t === '-' || t === axisWord) continue;
    // A realisation: geoid12b, geoid18, geoid2012.
    if (/^geoid[a-z0-9]*$/.test(t)) continue;
    // A parenthesised unit, whole or split across tokens by the parentheses.
    const unit = /^\(?([a-z-]+)\)?$/.exec(t);
    if (unit && CITATION_UNITS.has(unit[1])) continue;
    return false;
  }
  return true;
}

/** A declared vertical datum, however the source spelled it. */
export interface VerticalDatumRef {
  /** Vertical CRS EPSG code, when declared. Authoritative. */
  readonly verticalEpsg?: number;
  /** Vertical datum as a name ("NAVD88") or code string ("EPSG:5703"). */
  readonly verticalDatum?: string;
}

/** Resolve a datum ref to its EPSG code, or `undefined` when none is recoverable. */
/**
 * The EPSG code a declared vertical datum resolves to, from an explicit code, a
 * known datum name, or an `EPSG:nnnn` string. Exported because the code is the
 * only identity that separates two datums sharing a reference surface, and a
 * caller comparing frames needs that separation rather than the surface class.
 */
export function resolveVerticalEpsg(d: VerticalDatumRef): number | undefined {
  if (d.verticalEpsg !== undefined && Number.isFinite(d.verticalEpsg) && d.verticalEpsg > 0) {
    return d.verticalEpsg;
  }
  const raw = d.verticalDatum?.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return undefined;
  const viaName = NAME_TO_EPSG[raw];
  if (viaName !== undefined) return viaName;
  const viaCode = /^epsg:(\d{4,6})$/.exec(raw) ?? /^(\d{4,6})$/.exec(raw);
  if (viaCode) return Number(viaCode[1]);
  // A datum read from a WKT citation carries its qualifiers: a USGS tile states
  // "NAVD88 height - Geoid12B (m)", which is the same datum the exact table
  // holds under "navd88". Matching only whole strings classified that as
  // unknown, so a profile sheet printed "datum unknown" for a scan whose
  // terrain report printed the datum on the same session. The name must open
  // the string, end on a word boundary, and be followed only by qualifiers that
  // describe that same datum; the longest name wins ("msl depth" before "msl").
  for (const name of NAMES_BY_LENGTH) {
    if (!raw.startsWith(name)) continue;
    const next = raw.charAt(name.length);
    if (next !== '' && /[a-z0-9]/.test(next)) continue;
    const code = NAME_TO_EPSG[name];
    const axisWord = DEPTH_EPSG.has(code) ? 'depth' : 'height';
    if (qualifiersAreHarmless(raw.slice(name.length).trim(), axisWord)) return code;
    return undefined;
  }
  return undefined;
}

/**
 * Classify a declared vertical datum into its reference surface.
 *
 * EPSG-first, name second — the same precedence as the layer-compatibility key.
 * A datum that is present but unrecognised (an EPSG code or free-text name not in
 * the tables) resolves to `'unknown'`, NOT to a guessed orthometric height: the
 * honest statement is that its reference is not known here. Never returns
 * `'local'`, which is a property of the coordinate frame, not of a datum.
 */
export function verticalReferenceFromDatum(d: VerticalDatumRef): VerticalReference {
  const code = resolveVerticalEpsg(d);
  if (code === undefined) return 'unknown';
  if (DEPTH_EPSG.has(code)) return 'depth';
  if (ELLIPSOIDAL_EPSG.has(code)) return 'ellipsoidal';
  if (ORTHOMETRIC_EPSG.has(code)) return 'orthometric';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Honest labelling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A short label for a height with this reference, suitable as a readout row
 * heading. The `unknown` case is the one that matters: it says the datum is
 * unknown rather than printing "Elevation", which asserts a sea-level datum the
 * source never carried.
 */
export function heightLabel(reference: VerticalReference): string {
  switch (reference) {
    case 'ellipsoidal':
      return 'Ellipsoidal height';
    case 'orthometric':
      return 'Elevation';
    case 'depth':
      return 'Depth';
    case 'local':
      return 'Height (local frame)';
    case 'unknown':
      return 'Height (datum unknown)';
  }
}

/**
 * A one-line explanation of what a height with this reference is measured from,
 * for a tooltip or a report line. Plain and factual: the unknown case states the
 * consequence (not tied to a known reference) rather than implying one.
 */
export function heightReferenceNote(
  reference: VerticalReference,
  /** The declared vertical datum's name; an orthometric note names it when given. */
  datumName?: string | null,
): string {
  const named = typeof datumName === 'string' ? datumName.trim() : '';
  switch (reference) {
    case 'ellipsoidal':
      return 'Height above the reference ellipsoid (GNSS / WGS 84). Not a sea-level elevation.';
    case 'orthometric':
      return named === ''
        ? 'Height above the vertical datum reference surface (approximately mean sea level).'
        : `Height above the vertical datum reference surface (${named}).`;
    case 'depth':
      return 'Depth below the vertical datum reference surface.';
    case 'local':
      return 'Height in the dataset local frame; not tied to a geodetic datum.';
    case 'unknown':
      return 'The vertical datum is not known here, so this height is not tied to a known reference.';
  }
}

// ── Height unit wording ────────────────────────────────────────────────────
// The words a height carries when it cannot be stated in metres although the
// horizontal unit is known. The on-screen Scan Report (`heightScale`), the
// streamed extent rows and the PDF dataset summary all print these, so the
// surfaces agree word for word.

/** Why a height is not in metres: no vertical unit, or a declared one that is unusable. */
export type HeightUnitGap = 'vertical-unit-not-declared' | 'vertical-unit-invalid';

/** The suffix after the number, leading space included. */
export const HEIGHT_UNIT_GAP_SUFFIX: Readonly<Record<HeightUnitGap, string>> = {
  'vertical-unit-not-declared': ' source units (vertical unit not declared)',
  'vertical-unit-invalid': ' source units (declared vertical unit is invalid)',
};

/** Appended to a Height figure when noise classes 7 and 18 sit inside the extent. */
export const HEIGHT_INCLUDES_NOISE_SUFFIX = ' (includes noise classes 7 and 18)';

/** Whether any counted point carries a noise class (7 Low Point, 18 High Noise). */
export function hasNoiseClassPoints(
  classification: ArrayLike<number>,
  count: number,
): boolean {
  const n = Math.min(count, classification.length);
  for (let i = 0; i < n; i++) {
    const c = classification[i] & 0xff;
    if (c === 7 || c === 18) return true;
  }
  return false;
}

/**
 * Classify a declared vertical factor. `undefined` means no vertical unit was
 * declared; a declared factor that is zero, negative or non-finite is invalid.
 * Mirrors `verticalScaleKnown` in the spatial context.
 */
export function heightUnitGapOf(verticalUnitToMetres: number | undefined): HeightUnitGap | null {
  if (verticalUnitToMetres === undefined) return 'vertical-unit-not-declared';
  return Number.isFinite(verticalUnitToMetres) && verticalUnitToMetres > 0 ? null : 'vertical-unit-invalid';
}
