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
import { formatArea } from '../render/measure/format';

// ─────────────────────────────────────────────────────────────────────────────
// Inline math
// ─────────────────────────────────────────────────────────────────────────────

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function polyLen(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/**
 * Planar polygon area via the Newell-normal-projected shoelace. Same
 * formulation `render/measure/geometry.ts` uses; inlined to keep the
 * report module free of a back-dependency on the measure tool.
 */
function polyArea(points: readonly Vec3[]): number {
  if (points.length < 3) return 0;
  // Newell normal accumulation.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/**
 * Horizontal-projected polygon area via XY shoelace, assuming a world
 * up of `[0, 0, 1]`. Used for the `volume` measurement headline so the
 * report matches the live UI's `polygonAreaHorizontal()` exactly. For
 * a horizontal polygon this equals `polyArea()`; for a tilted polygon
 * it diverges, and the live UI deliberately reports the horizontal
 * footprint area (volume against a horizontal datum). v0.3.10
 * deliverable-completion deep-review #1.
 */
function polyAreaHorizontal(points: readonly Vec3[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twiceArea) * 0.5;
}

function slopePercent(a: Vec3, b: Vec3): number {
  const dz = b[2] - a[2];
  const dxy = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  if (dxy === 0) return 0;
  return (dz / dxy) * 100;
}

function angleAtVertex(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2];
  const vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2];
  const dot = ux * vx + uy * vy + uz * vz;
  const lu = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const lv = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatLinear(metres: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const ft = metres * 3.28084;
    if (ft >= 5280) return `${(ft / 5280).toFixed(2)} mi`;
    return `${ft.toFixed(2)} ft`;
  }
  if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
  if (metres >= 1) return `${metres.toFixed(2)} m`;
  return `${(metres * 100).toFixed(1)} cm`;
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
    return `${cuYd.toFixed(2)} yd³`;
  }
  return `${cubicMetres.toFixed(2)} m³`;
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
function computeValue(m: Measurement, system: UnitSystem, f: number): string {
  switch (m.kind) {
    case 'distance':
      return m.points.length >= 2
        ? formatLinear(dist(m.points[0], m.points[1]) * f, system)
        : '—';
    case 'polyline':
      return formatLinear(polyLen(m.points) * f, system);
    case 'area':
      return formatArea(polyArea(m.points) * f * f, system);
    case 'height':
      return m.points.length >= 2
        ? formatLinear(Math.abs(m.points[1][2] - m.points[0][2]) * f, system)
        : '—';
    case 'angle':
      return m.points.length >= 3
        ? `${angleAtVertex(m.points[0], m.points[1], m.points[2]).toFixed(1)}°`
        : '—';
    case 'slope':
      return m.points.length >= 2
        ? `${slopePercent(m.points[0], m.points[1]).toFixed(2)}%`
        : '—';
    case 'profile': {
      // Profile reports the 3D length as its headline value; the rest of
      // the metrics (Δh, grade) live in the live overlay and will be
      // expanded into a per-measurement card when the report engine grows
      // measurement-detail blocks.
      if (m.points.length < 2) return '—';
      const length3d = dist(m.points[0], m.points[1]);
      return formatLinear(length3d * f, system);
    }
    case 'box': {
      // v0.3.10 deliverable-completion patch — the report engine used to
      // fall through for `box`, leaving the PDF showing "—" for what is
      // actually one of the cleanest measurements to render. Box dims
      // are pure 2-corner picks, so the volume is exact regardless of
      // streaming state; we just compute and format. The two picked
      // points are opposite diagonals; normalise per-axis so any pick
      // order yields the same headline.
      if (m.points.length < 2) return '—';
      const a = m.points[0];
      const b = m.points[1];
      const w = Math.abs(b[0] - a[0]);
      const d = Math.abs(b[1] - a[1]);
      const h = Math.abs(b[2] - a[2]);
      const cubicMetres = w * d * h * f * f * f;
      return formatVolume(cubicMetres, system);
    }
    case 'volume': {
      // v0.3.10 deliverable-completion patch (deep-review #1) — the
      // earlier fall-through silently dropped volume from the report.
      // The first-pass fix surfaced ONLY net, which disagreed with the
      // live UI: MeasurePanel shows
      //   "<area> · +<fill> fill · −<cut> cut · net <net> <netSign>"
      // — a user saving a session, exporting a PDF, and handing it to
      // a client would see less data than they had on screen. That is
      // the same deliverable-disagreement shape the Share-button leak
      // had: the artefact contradicts the live tool. Mirror the live
      // headline exactly here (see MeasureController._headlineText)
      // so the PDF and the panel agree to the digit.
      if (m.points.length < 3) return '—';
      const area = formatArea(polyAreaHorizontal(m.points) * f * f, system);
      const v = m.volume;
      if (!v) return `${area} footprint · cut/fill —`;
      const f3 = f * f * f;
      const fill = formatVolume(Math.max(0, v.fill) * f3, system);
      const cut = formatVolume(Math.max(0, v.cut) * f3, system);
      const net = formatVolume(Math.abs(v.net) * f3, system);
      const netSign = v.net < 0 ? 'cut' : 'fill';
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

  const slopeLine = Number.isFinite(summary.maxGradePercent)
    ? `Max ${summary.maxGradePercent >= 0 ? '+' : ''}${summary.maxGradePercent.toFixed(2)}%, ` +
      `Min ${summary.minGradePercent >= 0 ? '+' : ''}${summary.minGradePercent.toFixed(2)}%, ` +
      `Avg ${summary.avgGradePercent >= 0 ? '+' : ''}${summary.avgGradePercent.toFixed(2)}%`
    : `Slope summary unavailable — ${
        samples
          ? 'no finite samples along the section.'
          : 'no point-cloud samples attached to this profile.'
      }`;

  return {
    summary: summaryLine,
    stations: stationsLine,
    stationInterval: `Station interval ${formatLinear(interval * f, system)} (${stations.length} stations)`,
    slopeSummary: slopeLine,
    coverageCaveat: m.profileChartResidentOnly
      ? 'Resident-node analysis only — profile may refine as streaming loads.'
      : undefined,
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
): readonly ReportMeasurementRow[] {
  const f = Number.isFinite(unitToMetres) && unitToMetres > 0 ? unitToMetres : 1;
  return measurements.map((m) => ({
    name: m.name,
    kind: m.kind,
    value: computeValue(m, unitSystem, f),
    pointCount: m.points.length,
    profileExtras: m.kind === 'profile' ? buildProfileExtras(m, unitSystem, f) : undefined,
  }));
}
