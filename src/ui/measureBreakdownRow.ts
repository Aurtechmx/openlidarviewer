/**
 * measureBreakdownRow.ts — the wording for a Distance or Area breakdown line.
 *
 * `measureBreakdown` produces the numbers; this turns them into the one compact
 * line the Measurements panel puts under a headline, and the tooltip that
 * qualifies it. Split out of `MeasurePanel` so the wording can be tested
 * without a DOM, and so the panel keeps deciding layout rather than phrasing.
 *
 * Two wording rules carry real weight:
 *
 *   - The ring's plane area is labelled "Plane", never "Surface". Nothing here
 *     drapes over terrain between the vertices, so "surface area" would claim a
 *     quantity that was not computed.
 *   - Under a compound CRS the run and the rise stay exact while the slant, the
 *     plane area, the perimeter and the grade combine two linear units. Those
 *     are marked rather than dropped, so a reader keeps the figures that hold
 *     and is told which ones do not.
 *
 * Formatters are injected rather than imported so this module states no opinion
 * about units, and a test reads the composition instead of the number
 * formatting it already trusts elsewhere.
 *
 * Pure — no DOM.
 */

import type { UnitSystem } from '../render/measure/types';
import type { AreaBreakdown, LineBreakdown } from '../render/measure/measureBreakdown';

/** The formatters this borrows from the measurement stack. */
export interface BreakdownFormatters {
  formatLength(metres: number, system: UnitSystem): string;
  formatArea(squareMetres: number, system: UnitSystem): string;
  formatGrade(percent: number): string;
  formatAngle(degrees: number): string;
}

/** The subset of a measurement summary this reads. */
export interface BreakdownSource {
  readonly kind: string;
  readonly lineMetrics?: LineBreakdown;
  readonly areaMetrics?: AreaBreakdown;
}

/** A rendered breakdown: the visible line, and the tooltip that qualifies it. */
export interface BreakdownLine {
  readonly text: string;
  readonly title: string;
}

/** Said when a compound CRS makes some of the figures combine two units. */
const MIXED_UNITS_NOTE =
  'This scan declares a different unit for height than for the horizontal axes. ' +
  'The run and the rise are exact; the slant length, the plane area, the perimeter ' +
  'and the grade combine both units and are not reliable distances.';

const PLANE_AREA_NOTE =
  'Plane is the area of the ring’s own best-fit plane, not a terrain surface: ' +
  'nothing is draped over the ground between the vertices.';

/**
 * Compose the breakdown line for `s`, or null when the measurement has none.
 *
 * A grade that is not finite belongs to a purely vertical pair, which has no
 * run to divide by. It is omitted rather than printed as infinity.
 */
export function breakdownParts(
  s: BreakdownSource,
  system: UnitSystem,
  fmt: BreakdownFormatters,
): BreakdownLine | null {
  const line = s.lineMetrics;
  if (line) {
    const parts = [
      `Run ${fmt.formatLength(line.horizontalM, system)}`,
      `Rise ${fmt.formatLength(line.verticalM, system)}`,
      `Slant ${fmt.formatLength(line.length3dM, system)}`,
    ];
    if (Number.isFinite(line.gradePercent)) {
      parts.push(`Grade ${fmt.formatGrade(line.gradePercent)} (${fmt.formatAngle(line.gradeAngleDeg)})`);
    }
    return {
      text: parts.join(' · '),
      title: line.mixedUnits
        ? MIXED_UNITS_NOTE
        : 'Run is the map-plane distance, rise the height change, slant the straight line through space.',
    };
  }

  const area = s.areaMetrics;
  if (area) {
    const parts = [
      `Horizontal ${fmt.formatArea(area.horizontalM2, system)}`,
      `Plane ${fmt.formatArea(area.planarM2, system)}`,
      `Perimeter ${fmt.formatLength(area.perimeterM, system)}`,
      `${area.vertexCount} vertices`,
    ];
    return {
      text: parts.join(' · '),
      title: area.mixedUnits ? `${PLANE_AREA_NOTE} ${MIXED_UNITS_NOTE}` : PLANE_AREA_NOTE,
    };
  }

  return null;
}
