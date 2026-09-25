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
import { evidenceNote, evidenceStatus, unverifiedUnitsCaveat } from '../validation/exportEvidenceNote';
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
  /**
   * True when the scan's linear scale is KNOWN (a resolved CRS unit), so the
   * `_m` / `_m2` / `_m3` columns genuinely mean metres. False for a local /
   * unknown-unit scan, where the factor is an inert 1 and the export must not
   * claim metres — the evidence note then carries an explicit units caveat
   * (pass-6 M1). Defaults to true so every georeferenced caller is unchanged.
   */
  readonly unitsVerified?: boolean;
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
        // A withheld grid figure carries none of the three — `set` already
        // omits a non-finite value, so `undefined * Vol` (NaN) drops the column
        // rather than exporting a fabricated zero.
        if (m.volume.cut !== undefined) set('cut_m3', m.volume.cut * Vol);
        if (m.volume.fill !== undefined) set('fill_m3', m.volume.fill * Vol);
        if (m.volume.net !== undefined) set('net_m3', m.volume.net * Vol);
        // The point-sample cross-check a switched lasso record keeps beside the
        // grid figure — named so a reader never confuses it with
        // the canonical cut_m3/fill_m3/net_m3 above.
        if (m.volume.crossCheck) {
          set('pointsample_cut_m3', m.volume.crossCheck.cut * Vol);
          set('pointsample_fill_m3', m.volume.crossCheck.fill * Vol);
          set('pointsample_net_m3', m.volume.crossCheck.net * Vol);
        }
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
  // Same rule as the CSV: with no resolved scale the property names say source
  // units rather than asserting metres to a parser.
  const unitsKnown = ctx.unitsVerified ?? true;
  const features = measurements
    .map((m) => {
      const geometry = geometryFor(m, ctx);
      if (!geometry) return null;
      const properties: Record<string, unknown> = {
        id: m.id,
        name: m.name,
        kind: m.kind,
        ...(unitsKnown
          ? measurementMetrics(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres)
          : inSourceUnits(measurementMetrics(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres))),
      };
      if (ctx.crsName) properties.crs = ctx.crsName;
      // Same coverage verdict the CSV's grid_authority column carries — see
      // measurementsToCsv.
      if (m.kind === 'volume' && m.volume?.gridAuthority) properties.grid_authority = m.volume.gridAuthority;
      const w = m.kind === 'volume' ? m.volume?.withheld : undefined;
      if (w) Object.assign(properties, { source_points: w.source, withheld_excluded: w.excluded, analysed_points: w.analysed });
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
  // Each kind present gets its own verdict; a mixed file carries them all
  // rather than one kind's answer standing in for the rest.
  const claims = claimsPresent(measurements);
  const evidence =
    claims.map((c) => `${c}: ${evidenceNote(c)}`).join(' ')
    + unverifiedUnitsCaveat(ctx.unitsVerified ?? true);
  // A collection with nothing in it makes no claim, so there is no verdict to
  // carry — and an `evidence: ""` member would be a field that says nothing
  // where a reader expects a statement. The key is omitted instead.
  if (evidence) fc.evidence = evidence;
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
  box: 'VOL-POINT-SAMPLE',
  volume: 'VOL-POINT-SAMPLE',
};

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

/** Rewrite every unit-bearing key of a metrics record. Unitless keys pass through. */
function inSourceUnits<T>(metrics: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(metrics).map(([k, v]) => [sourceUnitKey(k), v]));
}

const CSV_COLUMNS = [
  'id', 'name', 'kind', 'vertices',
  'length_m', 'horizontal_m', 'vertical_m', 'rise_m', 'run_m',
  'grade_pct', 'angle_deg', 'area_m2', 'horizontal_area_m2', 'perimeter_m',
  'width_m', 'depth_m', 'height_m', 'volume_m3', 'cut_m3', 'fill_m3', 'net_m3',
  // A grid-owned lasso volume's coverage verdict, and the point-sample
  // cross-check kept beside its canonical cut_m3/fill_m3/net_m3 above — blank
  // on every other kind, and on a volume record from before the switch or
  // from the hand-drawn polygon tool, which has no grid counterpart.
  'grid_authority', 'pointsample_cut_m3', 'pointsample_fill_m3', 'pointsample_net_m3',
  // A lasso result's input counts; `withheld_excluded` reads `unknown` when
  // the source carried no flags, never 0.
  'source_points', 'withheld_excluded', 'analysed_points',
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
  // With no resolved scale the values are source-unit numbers, so the header
  // names them that way rather than asserting metres a parser would believe.
  const unitsKnown = ctx.unitsVerified ?? true;
  const columns = unitsKnown ? CSV_COLUMNS : CSV_COLUMNS.map(sourceUnitKey);
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
  const evidenceFor = (m: Measurement): string => {
    const status = evidenceStatus(claimForMeasurement(m) ?? 'MEAS-DISTANCE');
    return unitsKnown ? status : `${status}; units-unverified (source render units, not metres)`;
  };
  for (const m of measurements) {
    const raw = measurementMetrics(m, ctx.up, ctx.unitToMetres, ctx.verticalUnitToMetres);
    const metrics = unitsKnown ? raw : inSourceUnits(raw);
    const base: Record<string, string | number> = {
      id: m.id,
      name: m.name,
      kind: m.kind,
      vertices: m.points.length,
      ...metrics,
      evidence: evidenceFor(m),
    };
    if (m.kind === 'volume' && m.volume?.gridAuthority) base.grid_authority = m.volume.gridAuthority;
    const w = m.kind === 'volume' ? m.volume?.withheld : undefined;
    if (w) Object.assign(base, { source_points: w.source, withheld_excluded: w.excluded, analysed_points: w.analysed });
    rows.push(columns.map((c) => (c in base ? csvCell(base[c]) : '')).join(','));
  }
  return rows.join('\n');
}
