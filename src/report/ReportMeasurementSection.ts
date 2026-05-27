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
import type { ReportMeasurementRow } from './types';

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

function formatArea(squareMetres: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const sqFt = squareMetres * 10.7639;
    return `${sqFt.toFixed(1)} sq ft`;
  }
  if (squareMetres >= 10_000) return `${(squareMetres / 10_000).toFixed(2)} ha`;
  return `${squareMetres.toFixed(2)} m²`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────

/** Compute one measurement's headline value, formatted with the right unit. */
function computeValue(m: Measurement, system: UnitSystem): string {
  switch (m.kind) {
    case 'distance':
      return m.points.length >= 2 ? formatLinear(dist(m.points[0], m.points[1]), system) : '—';
    case 'polyline':
      return formatLinear(polyLen(m.points), system);
    case 'area':
      return formatArea(polyArea(m.points), system);
    case 'height':
      return m.points.length >= 2
        ? formatLinear(Math.abs(m.points[1][2] - m.points[0][2]), system)
        : '—';
    case 'angle':
      return m.points.length >= 3
        ? `${angleAtVertex(m.points[0], m.points[1], m.points[2]).toFixed(1)}°`
        : '—';
    case 'slope':
      return m.points.length >= 2
        ? `${slopePercent(m.points[0], m.points[1]).toFixed(2)}%`
        : '—';
  }
  return '—';
}

/** Build the report-row list from a measurement collection. */
export function buildMeasurementRows(
  measurements: readonly Measurement[],
  unitSystem: UnitSystem,
): readonly ReportMeasurementRow[] {
  return measurements.map((m) => ({
    name: m.name,
    kind: m.kind,
    value: computeValue(m, unitSystem),
    pointCount: m.points.length,
  }));
}
