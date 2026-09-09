/**
 * terrainRunnerUnitFacts.test.ts — the live runner tells the core whether the
 * frame RESOLVED a scale, not just what factor to use.
 *
 * `deriveCoreParams` supplies `verticalUnitToMetres` under the GeoTIFF geometry
 * policy, which for a scan with no CRS is the inert placeholder 1 (the raster's
 * thresholds and floors must stay self-consistent whatever the unit is). The
 * core derived "vertical scale resolved" from that factor being finite and
 * positive, so on the live path it was ALWAYS resolved: every unit-withholding
 * branch this cycle added — the "source Z units" captions, the withheld
 * rmseZM/nvaM/vvaM, the withheld grid recommendation — was reachable only from
 * tests that pass an undefined factor, which no production caller does.
 *
 * The runner now states the two facts beside the two factors, under the claim
 * policy the panel already uses. This test drives the REAL runner entry point
 * with a no-CRS context and a metre context and reads the core's verdict.
 */

import { describe, it, expect } from 'vitest';
import { deriveCoreParams } from '../src/app/terrainAnalysisRunner';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import type { CrsService } from '../src/geo/CrsService';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { spatialContextFrom } from '../src/geo/SpatialContext';

/** A gentle slope, dense enough for a hold-out figure and a grid recommendation. */
function slope(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 30; x += 0.5) {
    for (let y = 0; y <= 30; y += 0.5) pts.push(x, y, 10 + x * 0.04 + ((x * 3 + y * 7) % 4) * 0.01);
  }
  return Float32Array.from(pts);
}

function fakeCrs(current: ResolvedCrs): CrsService {
  return {
    current: () => current,
    context: () => spatialContextFrom(current),
  } as unknown as CrsService;
}

/** What CrsService resolves for a file with no CRS: the placeholder factor 1. */
const NO_CRS: ResolvedCrs = {
  kind: 'unknown', name: 'CRS unknown', linearUnit: 'unknown', linearUnitToMetres: 1,
  source: 'default-assumption', confidence: 'none', userConfirmed: false,
};
const METRE_UTM: ResolvedCrs = {
  kind: 'projected', name: 'WGS 84 / UTM zone 10N', epsg: 32610, linearUnit: 'metre',
  linearUnitToMetres: 1, source: 'las-vlr', confidence: 'high', userConfirmed: false,
};

describe('deriveCoreParams states the frame facts beside the factors', () => {
  it('passes a placeholder factor AND says the scale is unresolved for a no-CRS scan', () => {
    const p = deriveCoreParams(slope(), undefined, fakeCrs(NO_CRS));
    // The factor is still 1: geometry needs a number.
    expect(p.verticalUnitToMetres).toBe(1);
    expect(p.horizontalUnitToMetres).toBe(1);
    // The facts say what the factor cannot.
    expect(p.verticalScaleKnown, 'a placeholder factor was reported as a resolved scale').toBe(false);
    expect(p.horizontalScaleKnown).toBe(false);
  });

  it('says both scales are resolved for a metre UTM scan', () => {
    const p = deriveCoreParams(slope(), undefined, fakeCrs(METRE_UTM));
    expect(p.verticalScaleKnown).toBe(true);
    expect(p.horizontalScaleKnown).toBe(true);
  });

  it('the core withholds on the LIVE params, not only on undefined factors', () => {
    // Drive the analysis with exactly what the runner produces.
    const unresolved = analyseContours(slope(), deriveCoreParams(slope(), undefined, fakeCrs(NO_CRS)));
    expect(unresolved.verticalScaleResolved, 'the live no-CRS path still claimed a resolved vertical scale')
      .toBe(false);
    expect(unresolved.accuracyStandards.rmseZM).toBeNull();
    expect(unresolved.gridRecommendation, 'a metre ladder was applied to raw coordinates').toBeNull();

    const resolved = analyseContours(slope(), deriveCoreParams(slope(), undefined, fakeCrs(METRE_UTM)));
    expect(resolved.verticalScaleResolved).toBe(true);
    expect(resolved.gridRecommendation).not.toBeNull();
  });
});
