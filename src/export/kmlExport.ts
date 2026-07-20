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
  /** Map a LOCAL render-space point to geographic [lon, lat, altMetres]. */
  readonly toLonLat: (local: readonly [number, number, number]) => [number, number, number];
  /** The "not survey-grade" caveat, embedded in every description. */
  readonly notSurveyGradeNote: string;
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
function coord(lonLatAlt: [number, number, number]): string {
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
  return `${fmt(lon)},${fmt(lat)},${fmt(alt)}`;
}

/** Map LOCAL points to a space-separated KML <coordinates> string. */
function coordsOf(
  points: readonly Vec3[],
  toLonLat: KmlExportInput['toLonLat'],
): string {
  return points.map((p) => coord(toLonLat(p))).join(' ');
}

/** The shared provenance + caveat block appended to every description. */
function caveatBlock(input: KmlExportInput): string {
  const crs = input.crsName ?? 'unknown CRS';
  return `CRS: ${crs}. Units: ${input.unitLabel}. ${input.notSurveyGradeNote}`;
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
  const lines = [a.note ?? '', `Category: ${a.type}`, caveatBlock(input)];
  return [
    '<Placemark>',
    `<name>${esc(a.title)}</name>`,
    description(lines),
    '<Point>',
    `<coordinates>${coord(lonLatAlt)}</coordinates>`,
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
  const lines = [metricsLine(m, input), `Kind: ${m.kind}`, caveatBlock(input)];
  const desc = description(lines);

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
      `<coordinates>${coordsOf(ring, input.toLonLat)}</coordinates>`,
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
    `<coordinates>${coordsOf(m.points, input.toLonLat)}</coordinates>`,
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
    description(['Saved viewpoint', caveatBlock(input)]),
    '<LookAt>',
    `<longitude>${fmt(anchor[0])}</longitude>`,
    `<latitude>${fmt(anchor[1])}</latitude>`,
    `<altitude>${fmt(anchor[2])}</altitude>`,
    '<heading>0</heading>',
    '<tilt>45</tilt>',
    `<range>${fmt(range)}</range>`,
    '<altitudeMode>absolute</altitudeMode>',
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
