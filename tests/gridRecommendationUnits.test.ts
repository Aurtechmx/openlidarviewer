/**
 * gridRecommendationUnits.test.ts — the grid/interval recommender is fed real
 * metres, or it is not consulted at all.
 *
 * `recommendGrid` selects from METRE ladders: cell sizes of 0.25, 0.5, 1, 2, 5,
 * 10, 20 m and matching contour intervals. It was handed `cols x cellSizeM` and
 * the raw elevation range, both of which are in the SOURCE units despite the
 * `M` suffixes (`rasterizeDtm` documents `cellSizeM` as "source linear units").
 * A US-survey-foot capture therefore presented as roughly 3.3 times its true
 * size and was advised for a site that big.
 *
 * The recommendation is advisory — nothing applies it, and the DTM and contours
 * are computed from the grid the user actually chooses — so the defect never
 * moved a committed figure. It still gave worse advice to exactly the users
 * least able to notice.
 *
 * Two properties: the extent is converted when a scale exists, and no
 * recommendation is produced when one does not.
 */

import { describe, it, expect } from 'vitest';
import { analyseContours, type AnalyseContoursParams } from '../src/terrain/contour/analyseContours';

/**
 * A gently sloping square, generated in whatever unit the caller names.
 *
 * The same physical site is expressed twice: once in metres, once in feet with
 * every coordinate divided by the foot factor. A recommender that converts
 * correctly reaches the same advice from both, because they are the same place.
 */
function slope(sideUnits: number, step: number, riseOverRun: number): Float32Array {
  const out: number[] = [];
  for (let x = 0; x <= sideUnits; x += step) {
    for (let y = 0; y <= sideUnits; y += step) out.push(x, y, x * riseOverRun);
  }
  return new Float32Array(out);
}

const M_PER_FT = 0.3048;
/** 200 m square at 2 m spacing, and the identical site in feet. */
const METRE_SITE = slope(200, 2, 0.05);
const FOOT_SITE = slope(200 / M_PER_FT, 2 / M_PER_FT, 0.05);

const BASE: AnalyseContoursParams = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' };

describe('the grid recommender is fed metres', () => {
  it('reaches the same advice for one site expressed in metres and in feet', () => {
    const metres = analyseContours(METRE_SITE, {
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    });
    // Same site, foot coordinates: the cell size is 2 FEET, so the grid covers
    // the same ground. Only the unit differs.
    const feet = analyseContours(FOOT_SITE, {
      ...BASE,
      cellSizeM: 2 / M_PER_FT,
      horizontalUnitToMetres: M_PER_FT,
      verticalUnitToMetres: M_PER_FT,
    });
    expect(metres.gridRecommendation).not.toBeNull();
    expect(feet.gridRecommendation).not.toBeNull();
    // Before the conversion the foot run measured its extent as ~656 rather
    // than 200, landing further up the ladder. Both now describe one site.
    expect(feet.gridRecommendation?.cellSizeM).toBe(metres.gridRecommendation?.cellSizeM);
    expect(feet.gridRecommendation?.contourIntervalM)
      .toBe(metres.gridRecommendation?.contourIntervalM);
  });

  it('withholds the recommendation when no linear unit resolves', () => {
    // No `horizontalUnitToMetres` and not geographic: the scale falls back to an
    // inert 1, which is the case that silently advised from source coordinates.
    const unresolved = analyseContours(METRE_SITE, { ...BASE, crs: null, verticalDatum: null });
    expect(unresolved.gridRecommendation, 'a metre ladder must not be applied to an unknown unit')
      .toBeNull();
  });

  it('still recommends for a resolved frame, so the refusal is not vacuous', () => {
    const resolved = analyseContours(METRE_SITE, { ...BASE, horizontalUnitToMetres: 1 });
    expect(resolved.gridRecommendation).not.toBeNull();
    expect(resolved.gridRecommendation?.cellSizeM).toBeGreaterThan(0);
  });
});
