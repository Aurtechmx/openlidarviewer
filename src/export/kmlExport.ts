/**
 * kmlExport.ts
 *
 * A pure serializer that lets placed annotations, measurements, and saved
 * viewpoints LEAVE the tool as a KML 2.2 document for Google Earth / QGIS, in
 * georeferenced lon/lat/alt. It mirrors the GeoJSON/CSV path in
 * `measurementExport.ts`: the same "not survey-grade" honesty caveat, a carried
 * CRS name + unit label, and a caller-injected coordinate transform.
 *
 * Pure: no DOM, no proj4, no three.js. `toLonLat` maps a LOCAL render-space
 * point into geographic [lon, lat, altMetres]; injecting it keeps the module
 * free of the CRS service and fully unit-testable. The UI gates this export on
 * a known georeference, so `toLonLat` is always supplied.
 *
 * Honesty intent: the caveat (unit label, CRS name, "not survey-grade") travels
 * INSIDE every feature's <description> as well as the <Document> description —
 * so when the .kml is shared, opened, or split, the provenance and the
 * not-survey-grade warning cannot be lost from any individual feature.
 *
 * Coordinate order is KML's: lon,lat,alt — NOT lat,lon. All text and attribute
 * content is XML-escaped (& < > " ').
 */

import type { Annotation } from '../render/annotate/types';
import type { Measurement, Vec3 } from '../render/measure/types';
import { isComplete } from '../render/measure/types';
import { measurementMetrics } from './measurementExport';
import { verticalReferenceKey } from '../model/layerCompatibility';
import type { LocalToLonLatSourceZ } from './lonLatMapper';

/**
 * A saved camera viewpoint to serialise as a KML <LookAt> placemark.
 * `position` and `target` are LOCAL render-space [x, y, z] (the same space as
 * annotations and measurement points); `toLonLat` maps them to geographic.
 */
export interface KmlViewpoint {
  /** User-facing label for the placemark. */
  name: string;
  /** Camera eye position, LOCAL render-space [x, y, z]. */
  position: [number, number, number];
  /** Optional look-at target, LOCAL render-space [x, y, z]. */
  target?: [number, number, number];
}

/** Everything the KML document is built from, plus the injected transform. */
export interface KmlExportInput {
  /** Annotations → <Point> placemarks. */
  readonly annotations: readonly Annotation[];
  /** Measurements → <LineString> / <Polygon> placemarks. */
  readonly measurements: readonly Measurement[];
  /** Saved viewpoints → <LookAt> placemarks. */
  readonly viewpoints: readonly KmlViewpoint[];
  /** CRS label, surfaced in the document + every feature description. */
  readonly crsName: string | null;
  /** Unit label for the reported metric values (always metres here, "m"). */
  readonly unitLabel: string;
  /** World up vector for the height / grade / slope derivations (parity with the GeoJSON/CSV path). */
  readonly up: Vec3;
  /** Render-units → metres, so measured values report true metres (1 for metric scans; e.g. 0.3048 for US-foot). */
  readonly unitToMetres: number;
  /** Vertical render-units → metres (up-axis). Defaults to `unitToMetres`; scales
   *  heights/drops/volumes for a compound CRS to match the panel headline. */
  readonly verticalUnitToMetres?: number;
  /**
   * Map a LOCAL render-space point to [lon, lat, sourceZ]. Only the first two
   * are converted; the third is the SOURCE height, in the source's own unit
   * and on the source's own vertical reference — see {@link LocalToLonLatSourceZ}.
   */
  readonly toLonLat: LocalToLonLatSourceZ;
  /** The "not survey-grade" caveat, embedded in every description. */
  readonly notSurveyGradeNote: string;
  /**
   * Declared vertical datum of the source heights, or null when undeclared.
   * Decides the geometry's `<altitudeMode>`: KML's `absolute` means metres
   * above mean sea level, so it may only be claimed for a metric orthometric
   * datum. Anything else clamps to ground and says why.
   */
  readonly verticalDatum?: string | null;
}

/**
 * The vertical references for which KML `absolute` is a TRUE statement.
 *
 * `absolute` in KML 2.2 means metres above MEAN SEA LEVEL specifically. The
 * gate here used to be "a datum string exists and the unit factor is 1", which
 * a WGS 84 ellipsoidal height passes — and an ellipsoidal height is not a
 * sea-level height, it is off by the geoid separation, tens of metres in
 * places. A depth axis passes that gate too and is sign-flipped as well.
 *
 * So this is an allow-list, not a deny-list: an unrecognised reference does
 * not qualify. Keys are {@link verticalReferenceKey} identities, so a datum
 * that arrives as a catalog name ("NAVD88") and one that arrives as a code
 * ("EPSG:5703") are the same entry.
 */
const ORTHOMETRIC_METRIC_VERTICAL: ReadonlySet<string> = new Set([
  'epsg:5703', // NAVD88 height (metres)
  'epsg:5714', // MSL height (metres) — the definition itself
  'epsg:3855', // EGM2008 geoid height (metres)
  'epsg:5773', // EGM96 geoid height (metres)
]);

/**
 * KML altitude mode for a set of heights, and the reason for it.
 *
 * With no `<altitudeMode>` a reader applies the default, `clampToGround`, and
 * the altitude in `<coordinates>` is silently discarded — the geometry drapes
 * onto whatever terrain the viewer has. That is not wrong, but it is invisible:
 * nothing tells the reader the heights were dropped. Declaring the mode makes
 * the treatment explicit either way, and `absolute` is claimed only for a
 * vertical reference that actually means metres above sea level.
 */
export function kmlAltitudeMode(
  verticalDatum: string | null | undefined,
  verticalUnitToMetres: number | undefined,
): { mode: 'absolute' | 'clampToGround'; reason: string } {
  const metric = verticalUnitToMetres === undefined || Math.abs(verticalUnitToMetres - 1) < 1e-9;
  const declared = verticalDatum?.trim();
  if (!declared) {
    return {
      mode: 'clampToGround',
      reason:
        'Heights are clamped to ground: the source declares no vertical datum, so no absolute '
        + 'elevation can be claimed. Altitudes in this file are not authoritative.',
    };
  }
  if (!metric) {
    return {
      mode: 'clampToGround',
      reason:
        'Heights are clamped to ground: the source vertical unit is not metres, and KML absolute '
        + 'altitude is defined in metres. Altitudes in this file are not authoritative.',
    };
  }
  if (!ORTHOMETRIC_METRIC_VERTICAL.has(verticalReferenceKey({ id: 'kml', verticalDatum: declared }) ?? '')) {
    return {
      mode: 'clampToGround',
      reason:
        `Heights are clamped to ground: ${declared} is not a recognised metric height above mean `
        + 'sea level, so KML absolute altitude cannot be claimed for it. Altitudes in this file '
        + 'are not authoritative.',
    };
  }
  return {
    mode: 'absolute',
    reason: `Altitudes are absolute metres above mean sea level on ${declared}.`,
  };
}

/** Escape text for XML content / attribute values (& < > " '). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Raised when a coordinate cannot be expressed as a real longitude/latitude.
 * Exported so the caller can decline the whole export: KML coordinates are
 * geographic BY SPECIFICATION, so one unplaceable feature makes the file wrong
 * rather than incomplete.
 */
export class KmlCoordinateError extends Error {}

/** Format a finite number to at most 6 decimals (trailing zeros trimmed). */
function fmt(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/**
 * A single "lon,lat,alt" tuple in KML order, refusing anything that is not a
 * real geographic position.
 *
 * A non-finite value used to format as `'0'`, which placed the feature at 0°N
 * 0°E — a point in the Gulf of Guinea — and read as a successful export of a
 * real place. The domain check catches the other shape of the same mistake: a
 * projected easting that reached here as a longitude is perfectly finite and
 * still impossible.
 */
function coord(lonLatAlt: readonly [number, number, number], withAltitude: boolean): string {
  const [lon, lat, alt] = lonLatAlt;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(alt)) {
    throw new KmlCoordinateError(
      `A coordinate is not a finite number (${lon}, ${lat}, ${alt}), so it cannot be placed on the map.`,
    );
  }
  if (lon < -180 || lon > 180) {
    throw new KmlCoordinateError(
      `Longitude ${lon} is outside -180..180 — these look like projected coordinates, not degrees.`,
    );
  }
  if (lat < -90 || lat > 90) {
    throw new KmlCoordinateError(
      `Latitude ${lat} is outside -90..90 — these look like projected coordinates, not degrees.`,
    );
  }
  // A 2D tuple when the vertical reference is unproven: `clampToGround` tells
  // a compliant reader to ignore the ordinate, but writing it anyway leaves a
  // number in the file that another tool will happily read back as a height.
  // Omitting it is the only form that cannot be mistaken for a claim.
  return withAltitude ? `${fmt(lon)},${fmt(lat)},${fmt(alt)}` : `${fmt(lon)},${fmt(lat)}`;
}

/** Map LOCAL points to a space-separated KML <coordinates> string. */
function coordsOf(
  points: readonly Vec3[],
  toLonLat: KmlExportInput['toLonLat'],
  withAltitude: boolean,
): string {
  return points.map((p) => coord(toLonLat(p), withAltitude)).join(' ');
}

/** The shared provenance + caveat block appended to every description. */
function altMode(input: KmlExportInput) {
  return kmlAltitudeMode(input.verticalDatum, input.verticalUnitToMetres);
}

/**
 * The source height as a stated value — magnitude, unit, vertical reference.
 *
 * The geometry drops the ordinate whenever the vertical reference is unproven,
 * and dropping it silently would destroy the one number the reader might still
 * be able to use with their own knowledge of the site. So it is disclosed here
 * instead, labelled with everything needed to interpret it and with nothing
 * asserted about sea level.
 */
function sourceElevationLine(input: KmlExportInput, sourceZ: number): string {
  const f = input.verticalUnitToMetres;
  const unit =
    f === undefined || Math.abs(f - 1) < 1e-9
      ? 'metres'
      : `source vertical units (1 unit = ${fmt(f)} m)`;
  const datum = input.verticalDatum?.trim() || 'undeclared';
  return `Source elevation: ${fmt(sourceZ)} ${unit}, vertical datum: ${datum}.`;
}

function caveatBlock(input: KmlExportInput): string {
  // The altitude treatment belongs in the human-readable block too — a mode
  // tag is invisible in Google Earth's UI, and a dropped height should not be
  // something the reader has to open the XML to discover.
  const crs = input.crsName ?? 'unknown CRS';
  return `CRS: ${crs}. Units: ${input.unitLabel}. ${altMode(input).reason} ${input.notSurveyGradeNote}`;
}

/** Build an escaped <description> from plain text lines. */
function description(lines: readonly string[]): string {
  const body = lines.filter((l) => l.length > 0).join('\n');
  return `<description>${esc(body)}</description>`;
}

/** One annotation → a <Point> placemark. */
function annotationPlacemark(a: Annotation, input: KmlExportInput): string {
  const lonLatAlt = input.toLonLat([
    a.localPosition.x,
    a.localPosition.y,
    a.localPosition.z,
  ]);
  const lines = [
    a.note ?? '',
    `Category: ${a.type}`,
    sourceElevationLine(input, lonLatAlt[2]),
    caveatBlock(input),
  ];
  return [
    '<Placemark>',
    `<name>${esc(a.title)}</name>`,
    description(lines),
    '<Point>',
    `<altitudeMode>${altMode(input).mode}</altitudeMode>`,
    `<coordinates>${coord(lonLatAlt, altMode(input).mode === 'absolute')}</coordinates>`,
    '</Point>',
    '</Placemark>',
  ].join('');
}

/**
 * A human-readable line of the measurement's derived metrics, in METRES.
 * Uses the caller's world up + unit scale (parity with the GeoJSON/CSV path),
 * so a foot-based scan reports true metres rather than raw render units.
 */
function metricsLine(m: Measurement, input: KmlExportInput): string {
  const metrics = measurementMetrics(m, input.up, input.unitToMetres, input.verticalUnitToMetres);
  const parts = Object.entries(metrics).map(([k, v]) => `${k}=${v}`);
  if (parts.length === 0) return '';
  return `Measured (${input.unitLabel}): ${parts.join(', ')}`;
}

/** Area-like kinds become a closed <Polygon>; everything else a <LineString>. */
function isAreaKind(kind: Measurement['kind']): boolean {
  return kind === 'area' || kind === 'volume';
}

/** One measurement → a <LineString> or <Polygon> placemark, or null. */
function measurementPlacemark(m: Measurement, input: KmlExportInput): string | null {
  if (!isComplete(m)) return null;
  // Guarded: the degenerate-geometry checks below run after this, and a
  // zero-point measurement would otherwise be converted here.
  const first = m.points.length > 0 ? input.toLonLat(m.points[0]) : null;
  const lines = [
    metricsLine(m, input),
    `Kind: ${m.kind}`,
    first ? sourceElevationLine(input, first[2]) : '',
    caveatBlock(input),
  ];
  const desc = description(lines);
  const withAltitude = altMode(input).mode === 'absolute';

  if (isAreaKind(m.kind)) {
    if (m.points.length < 3) return null;
    const ring = m.points.slice();
    ring.push(m.points[0]); // close the outer ring
    return [
      '<Placemark>',
      `<name>${esc(m.name)}</name>`,
      desc,
      '<Polygon>',
      '<outerBoundaryIs>',
      '<LinearRing>',
      `<altitudeMode>${altMode(input).mode}</altitudeMode>`,
      `<coordinates>${coordsOf(ring, input.toLonLat, withAltitude)}</coordinates>`,
      '</LinearRing>',
      '</outerBoundaryIs>',
      '</Polygon>',
      '</Placemark>',
    ].join('');
  }

  if (m.points.length < 2) return null;
  return [
    '<Placemark>',
    `<name>${esc(m.name)}</name>`,
    desc,
    '<LineString>',
    `<altitudeMode>${altMode(input).mode}</altitudeMode>`,
    `<coordinates>${coordsOf(m.points, input.toLonLat, withAltitude)}</coordinates>`,
    '</LineString>',
    '</Placemark>',
  ].join('');
}

/** One viewpoint → a <LookAt> placemark anchored at its target (or eye). */
function viewpointPlacemark(v: KmlViewpoint, input: KmlExportInput): string {
  const eye = input.toLonLat(v.position);
  const anchor = v.target ? input.toLonLat(v.target) : eye;
  const dLon = eye[0] - anchor[0];
  const dLat = eye[1] - anchor[1];
  const dAlt = eye[2] - anchor[2];
  // Degrees are not metres; combine the planar great-circle estimate with the
  // altitude delta and a 1 m floor. A viewpoint hint, not a survey value —
  // consistent with the not-survey-grade caveat.
  const range = Math.max(Math.abs(dAlt), Math.hypot(dLon, dLat) * 111_320, 1);
  return [
    '<Placemark>',
    `<name>${esc(v.name)}</name>`,
    description(['Saved viewpoint', sourceElevationLine(input, anchor[2]), caveatBlock(input)]),
    '<LookAt>',
    `<longitude>${fmt(anchor[0])}</longitude>`,
    `<latitude>${fmt(anchor[1])}</latitude>`,
    // Zero unless the height is a proven sea-level metre value — the same
    // policy the geometry applies, so the camera cannot restate a claim the
    // features were denied.
    `<altitude>${altMode(input).mode === 'absolute' ? fmt(anchor[2]) : '0'}</altitude>`,
    '<heading>0</heading>',
    '<tilt>45</tilt>',
    `<range>${fmt(range)}</range>`,
    // The same policy the geometry uses. Hardcoding `absolute` here put the
    // camera on a sea-level altitude in the very files whose features were
    // deliberately clamped because their vertical reference was unproven.
    `<altitudeMode>${altMode(input).mode}</altitudeMode>`,
    '</LookAt>',
    '</Placemark>',
  ].join('');
}

/** Serialise the full input to a complete KML 2.2 document string. */
export function buildKml(input: KmlExportInput): string {
  const placemarks: string[] = [];
  for (const a of input.annotations) placemarks.push(annotationPlacemark(a, input));
  for (const m of input.measurements) {
    const pm = measurementPlacemark(m, input);
    if (pm) placemarks.push(pm);
  }
  for (const v of input.viewpoints) placemarks.push(viewpointPlacemark(v, input));

  const crs = input.crsName ?? 'unknown CRS';
  const docDesc = description([
    `OpenLiDARViewer export. CRS: ${crs}. Units: ${input.unitLabel}.`,
    input.notSurveyGradeNote,
  ]);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    '<name>OpenLiDARViewer Export</name>',
    docDesc,
    ...placemarks,
    '</Document>',
    '</kml>',
  ].join('\n');
}
