/**
 * pointInfo.ts
 *
 * Pure, DOM-free helpers for the Inspect tool: the picked-point data shape,
 * ASPRS classification names, coordinate rounding, and the clipboard / JSON
 * serialisations. Kept free of three.js and the DOM so it can be unit-tested
 * in Node; `InspectTool` renders it.
 */

/** ASPRS standard point classification names (LAS 1.1–1.4, classes 0–18). */
const ASPRS_CLASSES: Record<number, string> = {
  0: 'Created, never classified',
  1: 'Unclassified',
  2: 'Ground',
  3: 'Low vegetation',
  4: 'Medium vegetation',
  5: 'High vegetation',
  6: 'Building',
  7: 'Low point (noise)',
  9: 'Water',
  10: 'Rail',
  11: 'Road surface',
  13: 'Wire — guard',
  14: 'Wire — conductor',
  15: 'Transmission tower',
  16: 'Wire-structure connector',
  17: 'Bridge deck',
  18: 'High noise',
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
  return {
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

/** Clean plain-text form of a picked point, for the clipboard. */
export function pointInfoCopyText(info: PointInfo): string {
  return [
    'OpenLiDARViewer Point Info',
    `Layer: ${info.layer}`,
    `Index: ${info.index}`,
    `X: ${info.x}`,
    `Y: ${info.y}`,
    `Z: ${info.z}`,
    `Intensity: ${intensityText(info)}`,
    `Classification: ${classificationText(info)}`,
    `RGB: ${rgbText(info)}`,
  ].join('\n');
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
}

/** Build the JSON-friendly object form — classification as its name. */
export function pointInfoJson(info: PointInfo): PointInfoJson {
  return {
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
}
