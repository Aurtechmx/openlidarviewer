/**
 * scaleBar.ts: the scale-bar unit rule shared by the contour map sheet and the
 * watershed report maps. Pure, with no PDF dependency, so either can import it
 * without pulling in the other.
 */

/** The map's source linear unit, as MapSheetInput['linearUnit'] states it. */
export type ScaleBarLinearUnit = 'metre' | 'foot' | 'us-survey-foot' | 'unknown' | undefined;

/**
 * The scale-bar ground unit + per-label divisor for a given total ground length
 * and the map's SOURCE linear unit. Pure and exported so the label-vs-value
 * contract can be asserted without rendering a PDF.
 *
 * The map frame is drawn in the CRS's source units, so the bar's `totalGround`
 * is in those units. A foot CRS labels feet plainly with no km grouping — the
 * bar must never read "1 km" for what is really 1000 ft. Metres (the standing
 * default for an omitted / metre / unknown unit) group up to km past 1000.
 */
export function scaleBarUnit(
  totalGround: number,
  linearUnit: ScaleBarLinearUnit,
): { unit: string; divisor: number } {
  const isFootUnit = linearUnit === 'foot' || linearUnit === 'us-survey-foot';
  if (isFootUnit) return { unit: 'ft', divisor: 1 };
  // An unresolved frame is not metres. It also cannot be grouped into km:
  // dividing by 1000 only means anything once the unit is known, so an unknown
  // unit keeps its own magnitude and says so.
  if (linearUnit !== 'metre') return { unit: 'units', divisor: 1 };
  const groupKm = totalGround >= 1000;
  return { unit: groupKm ? 'km' : 'm', divisor: groupKm ? 1000 : 1 };
}
