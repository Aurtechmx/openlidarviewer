/**
 * directionalGrade.ts — a route does not experience a cell's slope the same
 * way in every direction of travel. Implements §12.5 of the governing prompt
 * exactly, from the existing Horn slope/aspect convention rather than a
 * second slope estimator.
 *
 * ── THE CONVENTION, CARRIED FORWARD FROM `terrainDerivatives.ts` ────────────
 * `hornSlopeAspect` returns, per cell:
 *   - `slope` m: the rise/run TANGENT (dimensionless);
 *   - `aspect` α: the DOWNSLOPE direction in the math frame (CCW from east,
 *     π/2 = north), i.e. `u_down = (cos α, sin α)`.
 *
 * The elevation gradient ∇z points the opposite way — uphill — with the same
 * magnitude:
 *
 *     grad = -m · u_down = (-m·cos α, -m·sin α)
 *
 * and by construction `|grad| = m` (hypot of the two components reproduces
 * the tangent `hornSlopeAspect` already computed), so a flat cell (m = 0)
 * always yields a zero gradient regardless of the `aspect = 0` sentinel.
 *
 * For a horizontal, physical (east, north) unit heading `d`:
 *
 *     longitudinalGrade = |dot(grad, d)|
 *     n = (-d_north, d_east)              (perpendicular to d)
 *     crossSlope        = |dot(grad, n)|
 *
 * Both are TANGENTS, matching `TerrainAccessProfile.maxLongitudinalGrade` /
 * `maxCrossSlope` — see `terrainAccessTypes.ts` for why the profile is not in
 * degrees. `longitudinalGrade² + crossSlope² = m²` identically for any unit
 * `d` (Pythagorean decomposition of one gradient vector into two orthogonal
 * axes), which is pinned by test and is the reason comparing total slope to a
 * cross-slope limit (the §31 adversarial case) is a distinct, wrong number:
 * it is only ever ≥ the true cross slope for that heading, and strictly
 * greater whenever the heading is not exactly perpendicular to the downslope
 * direction.
 *
 * ── WHY THE HEADING IS A PHYSICAL UNIT VECTOR, NOT A RASTER DIRECTION ───────
 * A diagonal neighbour offset `(dx, dy) = (1, 1)` is not a 45° heading unless
 * the grid is square in metres. `headingUnit` scales by the grid's own
 * per-axis metric cell size before normalising, so an anisotropic grid (TA-10)
 * gets the true physical heading and not a raster-index approximation of one.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainDerivatives } from '../../terrain/ground/terrainDerivatives';

/** The elevation gradient (east, north), metres of rise per metre of run. */
export interface GradientVector {
  readonly east: number;
  readonly north: number;
}

/** Per-cell gradient vectors, row-major, from the Horn slope/aspect grids. */
export interface GradientField {
  readonly east: Float32Array;
  readonly north: Float32Array;
}

/**
 * The elevation gradient at one cell from its Horn slope tangent and
 * downslope aspect. See the module header for the derivation.
 */
export function gradientAt(slope: number, aspect: number): GradientVector {
  if (!Number.isFinite(slope) || !Number.isFinite(aspect)) return { east: 0, north: 0 };
  return { east: -slope * Math.cos(aspect), north: -slope * Math.sin(aspect) };
}

/** The gradient vector field over a whole grid, from Horn slope/aspect. */
export function gradientField(derivatives: TerrainDerivatives): GradientField {
  const { slope, aspect } = derivatives;
  const n = slope.length;
  const east = new Float32Array(n);
  const north = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = gradientAt(slope[i], aspect[i]);
    east[i] = g.east;
    north[i] = g.north;
  }
  return { east, north };
}

/** A physical horizontal unit heading (east, north components). */
export interface HeadingUnit {
  readonly east: number;
  readonly north: number;
}

/**
 * The physical unit heading for a raster offset `(dx, dy)` (columns east,
 * rows north — the project's northing-up convention), scaled by the grid's
 * own per-axis metric cell size so a diagonal on an anisotropic grid is not
 * mistaken for 45°.
 */
export function headingUnit(dx: number, dy: number, cellMetresX: number, cellMetresY: number): HeadingUnit {
  const east = dx * cellMetresX;
  const north = dy * cellMetresY;
  const len = Math.hypot(east, north);
  if (!(len > 0)) return { east: 0, north: 0 };
  return { east: east / len, north: north / len };
}

/** Longitudinal grade and cross slope for one gradient vector and heading. */
export interface DirectionalSlope {
  /** |dot(grad, heading)|, a rise/run tangent. */
  readonly longitudinalGrade: number;
  /** |dot(grad, perpendicular(heading))|, a rise/run tangent. */
  readonly crossSlope: number;
}

/**
 * Decompose a gradient vector into longitudinal grade (along `heading`) and
 * cross slope (perpendicular to it). See the module header for the formula
 * and its Pythagorean identity with the gradient magnitude.
 */
export function directionalSlope(grad: GradientVector, heading: HeadingUnit): DirectionalSlope {
  const longitudinal = grad.east * heading.east + grad.north * heading.north;
  // Perpendicular to (east, north) is (-north, east) — a 90° CCW rotation.
  const perpEast = -heading.north;
  const perpNorth = heading.east;
  const cross = grad.east * perpEast + grad.north * perpNorth;
  return { longitudinalGrade: Math.abs(longitudinal), crossSlope: Math.abs(cross) };
}
