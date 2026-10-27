/**
 * measurementExport.ts
 *
 * Pure serializers that let placed measurements LEAVE the tool in open formats —
 * GeoJSON (for GIS software and web maps) and CSV (for spreadsheets). Both are an
 * open-format trust signal and the round-trip surface for survey/UAV users.
 *
 * Coordinates in `Measurement.points` are LOCAL (render-space). The caller
 * supplies a `toOutput` transform that maps a local point into the desired
 * output frame — geographic WGS84 lon/lat (when a CRS is known and the user
 * wants a web-map-ready file) or the source projected CRS. That keeps this
 * module free of the CRS service, the DOM, and three.js, so it is fully
 * unit-testable; the call site wires the real transform.
 *
 * Honesty: derived metrics are recomputed from the geometry (never invented),
 * reported in METRES (lengths × `unitToMetres`, areas × `unitToMetres²`), and a
 * value the geometry can't establish is left blank rather than zero-filled.
 */

import type { Measurement, Vec3 } from '../render/measure/types';
import { GEOGRAPHIC_NOT_AVAILABLE, VERTICAL_NOT_AVAILABLE, VERTICAL_SCALE_NOT_AVAILABLE, frameRefusalText, geographicRefusesKind, isComplete, reductionExportFields } from '../render/measure/types';
import {
  evidenceNote,
  evidenceStatus,
  geographicRefusalCaveat,
  unverifiedUnitsCaveat,
  verticalRefusalCaveat,
  verticalScaleRefusalCaveat,
} from '../validation/exportEvidenceNote';

/** The refusal rule and wording, for the report and KML serializers. */
export { GEOGRAPHIC_NOT_AVAILABLE, VERTICAL_NOT_AVAILABLE, VERTICAL_SCALE_NOT_AVAILABLE, geographicRefusesKind };
export { formatVolumeNumber, reducedSampleCaveat } from '../render/measure/types';
/** The position-step rule, for the report serializers. */
export { HEADLINE_METRIC_KEY, unresolvedMetricKeys, unresolvedReason, type AxisSteps };
import { lightProvenance, type LightProvenanceInput } from './lightProvenance';
import {
  BOX_NO_HEIGHT_NOTE,
  flatBox,
  distance,
  polylineLength,
  profileMetrics,
  polygonAreaHorizontal,
  polygonAreaPlanar,
  areaRingVerdict,
  type AreaRingVerdict,
  polygonPerimeter,
  angleAtVertex,
  slopeBetween,
  verticalDelta,
  boxFromCorners,
  boxCorners,
  boxMetrics,
  toMetricFrame,
  unresolvedMetricKeys,
  unresolvedReason,
  HEADLINE_METRIC_KEY,
  type AxisSteps,
} from '../render/measure/geometry';

export interface MeasurementExportContext {
  /**
   * Map a LOCAL render-space point into the output frame (lon/lat/alt or
   * x/y/z). The measurement is passed so a point leaves through the frame of
   * the scan it was taken on.
   */
  readonly toOutput: (p: Vec3, m?: Measurement) => [number, number, number];
  /** The source file a measurement was taken on, written as `source`; null when unknown. */
  readonly sourceOf?: (m: Measurement) => string | null;
  /** World up vector, for the height / grade / slope derivations. */
  readonly up: Vec3;
  /**
   * The step a measurement's positions are held at, per axis, on the layer(s)
   * it was taken on. Absent or null: no figure is withheld on that basis.
   */
  readonly positionSteps?: (m: Measurement) => AxisSteps | null;
  /** Render-units → metres (1 for metric scans; e.g. 0.3048 for US-foot scans). */
  readonly unitToMetres: number;
  /**
   * VERTICAL render-units → metres (up-axis height unit). Defaults to
   * `unitToMetres`; differs only for a compound CRS (metre eastings over foot
   * heights). Vertical quantities (height, rise, drop) and volumes scale by
   * this so the export matches the on-screen headline, which already does.
   */
  readonly verticalUnitToMetres?: number;
  /** Source CRS label, written as the per-feature `crs` property (the file's frame is always WGS 84). */
  readonly crsName?: string;
  /**
   * The WGS 84 placement the GeoJSON geometry is written in. RFC 7946 fixes
   * GeoJSON coordinates to WGS 84 longitude/latitude, so without it the
   * GeoJSON writer refuses ({@link GeoJsonLonLatError}); the CSV ignores it.
   */
  readonly lonLat?: GeoJsonLonLat;
  /**
   * True when the scan's frame is geographic (degrees), so `toOutput` yields
   * WGS84 lon/lat (the RFC 7946 default frame). The live Measure tool refuses
   * every kind but a height on such a frame, and so does the export: see
   * {@link geographicFilter}.
   */
  readonly geographic?: boolean;
  /**
   * True when the frame has no valid local vertical (geocentric, depth-down):
   * `SpatialContext.verticalMetricRefused`. Heights, grades, profiles and
   * volumes are then withheld too, pure-vertical keys included.
   */
  readonly verticalRefused?: boolean;
  /**
   * True when the source declares a vertical unit that cannot be read
   * (`SpatialContext.verticalScaleState === 'invalid'`). `verticalUnitToMetres`
   * is then not a metre factor: every figure that reads Z is withheld, and
   * only the purely horizontal figures of a measurement are written.
   */
  readonly verticalScaleInvalid?: boolean;
  /**
   * True when the scan's linear scale is KNOWN (a resolved CRS unit), so the
   * `_m` / `_m2` / `_m3` columns genuinely mean metres. False for a local /
   * unknown-unit scan, where the factor is an inert 1 and the export must not
   * claim metres — the evidence note then carries an explicit units caveat
   * (pass-6 M1). Defaults to true so every georeferenced caller is unchanged.
   */
  readonly unitsVerified?: boolean;
  /**
   * Build, source, CRS, interpretation level and data basis for the file.
   * Written as a `provenance` foreign member of the GeoJSON FeatureCollection
   * (RFC 7946 section 6.1). The CSV has no metadata slot and does not carry it.
   */
  readonly provenance?: LightProvenanceInput;
}

/**
 * How the GeoJSON geometry reaches WGS 84. `map` takes a point in the OUTPUT
 * frame (what `toOutput` returns) and gives `[lon, lat, sourceZ]`; only the
 * first two are converted. `withAltitude` is true only when the vertical
 * reference is proven (the KML `absolute` rule), and `altitudeNote` says which
 * way it went. `datumCaveat` is the mapper's note when the source datum is
 * treated as WGS 84 without a transformation (NAD83 and its kin).
 */
export interface GeoJsonLonLat {
  readonly map: (p: readonly [number, number, number]) => [number, number, number];
  readonly withAltitude: boolean;
  readonly altitudeNote: string;
  readonly datumCaveat: string | null;
  /**
   * When set, each feature carries its source elevations (unconverted) as
   * `elevations_source`, and the file states their datum and unit once as
   * `vertical_reference`. The GeoJSON height policy sets it; RFC 7946 heights
   * are ellipsoidal, so an orthometric source height rides here instead.
   */
  readonly sourceHeights?: { readonly verticalDatum: string | null; readonly unit: string };
}

/** The refusal when a GeoJSON cannot be placed in WGS 84 longitude/latitude. */
export const GEOJSON_NEEDS_LONLAT =
  'GeoJSON coordinates must be WGS 84 longitude/latitude (RFC 7946), and this scan cannot be placed '
  + 'in longitude/latitude. Export CSV instead for the measured values.';

/** Raised when a GeoJSON geometry cannot be written as a real WGS 84 position. */
export class GeoJsonLonLatError extends Error {
  override readonly name = 'GeoJsonLonLatError';
}

/** A finite number to at most 8 decimals (about 1 mm of latitude). */
function deg(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** One RFC 7946 position, refusing anything that is not a real lon/lat. */
function lonLatPosition(lonLat: GeoJsonLonLat, p: readonly [number, number, number]): number[] {
  const [lon, lat, z] = lonLat.map(p);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new GeoJsonLonLatError(`A point maps to (${lon}, ${lat}), which is not a WGS 84 longitude/latitude.`);
  }
  if (!lonLat.withAltitude) return [deg(lon), deg(lat)];
  if (!Number.isFinite(z)) throw new GeoJsonLonLatError(`A point has a non-finite height (${z}).`);
  return [deg(lon), deg(lat), Math.round(z * 1e4) / 1e4];
}

/** A finite number rounded to `d` decimals, or null when not finite. */
export function roundMeasured(v: number, d = 3): number | null {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  // A nonzero value that rounds to zero keeps three significant digits, so a
  // rounded zero is never mistaken for a measured zero.
  if (r === 0 && v !== 0) return Number(v.toPrecision(3));
  return r === 0 ? 0 : r;
}

const num = roundMeasured;

/**
 * A finite number as plain decimal text, never in exponent form, so a tiny
 * value such as 1.2e-9 is written as 0.0000000012 for CSV and KML readers.
 */
export function plainDecimal(v: number): string {
  const s = String(v);
  if (!/e/i.test(s)) return s;
  const exp = Math.floor(Math.log10(Math.abs(v)));
  const digits = Math.min(100, Math.max(0, 2 - exp));
  return v.toFixed(digits);
}

/**
 * The applicable derived metrics for one measurement, in METRES / m² / m³ /
 * degrees / %. Only the keys that the kind actually establishes are present;
 * a value the geometry can't compute is simply omitted (never zero-filled).
 */
export function measurementMetrics(
  m: Measurement,
  up: Vec3,
  unitToMetres: number,
  verticalToMetres: number = unitToMetres,
  decimals = 3,
  steps: AxisSteps | null = null,
): Record<string, number> {
  const out: Record<string, number> = {};
  // Round at the surface's chosen precision. The tabular exports (CSV / GeoJSON /
  // KML / integrity) keep the default 3 decimals — millimetre columns, byte-
  // identical to before. The PDF report and any display path pass a higher
  // `decimals` so a value like 0.9144 m survives to feed formatLinear's adaptive
  // sub-centimetre precision and agree with the live panel to the digit (M6);
  // `num` still drops a non-finite value to null (omitted, never zero-filled).
  const set = (k: string, v: number | null): void => {
    const r = v === null ? null : num(v, decimals);
    if (r !== null) out[k] = r;
  };
  const pts = m.points;
  const L = unitToMetres;
  // Vertical (up-axis) factor; defaults to L so a single-unit CRS is uniform.
  const Vv = Number.isFinite(verticalToMetres) && verticalToMetres > 0 ? verticalToMetres : L;
  // Volume factor for STORED cut/fill (not point-derived): linear²·vertical.
  const Vol = L * L * Vv;
  if (!isComplete(m)) return out;

  // Every point-derived metric is computed in the isotropic METRE frame, so the
  // result is already in metres and no per-axis factor is juggled onto a 3D
  // quantity — the compound-CRS self-contradiction (M2). Single-unit CRSs make
  // this a uniform scale, so the numbers are byte-identical to before.
  const mp = pts.map((p) => toMetricFrame(p, up, L, Vv));

  switch (m.kind) {
    case 'distance':
      set('length_m', distance(mp[0], mp[1]));
      break;
    case 'polyline':
      set('length_m', polylineLength(mp).total);
      break;
    case 'height': {
      const v = verticalDelta(mp[0], mp[1], up);
      set('vertical_m', v.vertical);
      set('horizontal_m', v.horizontal);
      break;
    }
    case 'angle':
      // Physically correct now — the arms are in the metric frame, so a mix of
      // horizontal and vertical units no longer skews the angle (M3's compute).
      set('angle_deg', angleAtVertex(mp[0], mp[1], mp[2]));
      break;
    case 'slope': {
      const s = slopeBetween(mp[0], mp[1], up);
      set('grade_pct', s.gradePercent);
      set('angle_deg', s.angleDeg);
      set('rise_m', s.rise);
      set('run_m', s.run);
      break;
    }
    case 'profile': {
      const p = profileMetrics(mp[0], mp[1], up);
      set('length_m', p.length3d);
      set('horizontal_m', p.lengthHorizontal);
      set('vertical_m', p.verticalDrop);
      set('grade_pct', p.gradePercent);
      break;
    }
    case 'area':
      // `area_m2` is the PRIMARY Area measurement — the true tilted-plane area
      // the live headline and the aggregate chain both report (polygonAreaPlanar).
      // Exporting the horizontal projection here made a vertical 1 m×1 m wall
      // read ~1 m² on screen but 0 m² in the file (pass-6 M4). The map footprint
      // is still exported alongside as `horizontal_area_m2` for GIS use.
      // A ring that does not establish an area (it crosses itself, repeats a
      // vertex, collapses, or is far from planar) carries no area figure at all:
      // both keys are omitted and `areaWithheldNote` states why.
      if (ringVerdict(pts, mp).ok) {
        set('area_m2', polygonAreaPlanar(mp));
        set('horizontal_area_m2', polygonAreaHorizontal(mp, up));
      }
      set('perimeter_m', polygonPerimeter(mp));
      break;
    case 'box': {
      const mb = boxMetrics(boxFromCorners(mp[0], mp[1]), up);
      set('width_m', mb.width);
      set('depth_m', mb.depth);
      set('height_m', mb.height);
      // No height is no volume, not a volume of 0 (see boxVolumeWithheldNote).
      if (!flatBox(pts[0], pts[1], up)) set('volume_m3', mb.volume);
      break;
    }
    case 'volume':
      // A volume's base is a horizontal footprint (the map area under it).
      set('area_m2', polygonAreaHorizontal(mp, up));
      if (m.volume) {
        // cut/fill/net are stored volumes in native units, not point-derived.
        // A withheld grid figure carries none of the three — `set` already
        // omits a non-finite value, so `undefined * Vol` (NaN) drops the column
        // rather than exporting a fabricated zero.
        if (m.volume.cut !== undefined) set('cut_m3', m.volume.cut * Vol);
        if (m.volume.fill !== undefined) set('fill_m3', m.volume.fill * Vol);
        if (m.volume.net !== undefined) set('net_m3', m.volume.net * Vol);
        // Covered share of the footprint the figures are integrated over.
        if (m.volume.coverageFraction !== undefined) set('coverage_fraction', m.volume.coverageFraction);
        if (m.volume.interpolatedFraction !== undefined) set('interpolated_fraction', m.volume.interpolatedFraction);
        if (m.volume.excludedFraction !== undefined) set('excluded_fraction', m.volume.excludedFraction);
        // The cut-fill cross-check a switched lasso record keeps beside the
        // grid figure — named so a reader never confuses it with the canonical
        // cut_m3/fill_m3/net_m3 above. The `pointsample_` prefix is kept for
        // existing readers; the estimator it names is `crossCheck.method`.
        // A withheld grid exports no cross-check either.
        if (m.volume.crossCheck && m.volume.gridAuthority !== 'withheld') {
          set('pointsample_cut_m3', m.volume.crossCheck.cut * Vol);
          set('pointsample_fill_m3', m.volume.crossCheck.fill * Vol);
          set('pointsample_net_m3', m.volume.crossCheck.net * Vol);
        }
      }
      break;
  }
  // A figure below the step this scan's positions are held at cannot be told
  // from zero: it is omitted, like any figure the geometry cannot establish,
  // and `unresolvedNote` states why.
  for (const k of unresolvedMetricKeys(m, up, L, Vv, steps)) delete out[k];
  return out;
}

/**
 * Why some of `m`'s figures are omitted because they are smaller than the step
 * its scan's positions are held at, or undefined when none is.
 */
export function unresolvedNote(
  m: Measurement,
  up: Vec3,
  unitToMetres: number,
  verticalToMetres: number = unitToMetres,
  steps: AxisSteps | null = null,
): string | undefined {
  if (!steps || !isComplete(m)) return undefined;
  const Vv = Number.isFinite(verticalToMetres) && verticalToMetres > 0 ? verticalToMetres : unitToMetres;
  const keys = unresolvedMetricKeys(m, up, unitToMetres, Vv, steps);
  return keys.length > 0 ? `${keys.join(', ')} ${unresolvedReason(steps, up, unitToMetres, Vv)}` : undefined;
}

/**
 * The ring verdict: the stored vertices must be numbers before the metric frame
 * is applied, since a null or string component would otherwise coerce to a
 * finite value.
 */
function ringVerdict(stored: readonly Vec3[], metric: readonly Vec3[]): AreaRingVerdict {
  const v = areaRingVerdict(stored);
  return v.ok ? areaRingVerdict(metric) : v;
}

/**
 * The stated reason an Area measurement reports no area figure, or undefined
 * when it reports one (or is not a complete Area). The same verdict that
 * `measurementMetrics` uses to omit the keys.
 */
export function areaWithheldNote(
  m: Measurement,
  up: Vec3,
  unitToMetres: number,
  verticalToMetres: number = unitToMetres,
): string | undefined {
  if (m.kind !== 'area' || !isComplete(m)) return undefined;
  const Vv = Number.isFinite(verticalToMetres) && verticalToMetres > 0 ? verticalToMetres : unitToMetres;
  const v = ringVerdict(m.points, m.points.map((p) => toMetricFrame(p, up, unitToMetres, Vv)));
  return v.ok ? undefined : `Area withheld: ${v.text}`;
}

/** The stated reason a complete Box reports no volume, or undefined when it reports one. */
export function boxVolumeWithheldNote(m: Measurement, up: Vec3): string | undefined {
  return m.kind === 'box' && isComplete(m) && flatBox(m.points[0], m.points[1], up) ? BOX_NO_HEIGHT_NOTE : undefined;
}

/** Why an Angle reports no angle: an arm has zero length, so the angle is undefined. */
export const ANGLE_UNDEFINED_NOTE =
  'Angle withheld: an arm has zero length (the vertex coincides with an end point), so the angle is undefined.';

/**
 * The stated reason an Angle measurement reports no `angle_deg`, or undefined
 * when it reports one (or is not a complete Angle). Same verdict
 * `measurementMetrics` uses to omit the key.
 */
export function angleWithheldNote(
  m: Measurement,
  up: Vec3,
  unitToMetres: number,
  verticalToMetres: number = unitToMetres,
): string | undefined {
  if (m.kind !== 'angle' || !isComplete(m)) return undefined;
  const Vv = Number.isFinite(verticalToMetres) && verticalToMetres > 0 ? verticalToMetres : unitToMetres;
  const mp = m.points.map((p) => toMetricFrame(p, up, unitToMetres, Vv));
  return Number.isFinite(angleAtVertex(mp[0], mp[1], mp[2])) ? undefined : ANGLE_UNDEFINED_NOTE;
}

/**
 * Metric keys measured along the up axis alone, in the Z unit. On a geographic
 * frame they are still honest figures, so a refused kind keeps them.
 */
const PURE_VERTICAL_KEYS: ReadonlySet<string> = new Set(['vertical_m', 'rise_m', 'height_m']);

/**
 * Metric keys measured in the horizontal plane alone, by kind: they read X/Y
 * at the horizontal scale and never Z. When only the vertical scale is invalid
 * they are still honest metres, so a refused measurement keeps them. A volume's
 * `area_m2` is its horizontal footprint; an area's `area_m2` is the tilted
 * plane and is not listed.
 */
const PURE_HORIZONTAL_KEYS: Readonly<Partial<Record<Measurement['kind'], ReadonlySet<string>>>> = {
  height: new Set(['horizontal_m']),
  profile: new Set(['horizontal_m']),
  slope: new Set(['run_m']),
  area: new Set(['horizontal_area_m2']),
  box: new Set(['width_m', 'depth_m']),
  volume: new Set(['area_m2']),
};

/**
 * True when a geographic frame refuses this measurement's figures. The kind
 * rule is the live grade's own (`geographicRefusesKind`), so an export cannot
 * publish a number the Measure panel marks as not a distance.
 */
export function geographicRefuses(m: Measurement, geographic: boolean | undefined, verticalRefused?: boolean, verticalScaleInvalid?: boolean): boolean {
  return refusalNote(m, geographic, verticalRefused, verticalScaleInvalid) !== null;
}

/** The sentence a refused measurement carries in place of its figures, or null. */
export function refusalNote(m: Measurement, geographic: boolean | undefined, verticalRefused?: boolean, verticalScaleInvalid?: boolean): string | null {
  return frameRefusalText(m.kind, geographic === true, verticalRefused === true, verticalScaleInvalid === true);
}

/**
 * Whether a refused measurement still writes metric key `k`: a pure-vertical
 * key while the vertical is valid (a geographic frame keeps heights), and a
 * purely horizontal key while the horizontal is valid (an unreadable vertical
 * unit keeps plan figures). A frame with no local vertical keeps neither.
 */
function keptUnderRefusal(m: Measurement, k: string, geographic: boolean | undefined, verticalRefused?: boolean, verticalScaleInvalid?: boolean): boolean {
  if (verticalRefused === true) return false;
  if (PURE_VERTICAL_KEYS.has(k)) return verticalScaleInvalid !== true;
  return geographic !== true && verticalScaleInvalid === true && PURE_HORIZONTAL_KEYS[m.kind]?.has(k) === true;
}

/**
 * The metrics with every refused figure set to null. A refused measurement on
 * a geographic frame keeps only its pure-vertical keys; every other figure
 * mixes degree X/Y with linear Z. With an unreadable vertical unit it keeps
 * only its purely horizontal keys. Key order is unchanged. A measurement that
 * is not refused passes through as is.
 */
export function geographicFilter(
  metrics: Record<string, number>,
  m: Measurement,
  geographic: boolean | undefined,
  verticalRefused?: boolean,
  verticalScaleInvalid?: boolean,
): Record<string, number | null> {
  if (!geographicRefuses(m, geographic, verticalRefused, verticalScaleInvalid)) return metrics;
  return Object.fromEntries(
    Object.entries(metrics).map(([k, v]) => [k, keptUnderRefusal(m, k, geographic, verticalRefused, verticalScaleInvalid) ? v : null]),
  );
}

type GeoJsonGeometry = { type: 'LineString' | 'Polygon'; coordinates: unknown };

/** The points a kind's geometry is drawn through, in LOCAL frame; null when incomplete. */
function geometryPoints(m: Measurement, ctx: MeasurementExportContext): { type: 'LineString' | 'Polygon'; points: Vec3[] } | null {
  switch (m.kind) {
    case 'distance':
    case 'polyline':
    case 'height':
    case 'angle':
    case 'slope':
    case 'profile':
      return m.points.length >= 2 ? { type: 'LineString', points: m.points } : null;
    case 'area':
    case 'volume':
      return m.points.length >= 3 ? { type: 'Polygon', points: m.points } : null;
    case 'box': {
      if (m.points.length < 2) return null;
      // Footprint = the four bottom corners (indices 0..3 of boxCorners).
      const corners = boxCorners(boxFromCorners(m.points[0], m.points[1]), ctx.up);
      return { type: 'Polygon', points: [corners[0], corners[1], corners[2], corners[3]] };
    }
  }
}

/** Distinct lon/lat pairs (the height is not part of the planar shape). */
function distinctLonLat(positions: readonly number[][]): number {
  return new Set(positions.map((q) => `${q[0]},${q[1]}`)).size;
}

/** Shoelace area of a lon/lat ring, in square degrees (unsigned). */
function lonLatRingArea(ring: readonly number[][]): number {
  return Math.abs(signedLonLatRingArea(ring));
}

/** Shoelace area of an open ring in lon/lat; positive when counter-clockwise. */
function signedLonLatRingArea(ring: readonly number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Why a written geometry would be degenerate in lon/lat, or null when it is a
 * valid RFC 7946 shape. Checked AFTER conversion to the output frame: a
 * vertical wall or a purely vertical distance is valid in 3D but collapses
 * once projected to longitude/latitude.
 */
export function collapsedGeometryReason(type: 'LineString' | 'Polygon', positions: readonly number[][]): string | null {
  if (type === 'LineString') {
    return distinctLonLat(positions) < 2
      ? 'The line collapses to a single longitude/latitude (it is vertical or shorter than the coordinate precision), so no LineString can be written. The measured values are kept with the feature.'
      : null;
  }
  const distinct = distinctLonLat(positions);
  let span = 0;
  for (const q of positions) for (const r of positions) span = Math.max(span, Math.abs(q[0] - r[0]), Math.abs(q[1] - r[1]));
  // Relative test: a ring whose area is negligible against its own extent is
  // a line in plan (rounding at 1e-8 degrees leaves a sliver, not exactly 0).
  if (distinct < 3 || !(lonLatRingArea(positions) > 1e-9 * span * span)) {
    return 'The ring has no plan area in longitude/latitude (it is vertical or collinear in plan), so no valid Polygon can be written. The measured values are kept with the feature.';
  }
  return null;
}

/** GeoJSON geometry for a kind, validated in the output frame, plus the source heights of its points. */
function geometryFor(
  m: Measurement,
  ctx: MeasurementExportContext,
  lonLat: GeoJsonLonLat,
): { geometry: GeoJsonGeometry | null; withheld: string | null; elevations: (number | null)[] } | null {
  const g = geometryPoints(m, ctx);
  if (!g) return null;
  const out = g.points.map((p) => ctx.toOutput(p, m));
  const positions = out.map((p) => lonLatPosition(lonLat, p));
  const elevations = out.map((p) => {
    const z = lonLat.map(p)[2];
    return Number.isFinite(z) ? Math.round(z * 1e4) / 1e4 : null;
  });
  const withheld = collapsedGeometryReason(g.type, positions);
  if (withheld) return { geometry: null, withheld, elevations };
  if (g.type === 'LineString') return { geometry: { type: 'LineString', coordinates: positions }, withheld: null, elevations };
  // RFC 7946 §3.1.6: an exterior ring is counter-clockwise. A ring picked
  // clockwise is reversed, with its elevations kept in the same order.
  const cw = signedLonLatRingArea(positions) < 0;
  const ccw = cw ? positions.slice().reverse() : positions;
  const ring = ccw.concat([ccw[0]]); // close the ring (RFC 7946)
  return { geometry: { type: 'Polygon', coordinates: [ring] }, withheld: null, elevations: cw ? elevations.slice().reverse() : elevations };
}

/** The withheld keys as nulls, and why, for a record with figures below its position step. */
function unresolvedProps(m: Measurement, ctx: MeasurementExportContext, steps: AxisSteps | null): Record<string, unknown> {
  const vv = ctx.verticalUnitToMetres ?? ctx.unitToMetres;
  const keys = unresolvedMetricKeys(m, ctx.up, ctx.unitToMetres, vv, steps);
  if (keys.length === 0 || !steps) return {};
  return { ...Object.fromEntries(keys.map((k) => [k, null])), not_resolved: unresolvedReason(steps, ctx.up, ctx.unitToMetres, vv) };
}

/** The `area_withheld` property for a record whose ring establishes no area. */
function areaNoteProp(m: Measurement, ctx: MeasurementExportContext): { area_withheld?: string; angle_withheld?: string; volume_withheld?: string } {
  const note = areaWithheldNote(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres);
  const angle = angleWithheldNote(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres);
  const box = boxVolumeWithheldNote(m, ctx.up);
  return { ...(note ? { area_withheld: note } : {}), ...(angle ? { angle_withheld: angle } : {}), ...(box ? { volume_withheld: box } : {}) };
}

/**
 * Serialise measurements to an RFC 7946 GeoJSON FeatureCollection
 * (pretty-printed): geometry in WGS 84 longitude/latitude, no `crs` member.
 * The measured values in the properties are the ones computed in the source
 * projected/metric frame, exactly as the CSV carries them; nothing is
 * recomputed from the degrees. Throws {@link GeoJsonLonLatError} when
 * `ctx.lonLat` is absent or a point cannot be placed.
 */
export function measurementsToGeoJSON(
  measurements: readonly Measurement[],
  ctx: MeasurementExportContext,
): string {
  const lonLat = ctx.lonLat;
  if (!lonLat) throw new GeoJsonLonLatError(GEOJSON_NEEDS_LONLAT);
  // Same rule as the CSV: with no resolved scale the property names say source
  // units rather than asserting metres to a parser.
  const unitsKnown = ctx.unitsVerified ?? true;
  const features = measurements
    .map((m) => {
      const placed = geometryFor(m, ctx, lonLat);
      if (!placed) return null;
      const geometry = placed.geometry;
      // A figure the geographic frame refuses stays as its key with a null
      // value, and the feature says why, so a reader sees it was withheld
      // rather than never computed.
      const steps = ctx.positionSteps?.(m) ?? null;
      const metrics = geographicFilter(
        measurementMetrics(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres, 3, steps),
        m,
        ctx.geographic,
        ctx.verticalRefused,
        ctx.verticalScaleInvalid,
      );
      const refused = refusalNote(m, ctx.geographic, ctx.verticalRefused, ctx.verticalScaleInvalid);
      const properties: Record<string, unknown> = {
        id: m.id,
        name: m.name,
        kind: m.kind,
        ...(ctx.sourceOf ? { source: ctx.sourceOf(m) } : {}),
        ...(unitsKnown ? metrics : inSourceUnits(metrics)),
        ...(refused ? { not_available: refused } : {}),
        ...unresolvedProps(m, ctx, steps),
        ...areaNoteProp(m, ctx),
        ...(placed.withheld ? { geometry_withheld: placed.withheld } : {}),
        ...(lonLat.sourceHeights ? { elevations_source: placed.elevations } : {}),
      };
      if (ctx.crsName) properties.crs = ctx.crsName;
      // Same coverage verdict the CSV's grid_authority column carries — see
      // measurementsToCsv.
      if (m.kind === 'volume' && m.volume?.gridAuthority) properties.grid_authority = gridAuthorityExportValue(m.volume.gridAuthority);
      if (m.kind === 'volume' && m.volume?.method) properties.volume_method = m.volume.method;
      const baseLevel = volumeBaseLevel(m, ctx);
      if (baseLevel !== null) properties.base_level = baseLevel;
      const w = m.kind === 'volume' ? m.volume?.withheld : undefined;
      if (w) Object.assign(properties, { source_points: w.source, withheld_excluded: w.excluded, analysed_points: w.analysed });
      // Only a volume measured on a reduced source states how; a whole one adds nothing.
      if (w?.reduction) Object.assign(properties, reductionExportFields(w));
      return { type: 'Feature' as const, geometry, properties };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  // RFC 7946: WGS 84 lon/lat and no `crs` member. The source CRS stays as
  // each feature's `crs` property; how the degrees were reached, and whether
  // a height was written, is stated once here.
  const fc: Record<string, unknown> = {
    type: 'FeatureCollection',
    features,
    coordinate_note: [lonLat.datumCaveat, lonLat.altitudeNote].filter(Boolean).join(' '),
  };
  if (lonLat.sourceHeights) {
    const { verticalDatum, unit } = lonLat.sourceHeights;
    fc.vertical_reference = {
      elevations_source_datum: verticalDatum ?? 'not declared',
      elevations_source_unit: unit,
      note: 'elevations_source lists each geometry vertex\'s source elevation in this datum and unit, unconverted. It is not an RFC 7946 (WGS 84 ellipsoidal) height.',
    };
  }
  // Route the export through the ONE evidence gate (PR6): measurements sit below
  // their required evidence level, so the file carries the exploratory verdict
  // rather than leaving with no gate stamp at all. RFC 7946 permits foreign
  // members on a FeatureCollection, so a reader that ignores it is unaffected.
  // Each kind present gets its own verdict; a mixed file carries them all
  // rather than one kind's answer standing in for the rest.
  const claims = claimsPresent(measurements);
  const evidence =
    claims.map((c) => `${c}: ${evidenceNote(c)}`).join(' ')
    + unverifiedUnitsCaveat(ctx.unitsVerified ?? true)
    + geographicRefusalCaveat(measurements.some((m) => refusalNote(m, ctx.geographic, ctx.verticalRefused, ctx.verticalScaleInvalid) === GEOGRAPHIC_NOT_AVAILABLE))
    + verticalRefusalCaveat(measurements.some((m) => refusalNote(m, ctx.geographic, ctx.verticalRefused, ctx.verticalScaleInvalid) === VERTICAL_NOT_AVAILABLE))
    + verticalScaleRefusalCaveat(measurements.some((m) => refusalNote(m, ctx.geographic, ctx.verticalRefused, ctx.verticalScaleInvalid) === VERTICAL_SCALE_NOT_AVAILABLE));
  // A collection with nothing in it makes no claim, so there is no verdict to
  // carry — and an `evidence: ""` member would be a field that says nothing
  // where a reader expects a statement. The key is omitted instead.
  if (evidence) fc.evidence = evidence;
  if (ctx.provenance) fc.provenance = lightProvenance(ctx.provenance);
  return JSON.stringify(fc, null, 2);
}

/**
 * The registered claim each measurement kind's headline figure belongs to.
 *
 * One hardcoded `MEAS-DISTANCE` stamped every row and every collection, so a
 * CSV of profiles carried the distance claim's exploratory verdict although
 * `MEAS-PROFILE` meets its required level, and a CSV of volumes was stamped
 * with a claim that never evaluated a volume. A record naming the wrong claim
 * is the same defect as one naming the wrong method.
 */
const CLAIM_FOR_KIND: Readonly<Record<Measurement['kind'], string>> = {
  distance: 'MEAS-DISTANCE',
  polyline: 'MEAS-DISTANCE',
  area: 'MEAS-AREA',
  height: 'MEAS-HEIGHT',
  angle: 'MEAS-ANGLE',
  slope: 'MEAS-ANGLE',
  profile: 'MEAS-PROFILE',
  box: 'MEAS-BOX',
  volume: 'VOL-POINT-SAMPLE',
};

/**
 * The exported `grid_authority` value. The stored top tier `measured` is
 * written `exploratory_full_coverage`: VOL-STOCKPILE is an exploratory volume
 * preview at every tier, and full coverage is all that tier adds. `preview`
 * and `withheld` are written as stored.
 */
export function gridAuthorityExportValue(a: 'measured' | 'preview' | 'withheld'): string {
  return a === 'measured' ? 'exploratory_full_coverage' : a;
}

/**
 * The area-weighted grid's bare id (no `@version` — this file names a claim,
 * not a method tag, and `lint:method-literals` only walks `id@version`
 * strings). Kept beside `CLAIM_FOR_KIND` rather than duplicated at each call
 * site below.
 */
const GRID_METHOD_ID = 'olv.volume.stockpile-area-grid';

/**
 * The claim a measurement's headline figure actually belongs to. `kind` alone
 * decided this alone before the lasso record moved to the grid: every `'volume'` measurement was stamped
 * `VOL-POINT-SAMPLE`, which is wrong for a lasso record the grid now owns —
 * the same defect `CLAIM_FOR_KIND`'s own docstring names, one level down.
 *
 * A withheld grid published no figure at all: `fill`/`cut`/`net` are absent
 * (session.ts's parser and withStockpileGrid both refuse to smuggle numbers
 * past a withheld verdict), and the row's only actual numbers are the
 * `crossCheck`'s point-sample ones. Naming VOL-STOCKPILE there would stamp an
 * estimator that contributed nothing, so a withheld record falls through to
 * the point-sample claim that produced what the row actually shows.
 */
function claimForMeasurement(m: Measurement): string | undefined {
  if (
    m.kind === 'volume'
    && m.volume?.method?.startsWith(GRID_METHOD_ID)
    && m.volume.gridAuthority !== 'withheld'
  ) return 'VOL-STOCKPILE';
  return CLAIM_FOR_KIND[m.kind];
}

/**
 * The claims a mixed collection actually draws on, in a stable order so two
 * exports of the same set produce the same stamp.
 *
 * The comparator is explicit, and it is deliberately NOT `localeCompare`.
 * These ids are stamped into a provenance record, so the order has to be the
 * same everywhere: `localeCompare` is locale-dependent, and would let the same
 * measurement set produce a differently ordered stamp on a machine with a
 * different locale — losing exactly the stability this function exists for.
 * Code-unit order over an ASCII id set is total, deterministic and machine
 * independent.
 */
function claimsPresent(measurements: readonly Measurement[]): string[] {
  const seen = new Set<string>();
  for (const m of measurements) {
    const c = claimForMeasurement(m);
    if (c) seen.add(c);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Stable CSV column order — every metric any kind can emit, plus identity, and
 * a trailing `evidence` column carrying the ONE gate verdict (PR §19). The
 * GeoJSON export stamps the full note once at collection level; a CSV has no
 * document header, so the honest status rides one column per row instead —
 * every measurement row states the same central claim status, so a spreadsheet
 * of measurements can never read as a validated deliverable when the registry
 * says it is only exploratory.
 */
/**
 * What a unit-bearing column is called when the scan's linear scale was never
 * resolved.
 *
 * A row used to carry `length_m` beside an evidence cell reading
 * "units-unverified (source render units, not metres)". A human reads both; a
 * program reading the header reads metres and is not told otherwise. The value
 * is a source-unit number in that case, so the column says so. Longest suffix
 * first: `_m3` and `_m2` must not be matched as `_m`.
 */
const SOURCE_UNIT_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['_m3', '_source3'],
  ['_m2', '_source2'],
  ['_m', '_source'],
];

/** A metric column name, rewritten to name the source unit instead. */
export function sourceUnitKey(key: string): string {
  for (const [metric, source] of SOURCE_UNIT_SUFFIXES) {
    if (key.endsWith(metric)) return `${key.slice(0, -metric.length)}${source}`;
  }
  return key;
}

/**
 * A polygon volume's base level in the output frame's vertical: the reference
 * plane's height, carried to the output through the same mapping as the
 * vertices, so the CSV and GeoJSON state it beside the coordinates it applies
 * to. Null for every other kind, and when the frame refuses heights.
 */
function volumeBaseLevel(m: Measurement, ctx: MeasurementExportContext): number | null {
  const v = m.volume;
  const p = m.points[0];
  if (m.kind !== 'volume' || !v || !p || !Number.isFinite(v.referenceZ) || ctx.verticalRefused || ctx.verticalScaleInvalid) return null;
  const up = ctx.up;
  const d = v.referenceZ - (p[0] * up[0] + p[1] * up[1] + p[2] * up[2]);
  const onPlane: Vec3 = [p[0] + d * up[0], p[1] + d * up[1], p[2] + d * up[2]];
  return roundMeasured(ctx.toOutput(onPlane, m)[2]);
}

/** Rewrite every unit-bearing key of a metrics record. Unitless keys pass through. */
function inSourceUnits<T>(metrics: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(metrics).map(([k, v]) => [sourceUnitKey(k), v]));
}

const CSV_COLUMNS = [
  'id', 'name', 'kind', 'source', 'vertices',
  'length_m', 'horizontal_m', 'vertical_m', 'rise_m', 'run_m',
  'grade_pct', 'angle_deg', 'area_m2', 'horizontal_area_m2', 'perimeter_m',
  'width_m', 'depth_m', 'height_m', 'volume_m3', 'cut_m3', 'fill_m3', 'net_m3',
  // A polygon volume's base level, in the output frame's vertical like the geometry.
  'base_level',
  // A grid-owned lasso volume's coverage verdict, and the point-sample
  // cross-check kept beside its canonical cut_m3/fill_m3/net_m3 above — blank
  // on every other kind, and on a volume record from before the switch or
  // from the hand-drawn polygon tool, which has no grid counterpart.
  'coverage_fraction', 'interpolated_fraction', 'excluded_fraction', 'volume_method',
  'grid_authority', 'pointsample_cut_m3', 'pointsample_fill_m3', 'pointsample_net_m3',
  // A lasso result's input counts; `withheld_excluded` reads `unknown` when
  // the source carried no flags, never 0.
  'source_points', 'withheld_excluded', 'analysed_points',
  'evidence',
] as const;

/**
 * Appended after `evidence` when a volume rode on a reduced source. A noise
 * count reads `unavailable` where the source's labels could not support one,
 * never 0.
 */
const REDUCTION_CSV_COLUMNS = [
  'noise_excluded', 'reduction_mode', 'resident_points', 'declared_points', 'reduction_caveat',
] as const;

/**
 * Escape a CSV cell per RFC 4180 (quote when it contains , " CR or LF), and
 * neutralise spreadsheet formula injection. A string cell that begins with
 * `= + - @` or a tab/CR is interpreted as a formula by Excel/Sheets; a
 * measurement name like `=HYPERLINK(...)` round-tripped through a shared
 * `.olvsession` is attacker-controlled, so we prefix a literal `'` (the
 * conventional neutraliser) and force-quote to keep it. Numeric cells are never
 * neutralised, so a negative value like `-1.5` stays a plain number.
 */
function csvCell(v: string | number): string {
  const s = typeof v === 'number' ? plainDecimal(v) : String(v);
  const neutralise = typeof v === 'string' && /^[=+\-@\t\r]/.test(s);
  const cell = neutralise ? `'${s}` : s;
  return neutralise || /[",\r\n]/.test(cell) ? `"${cell.replaceAll(/"/g, '""')}"` : cell;
}

/** Serialise measurements to a CSV — one row per measurement, metres throughout. */
export function measurementsToCsv(
  measurements: readonly Measurement[],
  ctx: MeasurementExportContext,
): string {
  // With no resolved scale the values are source-unit numbers, so the header
  // names them that way rather than asserting metres a parser would believe.
  const unitsKnown = ctx.unitsVerified ?? true;
  // The reduction columns exist only when some volume rode on a reduced
  // source, so every other export keeps the header it always had.
  const reducedColumns = measurements.some((m) => m.kind === 'volume' && m.volume?.withheld?.reduction)
    ? REDUCTION_CSV_COLUMNS
    : [];
  const columns = [...(unitsKnown ? CSV_COLUMNS : CSV_COLUMNS.map(sourceUnitKey)), ...reducedColumns];
  const rows: string[] = [columns.join(',')];
  // Route the CSV through the SAME one gate the GeoJSON path uses (PR §19):
  // measurements sit below their required evidence level, so every row carries
  // the exploratory verdict rather than leaving with no gate stamp at all.
  // The gate token, plus a units-unverified marker when the scan has no known
  // scale so a spreadsheet reader sees the same caveat the GeoJSON note carries
  // — the `_m` columns then read as nominal, not confirmed metres (M1).
  // Per ROW, because a CSV holds mixed kinds and one kind's verdict is not
  // the others'. `MEAS-PROFILE` meets its required level where `MEAS-DISTANCE`
  // does not, so stamping every row with the distance answer understated one
  // and misnamed the claim behind the rest.
  // A row the geographic frame refuses also names that in its evidence cell;
  // its refused figures are empty cells, and its pure-vertical ones remain.
  const evidenceFor = (m: Measurement): string => {
    const status = evidenceStatus(claimForMeasurement(m) ?? 'MEAS-DISTANCE');
    const units = unitsKnown ? status : `${status}; units-unverified (source render units, not metres)`;
    const refused = refusalNote(m, ctx.geographic, ctx.verticalRefused, ctx.verticalScaleInvalid);
    const withGeo = refused ? `${units}; ${refused}` : units;
    const note = areaWithheldNote(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres)
      ?? angleWithheldNote(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres)
      ?? boxVolumeWithheldNote(m, ctx.up);
    const withNote = note ? `${withGeo}; ${note}` : withGeo;
    const unresolved = unresolvedNote(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres, ctx.positionSteps?.(m) ?? null);
    return unresolved ? `${withNote}; ${unresolved}` : withNote;
  };
  for (const m of measurements) {
    const all = measurementMetrics(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres, 3, ctx.positionSteps?.(m) ?? null);
    // Refused figures are dropped, so the cell is empty like any figure the
    // geometry cannot establish.
    const raw = geographicRefuses(m, ctx.geographic, ctx.verticalRefused, ctx.verticalScaleInvalid)
      ? Object.fromEntries(Object.entries(all).filter(([k]) => keptUnderRefusal(m, k, ctx.geographic, ctx.verticalRefused, ctx.verticalScaleInvalid)))
      : all;
    const metrics = unitsKnown ? raw : inSourceUnits(raw);
    const base: Record<string, string | number> = {
      id: m.id,
      name: m.name,
      kind: m.kind,
      ...(ctx.sourceOf ? { source: ctx.sourceOf(m) ?? '' } : {}),
      vertices: m.points.length,
      ...metrics,
      evidence: evidenceFor(m),
    };
    if (m.kind === 'volume' && m.volume?.gridAuthority) base.grid_authority = gridAuthorityExportValue(m.volume.gridAuthority);
    if (m.kind === 'volume' && m.volume?.method) base.volume_method = m.volume.method;
    const baseLevel = volumeBaseLevel(m, ctx);
    if (baseLevel !== null) base.base_level = baseLevel;
    const w = m.kind === 'volume' ? m.volume?.withheld : undefined;
    if (w) Object.assign(base, { source_points: w.source, withheld_excluded: w.excluded, analysed_points: w.analysed });
    if (w?.reduction) Object.assign(base, reductionExportFields(w));
    rows.push(columns.map((c) => (c in base ? csvCell(base[c]) : '')).join(','));
  }
  return rows.join('\n');
}

/** Source-file digest and CRS origin for this export's provenance, resolved off the main thread. */
export { resolveExportDigests } from './exportDigests';

/** The `<name>.provenance.txt` sidecar written beside a measurement CSV. */
export { measurementCsvProvenance, provenanceSidecarName } from './exportProvenanceLines';
