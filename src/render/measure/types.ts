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
  | 'profile';

/** Unit system for displayed values; toggled live from the Measurements panel. */
export type UnitSystem = 'metric' | 'imperial';

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
