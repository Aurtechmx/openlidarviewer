/**
 * measurementExport.ts
 *
 * Pure serializers that let placed measurements LEAVE the tool in open formats —
 * GeoJSON (for GIS / QGIS / web maps) and CSV (for spreadsheets). Both are an
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
import { isComplete } from '../render/measure/types';
import { evidenceNote, evidenceStatus } from '../validation/exportEvidenceNote';
import {
  distance,
  polylineLength,
  profileMetrics,
  polygonAreaHorizontal,
  polygonPerimeter,
  angleAtVertex,
  slopeBetween,
  verticalDelta,
  boxFromCorners,
  boxCorners,
  boxMetrics,
} from '../render/measure/geometry';

export interface MeasurementExportContext {
  /** Map a LOCAL render-space point into the output frame (lon/lat/alt or x/y/z). */
  readonly toOutput: (p: Vec3) => [number, number, number];
  /** World up vector, for the height / grade / slope derivations. */
  readonly up: Vec3;
  /** Render-units → metres (1 for metric scans; e.g. 0.3048 for US-foot scans). */
  readonly unitToMetres: number;
  /** CRS label for the GeoJSON crs hint + per-feature provenance. */
  readonly crsName?: string;
  /** True when `toOutput` yields geographic WGS84 lon/lat (RFC 7946 default frame). */
  readonly geographic?: boolean;
}

/** A finite number rounded to `d` decimals, or null when not finite. */
function num(v: number, d = 3): number | null {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
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
): Record<string, number> {
  const out: Record<string, number> = {};
  const set = (k: string, v: number | null): void => {
    if (v !== null) out[k] = v;
  };
  const pts = m.points;
  const L = unitToMetres;
  const A = unitToMetres * unitToMetres;
  if (!isComplete(m)) return out;

  switch (m.kind) {
    case 'distance':
      set('length_m', num(distance(pts[0], pts[1]) * L));
      break;
    case 'polyline':
      set('length_m', num(polylineLength(pts).total * L));
      break;
    case 'height': {
      const v = verticalDelta(pts[0], pts[1], up);
      set('vertical_m', num(v.vertical * L));
      set('horizontal_m', num(v.horizontal * L));
      break;
    }
    case 'angle':
      set('angle_deg', num(angleAtVertex(pts[0], pts[1], pts[2])));
      break;
    case 'slope': {
      const s = slopeBetween(pts[0], pts[1], up);
      set('grade_pct', num(s.gradePercent));
      set('angle_deg', num(s.angleDeg));
      set('rise_m', num(s.rise * L));
      set('run_m', num(s.run * L));
      break;
    }
    case 'profile': {
      const p = profileMetrics(pts[0], pts[1], up);
      set('length_m', num(p.length3d * L));
      set('horizontal_m', num(p.lengthHorizontal * L));
      set('vertical_m', num(p.verticalDrop * L));
      set('grade_pct', num(p.gradePercent));
      break;
    }
    case 'area':
      set('area_m2', num(polygonAreaHorizontal(pts, up) * A));
      set('perimeter_m', num(polygonPerimeter(pts) * L));
      break;
    case 'box': {
      const mb = boxMetrics(boxFromCorners(pts[0], pts[1]));
      set('width_m', num(mb.width * L));
      set('depth_m', num(mb.depth * L));
      set('height_m', num(mb.height * L));
      set('volume_m3', num(mb.volume * L * A));
      break;
    }
    case 'volume':
      set('area_m2', num(polygonAreaHorizontal(pts, up) * A));
      if (m.volume) {
        // cut/fill/net are stored in the cloud's native (render) linear units,
        // exactly like every other measurement and like `formatVolumeRender` /
        // the chain aggregator expect — so convert to cubic metres here, ×L·A
        // (= unitToMetres³), the same factor the box-volume branch applies. For
        // metric data L=A=1 so this is a no-op; for a foot-CRS it is the fix.
        const V = L * A;
        set('cut_m3', num(m.volume.cut * V));
        set('fill_m3', num(m.volume.fill * V));
        set('net_m3', num(m.volume.net * V));
      }
      break;
  }
  return out;
}

/** GeoJSON geometry type for a kind. */
function geometryFor(
  m: Measurement,
  ctx: MeasurementExportContext,
): { type: 'LineString' | 'Polygon' | 'Point'; coordinates: unknown } | null {
  const t = (p: Vec3): [number, number, number] => ctx.toOutput(p);
  switch (m.kind) {
    case 'distance':
    case 'polyline':
    case 'height':
    case 'angle':
    case 'slope':
    case 'profile':
      return m.points.length >= 2
        ? { type: 'LineString', coordinates: m.points.map(t) }
        : null;
    case 'area':
    case 'volume': {
      if (m.points.length < 3) return null;
      const ring = m.points.map(t);
      ring.push(ring[0]); // close the ring (RFC 7946)
      return { type: 'Polygon', coordinates: [ring] };
    }
    case 'box': {
      if (m.points.length < 2) return null;
      // Footprint = the four bottom corners (indices 0..3 of boxCorners).
      const corners = boxCorners(boxFromCorners(m.points[0], m.points[1]));
      const ring = [corners[0], corners[1], corners[2], corners[3]].map(t);
      ring.push(ring[0]);
      return { type: 'Polygon', coordinates: [ring] };
    }
  }
}

/** Serialise measurements to a GeoJSON FeatureCollection (pretty-printed). */
export function measurementsToGeoJSON(
  measurements: readonly Measurement[],
  ctx: MeasurementExportContext,
): string {
  const features = measurements
    .map((m) => {
      const geometry = geometryFor(m, ctx);
      if (!geometry) return null;
      const properties: Record<string, unknown> = {
        id: m.id,
        name: m.name,
        kind: m.kind,
        ...measurementMetrics(m, ctx.up, ctx.unitToMetres),
      };
      if (ctx.crsName) properties.crs = ctx.crsName;
      return { type: 'Feature' as const, geometry, properties };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const fc: Record<string, unknown> = { type: 'FeatureCollection', features };
  // Pre-RFC-7946 named-CRS member — non-standard but QGIS and others read it, so
  // a PROJECTED export lands in the right place. Geographic output is the RFC
  // default (WGS84) and carries no crs member.
  if (!ctx.geographic && ctx.crsName) {
    fc.crs = { type: 'name', properties: { name: ctx.crsName } };
  }
  // Route the export through the ONE evidence gate (PR6): measurements sit below
  // their required evidence level, so the file carries the exploratory verdict
  // rather than leaving with no gate stamp at all. RFC 7946 permits foreign
  // members on a FeatureCollection, so a reader that ignores it is unaffected.
  fc.evidence = evidenceNote('MEAS-DISTANCE');
  return JSON.stringify(fc, null, 2);
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
const CSV_COLUMNS = [
  'id', 'name', 'kind', 'vertices',
  'length_m', 'horizontal_m', 'vertical_m', 'rise_m', 'run_m',
  'grade_pct', 'angle_deg', 'area_m2', 'perimeter_m',
  'width_m', 'depth_m', 'height_m', 'volume_m3', 'cut_m3', 'fill_m3', 'net_m3',
  'evidence',
] as const;

/**
 * Escape a CSV cell per RFC 4180 (quote when it contains , " or newline), and
 * neutralise spreadsheet formula injection. A string cell that begins with
 * `= + - @` or a tab/CR is interpreted as a formula by Excel/Sheets; a
 * measurement name like `=HYPERLINK(...)` round-tripped through a shared
 * `.olvsession` is attacker-controlled, so we prefix a literal `'` (the
 * conventional neutraliser) and force-quote to keep it. Numeric cells are never
 * neutralised, so a negative value like `-1.5` stays a plain number.
 */
function csvCell(v: string | number): string {
  const s = String(v);
  const neutralise = typeof v === 'string' && /^[=+\-@\t\r]/.test(s);
  const cell = neutralise ? `'${s}` : s;
  return neutralise || /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Serialise measurements to a CSV — one row per measurement, metres throughout. */
export function measurementsToCsv(
  measurements: readonly Measurement[],
  ctx: MeasurementExportContext,
): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];
  // Route the CSV through the SAME one gate the GeoJSON path uses (PR §19):
  // measurements sit below their required evidence level, so every row carries
  // the exploratory verdict rather than leaving with no gate stamp at all.
  const evidence = evidenceStatus('MEAS-DISTANCE');
  for (const m of measurements) {
    const metrics = measurementMetrics(m, ctx.up, ctx.unitToMetres);
    const base: Record<string, string | number> = {
      id: m.id,
      name: m.name,
      kind: m.kind,
      vertices: m.points.length,
      ...metrics,
      evidence,
    };
    rows.push(CSV_COLUMNS.map((c) => (c in base ? csvCell(base[c]) : '')).join(','));
  }
  return rows.join('\n');
}
