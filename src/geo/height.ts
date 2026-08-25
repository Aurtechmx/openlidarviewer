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

/** Orthometric (height-above-datum) vertical CRS codes. */
const ORTHOMETRIC_EPSG: ReadonlySet<number> = new Set([
  5703, // NAVD88
  5701, // ODN (Newlyn)
  5714, // MSL height
  3855, // EGM2008 geoid height
  5773, // EGM96 geoid height
  6647, // CGVD2013
  5705, // Baltic 1977
  5612, // EGM84 geoid height
]);

/** Depth (downward) vertical CRS codes. */
const DEPTH_EPSG: ReadonlySet<number> = new Set([
  5715, // MSL depth
]);

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
  navd88: 5703,
  'odn (newlyn)': 5701,
  'msl height': 5714,
  'msl depth': 5715,
  'egm2008 height': 3855,
  'egm96 height': 5773,
  cgvd2013: 6647,
  'baltic 1977': 5705,
  'egm84 height': 5612,
};

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
  const raw = d.verticalDatum?.trim().toLowerCase();
  if (!raw) return undefined;
  const viaName = NAME_TO_EPSG[raw];
  if (viaName !== undefined) return viaName;
  const viaCode = /^epsg:(\d{4,6})$/.exec(raw) ?? /^(\d{4,6})$/.exec(raw);
  if (viaCode) return Number(viaCode[1]);
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
export function heightReferenceNote(reference: VerticalReference): string {
  switch (reference) {
    case 'ellipsoidal':
      return 'Height above the reference ellipsoid (GNSS / WGS 84). Not a sea-level elevation.';
    case 'orthometric':
      return 'Height above the vertical datum reference surface (approximately mean sea level).';
    case 'depth':
      return 'Depth below the vertical datum reference surface.';
    case 'local':
      return 'Height in the dataset local frame; not tied to a geodetic datum.';
    case 'unknown':
      return 'No vertical datum is declared, so this height is not tied to a known reference.';
  }
}
