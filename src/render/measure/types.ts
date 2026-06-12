/**
 * types.ts
 *
 * The measurement toolkit's data model — a discriminated set over the six
 * measurement kinds. Pure data: no three.js, no DOM, so it is unit-tested in
 * Node alongside `geometry.ts`.
 *
 * Coordinates in `Measurement.points` are LOCAL (render-space) — the same
 * space the cloud's positions live in. Derived values (length, area, angle …)
 * are never stored; `geometry.ts` recomputes them from `points`, so an edit
 * always stays consistent and there is a single source of truth.
 */

import type { Vec3 } from '../navMath';

export type { Vec3 };

/** The measurement kinds the toolkit supports. */
export type MeasurementKind =
  | 'distance'
  | 'polyline'
  | 'area'
  | 'height'
  | 'angle'
  | 'slope'
  /**
   * Cross-section / profile — a 2-point measurement that exposes the
   * full geometry of a line through space: 3D length, horizontal length,
   * vertical drop, and grade. The two endpoints define a profile line; a
   * future iteration will sample point-cloud heights along the line and
   * render a height-distance chart, persisted with the measurement. The
   * scalar fields land here first so the kind, its picker entry, and the
   * session schema are stable.
   */
  | 'profile'
  /**
   * Box — a 2-point axis-aligned bounding-box measurement. The two
   * picked points are opposite corners of a diagonal; the box is
   * normalised per-axis (so any pick direction yields the same box).
   * Headline shows width × depth × height + volume. Powers the
   * Box-clipping inspector toggle and provides the polygon for the
   * upcoming volume cut/fill measurement.
   */
  | 'box'
  /**
   * Volume — polygon footprint + horizontal reference plane → cubic
   * metres of fill (above plane) and cut (below plane). Open-ended
   * vertex count like `area`; the reference Z and the per-point
   * cut/fill bucket are computed by `volumeCutFill` against the loaded
   * cloud's positions. The flagship v0.3.7 surveyor capability.
   */
  | 'volume';

/** Unit system for displayed values; toggled live from the Measurements panel. */
export type UnitSystem = 'metric' | 'imperial';

/**
 * A single height-vs-distance sample along a profile transect. NaN
 * `height` means "no points were near this bin" — the chart renders the
 * gap as a discontinuity rather than interpolating a phantom value.
 * See `profileSampler.ts`.
 */
export interface ProfileChartSample {
  /** Distance from the profile's start, measured in the horizontal plane. */
  distance: number;
  /** Elevation at this distance, measured along the world up vector. */
  height: number;
  /**
   * Corridor point count behind this bin's elevation estimate. Optional so a
   * measurement loaded from a pre-v0.4.5 session file (recorded before the
   * sampler stored counts) still validates; consumers (the profile CSV)
   * render an honest blank rather than a fabricated 0.
   */
  count?: number;
}

/**
 * Volume measurement result — populated by the controller from
 * `volumeCutFill` against the loaded cloud when the polygon commits.
 * Persisted so the headline can read its cut / fill / net without
 * re-sampling and so the PDF report has a stable record to include.
 */
export interface VolumeRecord {
  /** Cubic metres above the reference plane. */
  fill: number;
  /** Cubic metres below the reference plane. */
  cut: number;
  /** Net = fill − cut, m³. */
  net: number;
  /** Reference Z used (local render-space), m. */
  referenceZ: number;
  /** Polygon footprint area on the horizontal plane, m². */
  footprintArea: number;
  /** Cloud points whose XY projection lay inside the polygon. */
  pointsInPolygon: number;
  /** Sample density inside the polygon (points / m²). */
  density: number;
  /**
   * Confidence band, derived from `pointsInPolygon`:
   *   - `'high'`   — ≥ 1 000 points
   *   - `'medium'` — 100..999 points
   *   - `'low'`    — < 100 points
   *
   * The PDF report card surfaces this so a low-coverage result reads
   * as an estimate rather than a survey-grade volume. The methodology
   * caveat ("Point-sample integration assumes uniform coverage") is the
   * same on every confidence level — the badge is what the analyst sees
   * first when scanning the report.
   */
  confidence: 'high' | 'medium' | 'low';
}

/** A single placed measurement. */
export interface Measurement {
  /** Stable unique identifier. */
  id: string;
  /** Which measurement kind this is. */
  kind: MeasurementKind;
  /** User-facing, renameable label (e.g. "Polyline 2"). */
  name: string;
  /** Vertices in LOCAL (render-space) coordinates, in placement order. */
  points: Vec3[];
  /** Area only — true once the polygon ring has been closed. */
  closed?: boolean;
  /**
   * Profile only — a sampled height-vs-distance series, populated by the
   * controller after the second vertex lands. Optional so a measurement
   * loaded from a pre-chart session file still validates; the panel falls
   * back to the scalar metrics row in that case.
   */
  profileChart?: ProfileChartSample[];
  /**
   * Profile only — true when the chart was sampled against a streaming
   * cloud's resident node set rather than a fully-loaded static cloud.
   * The Measurements panel surfaces this as a "Resident-node analysis
   * only — may refine as streaming loads" caption so the analyst knows
   * the profile can change as more nodes stream in.
   */
  profileChartResidentOnly?: boolean;
  /**
   * Profile only — the corridor half-width the sampler ACTUALLY used, in
   * RENDER (source) units, the same space as `points`. Stamped at commit
   * (v0.4.5, B4) so the PDF/CSV provenance can print the real value instead
   * of "auto"; converted to metres at the controller's summary boundary
   * alongside the chart series. Optional: pre-v0.4.5 measurements omit it.
   */
  profileCorridorWidth?: number;
  /**
   * Profile only — the bare-earth percentile (0..100) the sampler reduced
   * each corridor with. Dimensionless, so no unit conversion. Optional, same
   * provenance rationale as `profileCorridorWidth`.
   */
  profileGroundPercentile?: number;
  /**
   * Volume only — the cut/fill record from `volumeCutFill`. Optional so
   * a volume measurement loaded from a session file that pre-dates the
   * sampler (or one with no cloud loaded) still validates; the panel
   * shows a "—" placeholder in that case.
   */
  volume?: VolumeRecord;
  /**
   * Volume only — true when the cut/fill record was sampled from
   * streaming resident points only. The Measurements panel surfaces a
   * coverage caption beneath the volume headline so the analyst knows
   * the cubic-metres figure can refine as more nodes stream in.
   */
  volumeResidentOnly?: boolean;
}

/** Minimum vertex count for a measurement of each kind to be meaningful. */
export const MIN_POINTS: Record<MeasurementKind, number> = {
  distance: 2,
  polyline: 2,
  area: 3,
  height: 2,
  angle: 3,
  slope: 2,
  profile: 2,
  box: 2,
  volume: 3,
};

/**
 * Kinds whose vertex count is fixed — placement auto-completes once the count
 * is reached. `polyline` and `area` accept an open-ended number of vertices.
 */
export const FIXED_POINTS: Partial<Record<MeasurementKind, number>> = {
  distance: 2,
  height: 2,
  angle: 3,
  slope: 2,
  profile: 2,
  box: 2,
};

/** True once a measurement has enough vertices to display a result. */
export function isComplete(m: Measurement): boolean {
  if (m.points.length < MIN_POINTS[m.kind]) return false;
  if (m.kind === 'area') return m.closed === true;
  const fixed = FIXED_POINTS[m.kind];
  return fixed === undefined || m.points.length >= fixed;
}

/** True once placing a further vertex is no longer allowed for this kind. */
export function isFull(m: Measurement): boolean {
  const fixed = FIXED_POINTS[m.kind];
  return fixed !== undefined && m.points.length >= fixed;
}
