/**
 * measureBreakdown.ts — the values a Distance or an Area already knows.
 *
 * A two-point Distance carries more than one number. The same pick also fixes
 * the map-plane run, the height change, and the grade between the two points,
 * and `profileMetrics` has computed all four since the Profile kind was added.
 * Reading them meant placing a SECOND measurement of a different kind over the
 * same two points. A closed Area is the same story: the ring fixes its
 * planimetric area, the area of its best-fit plane, its perimeter and its
 * vertex count, and `geometry.ts` computes each of them already.
 *
 * This module does no geometry. It calls the existing functions and does one
 * job on top: cross from render units into metres, using the factor that
 * belongs to each quantity.
 *
 * WHY THE FACTORS ARE SPLIT. A compound CRS declares one linear unit for the
 * horizontal axes and another for height. A pure horizontal quantity (the map
 * run, the planimetric area, both scaled by the horizontal factor alone) and a
 * pure vertical one (the height change, scaled by the vertical factor alone)
 * stay exact under that CRS. A quantity that COMBINES the two axes cannot be
 * repaired by either factor: the 3D length, the tilted plane area, the 3D
 * perimeter and the grade all mix units. Those carry {@link Breakdown.mixedUnits}
 * so a reader is told which figures to trust, rather than the whole card being
 * withheld or, worse, presented as if a single unit described it. This is the
 * same split `MeasureController` applies to the headline and the trust grade
 * (`VERTICAL_MISMATCH_KINDS`); nothing here overrides that verdict.
 *
 * Pure — no DOM, no three.js.
 */

import {
  polygonAreaHorizontal,
  polygonAreaPlanar,
  polygonPerimeter,
  profileMetrics,
} from './geometry';
import type { Vec3 } from '../navMath';

/** Shared by both breakdowns: whether the figures combine two linear units. */
interface Breakdown {
  /**
   * True when the scene declares a vertical linear unit that differs from the
   * horizontal one. The pure-horizontal and pure-vertical members stay exact;
   * the members that combine both axes are the ones this warns about.
   */
  readonly mixedUnits: boolean;
}

/** What a two-point line knows about itself, in metres. */
export interface LineBreakdown extends Breakdown {
  /**
   * Straight-line length through space. COMBINES both axes, so it is one of
   * the figures {@link Breakdown.mixedUnits} qualifies.
   *
   * Composed from the two converted components rather than by scaling the
   * render-space 3D length, because there is no single factor that converts a
   * mixed-axis length. Under a single linear unit the two are the same number.
   */
  readonly length3dM: number;
  /** Map-plane run, perpendicular to up. Pure horizontal, so always exact. */
  readonly horizontalM: number;
  /** Signed height change from the first point to the second. Pure vertical. */
  readonly verticalM: number;
  /**
   * Rise over run as a percentage, signed. Dimensionless, so no factor applies,
   * but it combines both axes and is qualified by {@link Breakdown.mixedUnits}.
   * Non-finite for a vertical pair, which has no run to divide by.
   */
  readonly gradePercent: number;
  /** Inclination from horizontal in degrees, in the range −90 to 90. */
  readonly gradeAngleDeg: number;
}

/** What a closed ring knows about itself, in metres and square metres. */
export interface AreaBreakdown extends Breakdown {
  /**
   * Area projected onto the map plane. Pure horizontal (the factor squared),
   * so it is exact under a compound CRS. This is the figure a plan drawing
   * means by "area".
   */
  readonly horizontalM2: number;
  /**
   * Area of the ring's own BEST-FIT PLANE. It is larger than the planimetric
   * area for a tilted ring, and it is NOT a draped terrain surface area:
   * nothing here follows the ground between the vertices. A caller that labels
   * this "surface area" is making a claim the number does not support.
   */
  readonly planarM2: number;
  /** Perimeter through space, following the ring in 3D. Combines both axes. */
  readonly perimeterM: number;
  /** Vertices in the ring, not counting a repeated closing vertex. */
  readonly vertexCount: number;
}

/** True when the two declared linear units differ enough to matter. */
function unitsDiffer(horizontalToMetres: number, verticalToMetres: number): boolean {
  return Math.abs(verticalToMetres - horizontalToMetres) > 1e-12;
}

/**
 * The full description of the line from `a` to `b`, in metres.
 *
 * `up` is the scene's world-up axis, so a Y-up scan is measured against its own
 * vertical rather than against an assumed Z. `verticalToMetres` defaults to the
 * horizontal factor, which is the single-unit case.
 */
export function lineBreakdown(
  a: Vec3,
  b: Vec3,
  up: Vec3,
  horizontalToMetres: number,
  verticalToMetres: number = horizontalToMetres,
): LineBreakdown {
  const pm = profileMetrics(a, b, up);
  const horizontalM = pm.lengthHorizontal * horizontalToMetres;
  const verticalM = pm.verticalDrop * verticalToMetres;
  return {
    length3dM: Math.hypot(horizontalM, verticalM),
    horizontalM,
    verticalM,
    gradePercent: pm.gradePercent,
    gradeAngleDeg: pm.gradeAngleDeg,
    mixedUnits: unitsDiffer(horizontalToMetres, verticalToMetres),
  };
}

/**
 * The full description of a closed ring, in metres.
 *
 * `points` are the ring's vertices in render space, in placement order. A ring
 * of fewer than three vertices has no area; every figure comes back zero rather
 * than as a fabricated value.
 */
export function areaBreakdown(
  points: readonly Vec3[],
  up: Vec3,
  horizontalToMetres: number,
  verticalToMetres: number = horizontalToMetres,
): AreaBreakdown {
  const mixedUnits = unitsDiffer(horizontalToMetres, verticalToMetres);
  if (points.length < 3) {
    return {
      horizontalM2: 0,
      planarM2: 0,
      perimeterM: 0,
      vertexCount: points.length,
      mixedUnits,
    };
  }
  const ring = [...points];
  // Area converts by the factor SQUARED: it is a product of two lengths, so
  // converting once under-reports by the factor itself.
  const areaFactor = horizontalToMetres * horizontalToMetres;
  return {
    horizontalM2: polygonAreaHorizontal(ring, up) * areaFactor,
    planarM2: polygonAreaPlanar(ring) * areaFactor,
    perimeterM: polygonPerimeter(ring) * horizontalToMetres,
    vertexCount: ring.length,
    mixedUnits,
  };
}
