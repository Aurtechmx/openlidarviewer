/**
 * pointInfo.ts
 *
 * Pure, DOM-free helpers for the Inspect tool: the picked-point data shape,
 * ASPRS classification names, coordinate rounding, and the clipboard / JSON
 * serialisations. Kept free of three.js and the DOM so it can be unit-tested
 * in Node; `InspectTool` renders it.
 */

import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { CrsLinearUnit } from '../io/crs';

/**
 * Labels + per-axis unit suffixes for the inspector's World coordinate group.
 *
 * The headings/labels switch on the CRS kind — Easting/Northing for a
 * projected CRS, Longitude/Latitude for a geographic one, plain X/Y/Z for
 * local/unknown. The UNIT suffixes matter as much as the labels, and there are
 * two honesty failures the suffix logic must avoid:
 *   - a geographic dataset's X/Y are DEGREES, not metres (rendering them " m"
 *     printed "Longitude: -122.4 m"); and
 *   - the axis unit of a PROJECTED CRS is its own linear unit — a foot-based
 *     survey's Easting/Northing are FEET. The card used to hardcode " m" for
 *     every projected and every local/unknown scan, so a US-survey-foot survey
 *     read as metres, and an unknown-unit scan asserted metres it never knew —
 *     directly contradicting the inspector's own "shown in source units only"
 *     note. When the linear unit is unknown we now assert NO suffix rather than
 *     fabricate metres.
 * Pure + DOM-free so it lives next to `splitPointCoords` and is unit-tested here
 * rather than dragging the three.js-bound `InspectTool` into Node.
 */
export interface WorldCoordLabels {
  readonly heading: string;
  readonly x: string;
  readonly y: string;
  readonly z: string;
  readonly xUnit: string;
  readonly yUnit: string;
  readonly zUnit: string;
}

/**
 * Axis unit suffix for a CRS's linear unit. HONESTY: an unknown linear unit
 * yields NO suffix — the coordinate is shown in bare source units, never
 * asserted as metres.
 */
function linearAxisSuffix(unit: CrsLinearUnit): string {
  switch (unit) {
    case 'metre':
      return ' m';
    case 'foot':
    case 'us-survey-foot':
      return ' ft';
    case 'unknown':
      return '';
  }
}

/** Build the World-group labels + units for a resolved CRS (or undefined). */
export function worldCoordLabels(crs: ResolvedCrs | undefined): WorldCoordLabels {
  // No CRS, local, or unknown: the coordinates are in the file's own units,
  // whose scale we do NOT know — assert no unit rather than fabricate metres.
  if (!crs || crs.kind === 'local' || crs.kind === 'unknown') {
    return { heading: 'World', x: 'X', y: 'Y', z: 'Z', xUnit: '', yUnit: '', zUnit: '' };
  }
  if (crs.kind === 'geographic') {
    return {
      heading: 'World (geographic)',
      x: 'Longitude',
      y: 'Latitude',
      z: 'Elevation',
      xUnit: '°',
      yUnit: '°',
      zUnit: ' m',
    };
  }
  // Projected: the axis unit is the CRS's own linear unit, so a foot-based CRS
  // shows Easting/Northing/Elevation in feet, not metres. Z follows the same
  // horizontal linear unit; a rare CRS with a DISTINCT vertical unit is a known
  // follow-up (the vast majority share one linear unit across all axes).
  const suffix = linearAxisSuffix(crs.linearUnit);
  return {
    heading: `World (${crs.name})`,
    x: 'Easting',
    y: 'Northing',
    z: 'Elevation',
    xUnit: suffix,
    yUnit: suffix,
    zUnit: suffix,
  };
}

/**
 * ASPRS standard point classification names, LAS 1.4 R15 (classes 0–22).
 *
 * Codes 8 and 12 are "Reserved" in LAS 1.4: in the legacy LAS 1.1–1.3 schema
 * they were Model Key-point (8) and Overlap (12). Class 12 is still very widely
 * populated as overlap in real deliveries, so it's labelled "Overlap" — the
 * meaning a user actually encounters — while 8 keeps the 1.4 "Reserved" name.
 * Codes 23–63 are reserved for future ASPRS use; 64–255 are user-definable and
 * fall through to the generic "Class N" label.
 */
const ASPRS_CLASSES: Record<number, string> = {
  0: 'Created, never classified',
  1: 'Unclassified',
  2: 'Ground',
  3: 'Low vegetation',
  4: 'Medium vegetation',
  5: 'High vegetation',
  6: 'Building',
  7: 'Low point (noise)',
  8: 'Reserved',
  9: 'Water',
  10: 'Rail',
  11: 'Road surface',
  12: 'Overlap',
  13: 'Wire — guard',
  14: 'Wire — conductor',
  15: 'Transmission tower',
  16: 'Wire-structure connector',
  17: 'Bridge deck',
  18: 'High noise',
  19: 'Overhead structure',
  20: 'Ignored ground',
  21: 'Snow',
  22: 'Temporal exclusion',
};

/** Human-readable name for an ASPRS classification code. */
export function classificationLabel(code: number): string {
  return ASPRS_CLASSES[code] ?? `Class ${code}`;
}

/** A picked point's data — coordinates already rounded for display. */
export interface PointInfo {
  /** Source layer / file name. */
  layer: string;
  /** Point index within the cloud's buffer. */
  index: number;
  /**
   * Real-world x / y / z coordinates — the cloud's local position plus the
   * origin subtracted on load — rounded to 3 decimals (millimetres). For a
   * georeferenced LAS/LAZ survey these are the absolute survey coordinates.
   */
  x: number;
  y: number;
  z: number;
  /** Straight-line distance from the camera at pick time, rounded to 2 dp. */
  distance: number;
  /** Intensity, or null when the cloud carries none. */
  intensity: number | null;
  /** ASPRS classification code, or null when the cloud carries none. */
  classification: number | null;
  /** RGB triple, each 0–255, or null when the cloud carries no colour. */
  rgb: [number, number, number] | null;
  /**
   * LAS return number — which return of the originating pulse this point is.
   * Undefined for clouds with no return data (any non-LAS format).
   */
  returnNumber?: number;
  /** LAS number of returns recorded for the originating pulse. */
  returnCount?: number;
  /** LAS point source ID — the flight line / source the point came from. */
  pointSourceId?: number;
  /** LAS GPS time, in the file's GPS-time encoding; undefined when absent. */
  gpsTime?: number;
  /** Surface normal (xyz, rounded), when the cloud carries per-point normals. */
  normal?: [number, number, number];
  /**
   * "Still refining" hint. Present only on streaming COPC
   * picks where the picked node is shallower than the deepest currently-
   * resident node, signalling that this region of the scan still has finer
   * detail loading. Static-cloud picks omit this field entirely.
   */
  streamingRefining?: boolean;
}

/** Inputs for {@link makePointInfo} — local coordinates plus the load origin. */
export interface RawPointInfo {
  layer: string;
  index: number;
  /** Local (recentred) coordinates straight from the render buffer. */
  local: [number, number, number];
  /**
   * The world-space origin subtracted from the cloud on load. Adding it back
   * recovers the real, georeferenced coordinates that survey and topographic
   * work needs — not the internal recentred values.
   */
  origin: [number, number, number];
  distance: number;
  intensity: number | null;
  classification: number | null;
  rgb: [number, number, number] | null;
  /** LAS return number, when the cloud carries return data. */
  returnNumber?: number;
  /** LAS number of returns, when the cloud carries return data. */
  returnCount?: number;
  /** LAS point source ID, when the cloud carries it. */
  pointSourceId?: number;
  /** LAS GPS time, when the point format carries a GPS-time field. */
  gpsTime?: number;
  /** Raw surface normal (xyz), when the cloud carries per-point normals. */
  normal?: [number, number, number];
  /** Streaming-refinement-pending flag — see {@link PointInfo.streamingRefining}. */
  streamingRefining?: boolean;
}

/** Round `n` to `places` decimals. */
function round(n: number, places: number): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}

/**
 * Build a display-ready {@link PointInfo}: the local coordinates are shifted
 * back by the load-time origin to recover real-world coordinates, then rounded
 * to 3 decimals (millimetres); the camera distance is rounded to 2.
 */
export function makePointInfo(raw: RawPointInfo): PointInfo {
  const info: PointInfo = {
    layer: raw.layer,
    index: raw.index,
    x: round(raw.local[0] + raw.origin[0], 3),
    y: round(raw.local[1] + raw.origin[1], 3),
    z: round(raw.local[2] + raw.origin[2], 3),
    distance: round(raw.distance, 2),
    intensity: raw.intensity,
    classification: raw.classification,
    rgb: raw.rgb,
  };
  // The inspection extras — carried only when the cloud supplies them,
  // so the inspector card can omit a row entirely rather than show a blank.
  if (raw.returnNumber !== undefined) info.returnNumber = raw.returnNumber;
  if (raw.returnCount !== undefined) info.returnCount = raw.returnCount;
  if (raw.pointSourceId !== undefined) info.pointSourceId = raw.pointSourceId;
  if (raw.gpsTime !== undefined) info.gpsTime = round(raw.gpsTime, 3);
  if (raw.normal) {
    info.normal = [
      round(raw.normal[0], 4),
      round(raw.normal[1], 4),
      round(raw.normal[2], 4),
    ];
  }
  if (raw.streamingRefining) info.streamingRefining = true;
  return info;
}

/**
 * A point's coordinates split into the two frames the inspector card shows.
 * `world` is the real, georeferenced position; `local` is the renderer's
 * recentred frame, or `null` when no origin shift exists (local == world,
 * so the card shows a single group instead of two identical ones).
 */
export interface SplitPointCoords {
  world: { x: number; y: number; z: number };
  local: { x: number; y: number; z: number } | null;
}

/**
 * Split a picked point into world / local coordinates for display.
 *
 * IMPORTANT frame convention: {@link makePointInfo} already adds the
 * load-time origin back, so `info.x/y/z` ARE world coordinates. The local
 * (recentred render-buffer) position is therefore `info − origin`, never
 * `info + origin` — adding the origin a second time produced doubled
 * eastings/northings in v0.4.3's inspector card and fed garbage into the
 * geographic projection. Kept pure and DOM-free so it is unit-testable.
 */
export function splitPointCoords(
  info: Pick<PointInfo, 'x' | 'y' | 'z'>,
  origin: readonly [number, number, number] | undefined,
): SplitPointCoords {
  const world = { x: info.x, y: info.y, z: info.z };
  if (!origin) return { world, local: null };
  return {
    world,
    local: {
      x: world.x - origin[0],
      y: world.y - origin[1],
      z: world.z - origin[2],
    },
  };
}

/** The intensity field's display text — the value, or "Not available". */
export function intensityText(info: PointInfo): string {
  return info.intensity === null ? 'Not available' : String(info.intensity);
}

/** The classification field's display text — a name, or "Not available". */
export function classificationText(info: PointInfo): string {
  return info.classification === null
    ? 'Not available'
    : classificationLabel(info.classification);
}

/** The RGB field's display text — "r, g, b", or "Not available". */
export function rgbText(info: PointInfo): string {
  return info.rgb ? `${info.rgb[0]}, ${info.rgb[1]}, ${info.rgb[2]}` : 'Not available';
}

/**
 * The return field's display text — "2 of 3" — or `null` when the cloud
 * carries no return data. The inspector hides the row entirely on `null`
 * rather than showing a "Not available" placeholder.
 */
export function returnText(info: PointInfo): string | null {
  if (info.returnNumber === undefined || info.returnCount === undefined) return null;
  return `${info.returnNumber} of ${info.returnCount}`;
}

/** The point-source-ID display text, or `null` when the cloud carries none. */
export function pointSourceIdText(info: PointInfo): string | null {
  return info.pointSourceId === undefined ? null : String(info.pointSourceId);
}

/** The GPS-time display text, or `null` when the point format carries none. */
export function gpsTimeText(info: PointInfo): string | null {
  return info.gpsTime === undefined ? null : String(info.gpsTime);
}

/** The normal-vector display text — "x, y, z" — or `null` when absent. */
export function normalText(info: PointInfo): string | null {
  return info.normal ? `${info.normal[0]}, ${info.normal[1]}, ${info.normal[2]}` : null;
}

/**
 * The class-scope stamp a copied / exported point carries while a class
 * filter is active — e.g. `"Ground + Building · 2 of 5 classes"`. An empty
 * string means the view is full (or unscoped), in which case every copy /
 * JSON path stays byte-identical to the pre-feature output. Callers obtain
 * the stamp from `scopeStamp(scope, nameOf)` in `class/classScope.ts`; this
 * module takes the finished string so it stays free of the scope types and
 * remains trivially unit-testable.
 */
export type ClassScopeStamp = string;

/**
 * Normalise an optional scope stamp: trims whitespace and collapses a
 * blank / full-view stamp to `null` so the copy / JSON builders can decide
 * "include a scope line" with a single truthiness check. Keeping this in one
 * place guarantees the copy text and the JSON payload agree on what counts
 * as "no active filter".
 */
function normalizeScopeStamp(stamp: ClassScopeStamp | undefined): string | null {
  if (stamp === undefined) return null;
  const trimmed = stamp.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Clean plain-text form of a picked point, for the clipboard. When a class
 * filter is active the caller passes the scope stamp, which is appended as a
 * trailing `Class scope: …` line so a pasted point is self-describing about
 * the filter it was copied under. With no stamp (full / unfiltered view) the
 * output is byte-identical to the pre-feature block.
 */
export function pointInfoCopyText(
  info: PointInfo,
  scopeStamp?: ClassScopeStamp,
): string {
  const lines = [
    'OpenLiDARViewer Point Info',
    `Layer: ${info.layer}`,
    `Index: ${info.index}`,
    `X: ${info.x}`,
    `Y: ${info.y}`,
    `Z: ${info.z}`,
    `Intensity: ${intensityText(info)}`,
    `Classification: ${classificationText(info)}`,
    `RGB: ${rgbText(info)}`,
  ];
  // The extras are listed only when the cloud actually carries them.
  const ret = returnText(info);
  if (ret) lines.push(`Return: ${ret}`);
  const source = pointSourceIdText(info);
  if (source) lines.push(`Point source: ${source}`);
  const gps = gpsTimeText(info);
  if (gps) lines.push(`GPS time: ${gps}`);
  const normal = normalText(info);
  if (normal) lines.push(`Normal: ${normal}`);
  // Class-scope stamp — last line, present only while a filter is active so
  // the no-filter clipboard payload is unchanged.
  const scope = normalizeScopeStamp(scopeStamp);
  if (scope) lines.push(`Class scope: ${scope}`);
  return lines.join('\n');
}

/** JSON-friendly object form of a picked point. */
export interface PointInfoJson {
  layer: string;
  index: number;
  x: number;
  y: number;
  z: number;
  intensity: number | null;
  classification: string | null;
  rgb: [number, number, number] | null;
  /** LAS extras — present only when the cloud carries them. */
  returnNumber?: number;
  returnCount?: number;
  pointSourceId?: number;
  gpsTime?: number;
  normal?: [number, number, number];
  /**
   * Active class-filter scope stamp — e.g.
   * `"Ground + Building · 2 of 5 classes"`. Present ONLY while a class filter
   * is active, so an unfiltered point's JSON keeps exactly its prior shape
   * (and key set). Lets a downstream consumer of the copied JSON know the
   * point was inspected under a class filter.
   */
  classScope?: string;
}

/**
 * Build the JSON-friendly object form — classification as its name. When a
 * class filter is active the caller passes the scope stamp, which is added as
 * a `classScope` field. With no stamp (full / unfiltered view) the returned
 * object's key set and values are byte-identical to the pre-feature shape.
 */
export function pointInfoJson(
  info: PointInfo,
  scopeStamp?: ClassScopeStamp,
): PointInfoJson {
  const json: PointInfoJson = {
    layer: info.layer,
    index: info.index,
    x: info.x,
    y: info.y,
    z: info.z,
    intensity: info.intensity,
    classification:
      info.classification === null ? null : classificationLabel(info.classification),
    rgb: info.rgb,
  };
  // Optional LAS extras are added only when present, so a non-LAS cloud's
  // JSON stays exactly the shape.
  if (info.returnNumber !== undefined) json.returnNumber = info.returnNumber;
  if (info.returnCount !== undefined) json.returnCount = info.returnCount;
  if (info.pointSourceId !== undefined) json.pointSourceId = info.pointSourceId;
  if (info.gpsTime !== undefined) json.gpsTime = info.gpsTime;
  if (info.normal) json.normal = info.normal;
  // Class-scope stamp — added only while a filter is active.
  const scope = normalizeScopeStamp(scopeStamp);
  if (scope) json.classScope = scope;
  return json;
}
