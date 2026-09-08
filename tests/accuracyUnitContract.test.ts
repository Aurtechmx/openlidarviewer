/**
 * accuracyUnitContract.test.ts — a field whose name ends in M holds metres.
 *
 * `holdoutRmse` computes `residual = (z - predicted) * verticalUnitToMetres`
 * and falls back to an inert 1 when no vertical scale resolved, so on such a
 * frame the residuals are in SOURCE Z units. Those residuals reached
 * `demAccuracyStandards`, which names its outputs `rmseZM`, `nvaM` and `vvaM`.
 *
 * A reader of those names has no way to discover that the value might be feet
 * or arbitrary scanner units, and the analysis carries no other field saying
 * so. All three are `number | null` and every consumer already has a null path,
 * so an unresolved frame withholds the figure rather than mislabelling it.
 *
 * The residual statistics themselves are unaffected: `validation.rmse` is still
 * computed and still reported, in whatever unit the frame provides. What is
 * withheld is the metre-named accuracy standard derived from it.
 */

import { describe, it, expect } from 'vitest';
import { analyseContours, type AnalyseContoursParams } from '../src/terrain/contour/analyseContours';

/** A gentle slope dense enough for the hold-out to produce a figure. */
function slope(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 30; x += 0.5) {
    for (let y = 0; y <= 30; y += 0.5) pts.push(x, y, 10 + x * 0.04 + ((x * 3 + y * 7) % 4) * 0.01);
  }
  return new Float32Array(pts);
}

const BASE: AnalyseContoursParams = { cellSizeM: 1, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' };

describe('metre-named accuracy fields require a resolved vertical scale', () => {
  it('reports them on a frame that states its vertical unit', () => {
    const r = analyseContours(slope(), {
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    });
    // The fixture must produce a figure, or the withholding test below proves
    // nothing: an absent number would look identical either way.
    expect(r.accuracyStandards.rmseZM, 'the fixture must yield an accuracy figure')
      .not.toBeNull();
    expect(r.accuracyStandards.nvaM).not.toBeNull();
  });

  it('withholds them when no vertical scale resolved', () => {
    const r = analyseContours(slope(), { ...BASE, horizontalUnitToMetres: 1 });
    expect(r.accuracyStandards.rmseZM,
      'rmseZM held a source-unit value on an unresolved frame').toBeNull();
    expect(r.accuracyStandards.nvaM).toBeNull();
    expect(r.accuracyStandards.vvaM).toBeNull();
  });

  it('a foot frame still reports, because feet convert to metres', () => {
    // Withholding is for an UNRESOLVED scale, not a non-metre one: a declared
    // foot vertical is a known scale and converts exactly.
    const r = analyseContours(slope(), {
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 0.3048,
    });
    expect(r.accuracyStandards.rmseZM).not.toBeNull();
  });
});
