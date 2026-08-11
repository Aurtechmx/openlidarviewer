/**
 * ReportMeasurementSection.ts
 *
 * Builds the measurement row list the measurements section renders. Maps
 * a runtime `Measurement` (kind + vertex polyline) into a
 * `ReportMeasurementRow` with the numeric value pre-formatted and the
 * appropriate unit attached.
 *
 * Math is kept INLINE here (not borrowed from `render/measure/geometry`)
 * so the report module stays pure-data and the measurement-tool refactor
 * surface area doesn't bleed into the report engine. The numbers track
 * the live overlay's "headline" formula — the report exists to document
 * the inspection, not to second-guess the measurement tool.
 *
 * Pure — no DOM, no three.js. The runtime types are imported as types
 * only so this module stays tree-shakeable.
 */

import type { Measurement, UnitSystem, Vec3 } from '../render/measure/types';
import type { ReportMeasurementRow, ReportProfileDeliverableExtras } from './types';
import {
  stationsAlongLine,
  slopeGradesPerSegment,
  summariseSlopes,
} from '../render/measure/profileStations';
// Area formatting is single-sourced from the live measurement formatter so a
// polygon reads the same units in the PDF report as on the overlay — the same
// surface that produced it. Length and volume keep this module's own
// cm/ha-free report conventions; only area was drifting (acre vs sq ft).
import { formatArea, displayDecimals } from '../render/measure/format';
// The headline VALUES come from the one shared metrics function every other
// surface (live panel, CSV, GeoJSON, KML, integrity) uses, so the PDF can never
// diverge again — it was its own second engine that assumed X/Y horizontal +
// Z vertical and took only a horizontal factor, so a Y-up scan or a compound
// CRS printed wrong (pass-6 M6). measurementMetrics returns metres already, in
// the scene's real up-axis and per-axis units; this module only formats them.
import { measurementMetrics } from '../export/measurementExport';

// ─────────────────────────────────────────────────────────────────────────────
// Inline math
// ─────────────────────────────────────────────────────────────────────────────

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// `dist` above is the only inline geometry that remains — the profile-station
// detail block below still measures a straight 3D chord. Every measurement
// HEADLINE now goes through the shared measurementMetrics (M6), so the polygon /
// slope / angle engines this module used to carry were deleted.

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatLinear(metres: number, system: UnitSystem): string {
  // A non-finite length is not a length. Without this the cm branch below
  // printed "NaN cm" and the km branch "Infinity km" into the PDF, while
  // `formatVolume` two functions down already returned an em dash for the same
  // input.
  if (!Number.isFinite(metres)) return '—';
  // Adaptive precision through the shared measure policy, so a report length
  // carries the same significant figures the panel and CSV do — a sub-centimetre
  // separation no longer rounds to `0.00`.
  if (system === 'imperial') {
    const ft = metres * 3.28084;
    if (ft >= 5280) {
      const mi = ft / 5280;
      return `${mi.toFixed(displayDecimals(mi, 3, 4))} mi`;
    }
    return `${ft.toFixed(displayDecimals(ft, 2, 4))} ft`;
  }
  if (metres >= 1000) {
    const km = metres / 1000;
    return `${km.toFixed(displayDecimals(km, 3, 4))} km`;
  }
  if (metres >= 1) return `${metres.toFixed(displayDecimals(metres, 2, 4))} m`;
  const cm = metres * 100;
  return `${cm.toFixed(displayDecimals(cm, 1, 4))} cm`;
}

/**
 * Format a volume in cubic metres against the active unit system.
 * v0.3.10 deliverable-completion patch — the prior switch fell
 * through for `box` and `volume` kinds, leaving PDF reports with
 * "—" where the headline number should have lived. See
 * `computeValue` below for the call sites.
 */
function formatVolume(cubicMetres: number, system: UnitSystem): string {
  if (!Number.isFinite(cubicMetres)) return '—';
  if (system === 'imperial') {
    const cuYd = cubicMetres * 1.30795;
    return `${cuYd.toFixed(displayDecimals(cuYd, 2, 4))} yd³`;
  }
  return `${cubicMetres.toFixed(displayDecimals(cubicMetres, 2, 4))} m³`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute one measurement's headline value, formatted with the right unit.
 *
 * `f` is the render-units → metres factor (the scan CRS's
 * `linearUnitToMetres`, the SAME seam the live MeasureController applies at
 * its display boundary). Measurement points are stored in RENDER units, so a
 * foot-based scan must be scaled exactly once before formatting — lengths ×f,
 * areas ×f², volumes ×f³. Angles and slope grades are ratios and need no
 * scaling. Default 1 (metre / local scans are unaffected).
 */
function computeValue(
  m: Measurement,
  system: UnitSystem,
  up: Vec3,
  unitToMetres: number,
  verticalToMetres: number,
): string {
  // One shared, up-axis- and compound-CRS-correct computation for every kind;
  // this function only formats the metre values it returns (M6).
  // Pass full precision (6 dp) — the formatters below apply the report's own
  // adaptive sub-centimetre rounding, so the PDF matches the live panel to the
  // digit rather than inheriting the tabular exports' millimetre columns (M6).
  const mm = measurementMetrics(m, up, unitToMetres, verticalToMetres, 6);
  switch (m.kind) {
    case 'distance':
    case 'polyline':
    case 'profile':
      return mm.length_m != null ? formatLinear(mm.length_m, system) : '—';
    case 'area':
      return mm.area_m2 != null ? formatArea(mm.area_m2, system) : '—';
    case 'height':
      return mm.vertical_m != null ? formatLinear(Math.abs(mm.vertical_m), system) : '—';
    case 'angle':
      return mm.angle_deg != null ? `${mm.angle_deg.toFixed(1)}°` : '—';
    case 'slope':
      // Three outcomes: a finite grade, a genuinely vertical pair (grade omitted
      // but the geometry ran, so `rise_m` is present), or a degenerate/incomplete
      // measurement (nothing computed) which must read "—", not "vertical".
      if (mm.grade_pct != null) return `${mm.grade_pct.toFixed(2)}%`;
      return mm.rise_m != null ? 'vertical' : '—';
    case 'box':
      return mm.volume_m3 != null ? formatVolume(mm.volume_m3, system) : '—';
    case 'volume': {
      // Mirror the live headline exactly (see MeasureController._headlineText)
      // so the PDF and the panel agree to the digit.
      if (mm.area_m2 == null) return '—';
      const area = formatArea(mm.area_m2, system);
      if (mm.cut_m3 == null) return `${area} footprint · cut/fill —`;
      const fill = formatVolume(Math.max(0, mm.fill_m3 ?? 0), system);
      const cut = formatVolume(Math.max(0, mm.cut_m3 ?? 0), system);
      const net = formatVolume(Math.abs(mm.net_m3 ?? 0), system);
      const netSign = (mm.net_m3 ?? 0) < 0 ? 'cut' : 'fill';
      return `${area} · +${fill} fill · −${cut} cut · net ${net} ${netSign}`;
    }
  }
  return '—';
}

/**
 * v0.3.10 Profile-as-Deliverable — compute the deliverable extras for
 * a profile measurement. Returns `undefined` when the measurement
 * lacks the data to compute stations + slopes (e.g., a profile loaded
 * from a pre-chart session file, or a degenerate horizontal section).
 * The PDF renderer falls back to the headline-only row in that case.
 */
function buildProfileExtras(
  m: Measurement,
  system: UnitSystem,
  f: number,
): ReportProfileDeliverableExtras | undefined {
  if (m.kind !== 'profile' || m.points.length < 2) return undefined;
  const a = m.points[0];
  const b = m.points[1];
  // Horizontal length determines the station interval. Mirror the
  // chart's `autoStationInterval` logic — civil convention prefers
  // multiples of 1/2/5/10/20/25/50/100/200/500 metres. The ladder is in
  // METRES, so pick the interval against the metre-converted length and
  // convert it back into render units for the geometric station walk — the
  // chainages then scale ×f once at the formatting boundary like every
  // other length here.
  const horizontalLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!Number.isFinite(horizontalLen) || horizontalLen <= 0) return undefined;
  const interval = autoStationIntervalForReport(horizontalLen * f) / f;
  const stations = stationsAlongLine({ a, b, intervalM: interval });
  if (stations.length === 0) return undefined;
  // Slope grades: use profile samples if the measurement carries them.
  const samples = m.profileChart && m.profileChart.length >= 2 ? m.profileChart : undefined;
  const grades = slopeGradesPerSegment({ stations, samples });
  const summary = summariseSlopes(grades);

  const length3d = dist(a, b);
  const dz = Math.abs(b[2] - a[2]);
  // Grade is a ratio of two same-unit lengths — unit-factor invariant.
  const gradePercent = horizontalLen > 0 ? ((b[2] - a[2]) / horizontalLen) * 100 : 0;
  const summaryLine =
    `Horizontal ${formatLinear(horizontalLen * f, system)} · ` +
    `3D ${formatLinear(length3d * f, system)} · ` +
    `Δh ${formatLinear(dz * f, system)} · ` +
    `${gradePercent.toFixed(2)}% grade`;

  const stationsLine = stations
    .map((s) => formatLinear(s.chainage * f, system))
    .join(' · ');

  const signPrefix = (v: number): string => (v >= 0 ? '+' : '');
  let slopeLine: string;
  if (Number.isFinite(summary.maxGradePercent)) {
    slopeLine =
      `Max ${signPrefix(summary.maxGradePercent)}${summary.maxGradePercent.toFixed(2)}%, ` +
      `Min ${signPrefix(summary.minGradePercent)}${summary.minGradePercent.toFixed(2)}%, ` +
      `Avg ${signPrefix(summary.avgGradePercent)}${summary.avgGradePercent.toFixed(2)}%`;
  } else {
    const reason = samples
      ? 'no finite samples along the section.'
      : 'no point-cloud samples attached to this profile.';
    slopeLine = `Slope summary unavailable — ${reason}`;
  }

  // The renderer self-normalises, so pass the finite samples straight through
  // (their absolute units are immaterial to the drawn shape).
  const chart = samples
    ? samples.filter((s) => Number.isFinite(s.distance) && Number.isFinite(s.height))
    : undefined;

  return {
    summary: summaryLine,
    stations: stationsLine,
    stationInterval: `Station interval ${formatLinear(interval * f, system)} (${stations.length} stations)`,
    slopeSummary: slopeLine,
    coverageCaveat: m.profileChartResidentOnly
      ? 'Resident-node analysis only — profile may refine as streaming loads.'
      : undefined,
    chart: chart && chart.length >= 2 ? chart : undefined,
  };
}

/**
 * Pick the largest "nice" station interval that produces no more than
 * ~10 stations across the given chainage. Same ladder as the live
 * `autoStationInterval` in `MeasurePanel.ts` — kept here to avoid a
 * back-dependency on the panel module from the pure-data report
 * pipeline. v0.3.10 Profile-as-Deliverable stream.
 */
function autoStationIntervalForReport(totalChainageM: number): number {
  if (!Number.isFinite(totalChainageM) || totalChainageM <= 0) return 1;
  const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const v of ladder) {
    if (totalChainageM / v <= 10) return v;
  }
  let v = 10_000;
  while (totalChainageM / v > 10) v *= 2;
  return v;
}

/**
 * Build the report-row list from a measurement collection.
 *
 * `unitToMetres` is the scan CRS's render-units → metres factor (the SAME
 * `linearUnitToMetres` seam the live MeasureController applies at its display
 * boundary). Measurement records carry RENDER-unit coordinates, so a
 * foot-based scan must be converted exactly once here — lengths ×f, areas
 * ×f², volumes ×f³ — or the PDF disagrees with every on-screen readout by
 * 3.28× (the v0.4.5 measure-unit fix). Defaults to 1, so metric / local
 * scans and legacy callers are byte-identical. Non-finite / non-positive
 * factors fall back to 1 — an honest no-op, never a fabricated scale.
 */
export function buildMeasurementRows(
  measurements: readonly Measurement[],
  unitSystem: UnitSystem,
  unitToMetres = 1,
  // The scene's real up-axis and vertical unit factor, so the PDF matches the
  // live tool on a Y-up scan and a compound CRS (M6). Default to Z-up /
  // single-unit so existing callers are unchanged.
  worldUp: Vec3 = [0, 0, 1],
  verticalToMetres = unitToMetres,
): readonly ReportMeasurementRow[] {
  const f = Number.isFinite(unitToMetres) && unitToMetres > 0 ? unitToMetres : 1;
  const vf = Number.isFinite(verticalToMetres) && verticalToMetres > 0 ? verticalToMetres : f;
  return measurements.map((m) => ({
    name: m.name,
    kind: m.kind,
    value: computeValue(m, unitSystem, worldUp, f, vf),
    pointCount: m.points.length,
    profileExtras: m.kind === 'profile' ? buildProfileExtras(m, unitSystem, f) : undefined,
  }));
}
