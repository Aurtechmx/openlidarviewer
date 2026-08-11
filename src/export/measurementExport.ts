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
import { crsUrn } from './crsIdentifier';
import {
  distance,
  polylineLength,
  profileMetrics,
  polygonAreaHorizontal,
  polygonAreaPlanar,
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
  /**
   * VERTICAL render-units → metres (up-axis height unit). Defaults to
   * `unitToMetres`; differs only for a compound CRS (metre eastings over foot
   * heights). Vertical quantities (height, rise, drop) and volumes scale by
   * this so the export matches the on-screen headline, which already does.
   */
  readonly verticalUnitToMetres?: number;
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
 * Express a source-frame point in an isotropic METRE frame: scale the component
 * along the (unit) up-axis by the vertical factor and the perpendicular
 * (horizontal) part by the horizontal factor. Computing 3D geometry on these
 * points is then physically correct even for a COMPOUND CRS (metre eastings over
 * foot heights) — where scaling a 3D distance or a slope grade by one factor
 * mixed the two axes and produced a self-contradictory export: grade 100 % beside
 * rise 0.3048 m / run 1 m (pass-6 M2). For a single-unit CRS both factors are
 * equal, so this is a uniform scale and every metric is byte-identical to before.
 */
function toMetricFrame(p: Vec3, up: Vec3, h: number, v: number): Vec3 {
  const along = p[0] * up[0] + p[1] * up[1] + p[2] * up[2]; // dot(p, up)
  return [
    (p[0] - along * up[0]) * h + along * up[0] * v,
    (p[1] - along * up[1]) * h + along * up[1] * v,
    (p[2] - along * up[2]) * h + along * up[2] * v,
  ];
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
      set('area_m2', polygonAreaPlanar(mp));
      set('horizontal_area_m2', polygonAreaHorizontal(mp, up));
      set('perimeter_m', polygonPerimeter(mp));
      break;
    case 'box': {
      const mb = boxMetrics(boxFromCorners(mp[0], mp[1]), up);
      set('width_m', mb.width);
      set('depth_m', mb.depth);
      set('height_m', mb.height);
      set('volume_m3', mb.volume);
      break;
    }
    case 'volume':
      // A volume's base is a horizontal footprint (the map area under it).
      set('area_m2', polygonAreaHorizontal(mp, up));
      if (m.volume) {
        // cut/fill/net are stored volumes in native units, not point-derived.
        set('cut_m3', m.volume.cut * Vol);
        set('fill_m3', m.volume.fill * Vol);
        set('net_m3', m.volume.net * Vol);
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
      const corners = boxCorners(boxFromCorners(m.points[0], m.points[1]), ctx.up);
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
        ...measurementMetrics(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres),
      };
      if (ctx.crsName) properties.crs = ctx.crsName;
      return { type: 'Feature' as const, geometry, properties };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const fc: Record<string, unknown> = { type: 'FeatureCollection', features };
  // Pre-RFC-7946 named-CRS member — non-standard but QGIS and others read it, so
  // a PROJECTED export lands in the right place. Geographic output is the RFC
  // default (WGS84) and carries no crs member.
  //
  // The name must be an IDENTIFIER, not the display label `crsName` carries
  // (`NAD83 / UTM zone 13N (EPSG:26913)`): a reader that can't resolve it falls
  // back to WGS84 and reads easting 500000 as longitude 500000. When no code can
  // be recovered the member is omitted — an absent CRS makes a reader ask, a
  // wrong one makes it place the geometry in the ocean.
  const urn = ctx.geographic ? null : crsUrn(ctx.crsName);
  if (urn) {
    fc.crs = { type: 'name', properties: { name: urn } };
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
  'grade_pct', 'angle_deg', 'area_m2', 'horizontal_area_m2', 'perimeter_m',
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
  return neutralise || /[",\n]/.test(cell) ? `"${cell.replaceAll(/"/g, '""')}"` : cell;
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
    const metrics = measurementMetrics(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres);
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
