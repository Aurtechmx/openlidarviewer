import { describe, it, expect } from 'vitest';
import { planPlacement, placeInProject } from '../src/geo/projectPlacement';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { CrsInfo } from '../src/io/crs';
import type { GlobalPoints } from '../src/convert/globalPoints';

const US_SURVEY_FOOT = 1200 / 3937;

function crs(over: Partial<CrsInfo> = {}): CrsInfo {
  return {
    source: 'wkt',
    name: 'WGS 84 / UTM zone 12N',
    epsg: 32612,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    isGeographic: false,
    ...over,
  };
}

/** A frame whose vertical side is fully declared: NAVD88 heights in metres. */
const navd88Metres = () =>
  spatialContextFrom(crs({ verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalUnitToMetres: 1 }));

/** The same datum, declared in US survey feet. */
const navd88Feet = () =>
  spatialContextFrom(
    crs({ verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalUnitToMetres: US_SURVEY_FOOT }),
  );

/** A different vertical surface, also fully declared, also in metres. */
const egm2008Metres = () =>
  spatialContextFrom(crs({ verticalEpsg: 3855, verticalDatum: 'EGM2008', verticalUnitToMetres: 1 }));

/** Nothing declared vertically. */
const noVertical = () => spatialContextFrom(crs());

describe('planPlacement', () => {
  const both = { layerFrame: navd88Metres(), projectFrame: navd88Metres() };

  it('reprojects between two known projected CRSs, height comparable', () => {
    const p = planPlacement({ layerEpsg: 32611, projectEpsg: 32612, ...both });
    expect(p.horizontal).toBe('reproject');
    expect(p.verticalComparable).toBe(true);
    expect(p.reasonCode).toBe('REPROJECT');
  });

  it('is identity when the layer already matches the project CRS', () => {
    const p = planPlacement({ layerEpsg: 32612, projectEpsg: 32612, ...both });
    expect(p.horizontal).toBe('identity');
  });

  it('needs registration when the layer has no CRS', () => {
    const p = planPlacement({ layerEpsg: null, projectEpsg: 32612, ...both });
    expect(p.horizontal).toBe('needs-registration');
    expect(p.reasonCode).toBe('LAYER_NO_CRS');
  });

  it('needs a project CRS before any layer can reproject', () => {
    const p = planPlacement({ layerEpsg: 32611, projectEpsg: null, ...both });
    expect(p.reasonCode).toBe('NO_PROJECT_CRS');
  });

  it('withholds height comparability when a vertical datum is unresolved', () => {
    const p = planPlacement({
      layerEpsg: 32611,
      projectEpsg: 32612,
      layerFrame: navd88Metres(),
      projectFrame: noVertical(),
    });
    expect(p.horizontal).toBe('reproject'); // X/Y still placed
    expect(p.verticalComparable).toBe(false);
    expect(p.reason).toContain('Vertical datum is unknown');
  });

  // Both sides fully declared is not the same question as both sides
  // comparable. These two cases are the ones a "is it known?" test cannot see.
  it('withholds height when two resolved datums sit on different surfaces', () => {
    const p = planPlacement({
      layerEpsg: 32612,
      projectEpsg: 32612,
      layerFrame: navd88Metres(),
      projectFrame: egm2008Metres(),
    });
    expect(p.horizontal).toBe('identity');
    expect(p.verticalComparable).toBe(false);
    expect(p.reason).toContain('common surface');
  });

  it('withholds height when one resolved datum is in feet and the other in metres', () => {
    const p = planPlacement({
      layerEpsg: 32612,
      projectEpsg: 32612,
      layerFrame: navd88Feet(),
      projectFrame: navd88Metres(),
    });
    expect(p.verticalComparable).toBe(false);
    expect(p.reason).toContain('withheld');
  });

  it('allows height when the datum and the vertical unit both match', () => {
    const p = planPlacement({
      layerEpsg: 32611,
      projectEpsg: 32612,
      layerFrame: navd88Metres(),
      projectFrame: navd88Metres(),
    });
    expect(p.verticalComparable).toBe(true);
  });
});

describe('placeInProject', () => {
  it('moves X/Y between adjacent UTM zones and carries Z through', () => {
    // A point near the 11N/12N boundary; its easting changes across the zones.
    const g: GlobalPoints = {
      count: 1,
      x: Float64Array.from([500000]),
      y: Float64Array.from([4000000]),
      z: Float64Array.from([123.5]),
    };
    const res = placeInProject(g, 32611, 32612);
    expect(res.transformed).toBe(true);
    expect(res.points.x[0]).not.toBeCloseTo(500000, 0); // easting moved
    expect(res.points.z[0]).toBe(123.5); // Z unchanged
  });

  it('is a no-op when source and target CRS match', () => {
    const g: GlobalPoints = { count: 1, x: Float64Array.from([1]), y: Float64Array.from([2]), z: Float64Array.from([3]) };
    expect(placeInProject(g, 32612, 32612).transformed).toBe(false);
  });
});
