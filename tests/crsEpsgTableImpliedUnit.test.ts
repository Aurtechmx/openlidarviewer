/**
 * A projected code that arrives with no unit of its own takes the unit the
 * EPSG table gives it.
 *
 * `impliedProjectedLinearUnit` answered from the curated registry and twenty
 * metre ranges, so a code outside them resolved to an unknown unit although
 * the table knows it: ProjectedCRSGeoKey 3072=2229 alone, 6350 (NAD83(2011)
 * / Conus Albers), 5070 (NAD83 / Conus Albers), 3577 (GDA94 / Australian
 * Albers), and a PROJCS with an AUTHORITY code but no UNIT. The table now
 * answers: metre, international foot or US survey foot, and 'unknown' for
 * any other unit or a code the table does not hold.
 */
import { describe, expect, it } from 'vitest';
import { crsFromEpsg, crsFromGeoTiff, crsFromWkt, impliedProjectedLinearUnit } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { validateCrsForMeasurement } from '../src/geo/CrsValidation';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';

const FT_US = 1200 / 3937;

/** A GeoKeyDirectory payload from [key, value] pairs (all inline shorts). */
function geoKeys(keys: readonly (readonly [number, number])[]): Uint8Array {
  const u = new Uint16Array(4 + keys.length * 4);
  u.set([1, 1, 0, keys.length]);
  keys.forEach(([k, v], i) => u.set([k, 0, 1, v], 4 + i * 4));
  return new Uint8Array(u.buffer);
}

describe('a code with no unit key takes the EPSG table\'s unit', () => {
  it('3072=2229 alone is US survey feet', () => {
    const crs = crsFromGeoTiff(geoKeys([[1024, 1], [3072, 2229]]), null, null);
    expect(crs.linearUnit).toBe('us-survey-foot');
    expect(crs.linearUnitToMetres).toBe(FT_US);
    expect(spatialContextFrom(crs).metricClaimsPermitted).toBe(true);
  });

  it.each([6350, 5070, 3577])('EPSG:%i is metres', (epsg) => {
    expect(impliedProjectedLinearUnit(epsg)).toBe('metre');
    const crs = crsFromGeoTiff(geoKeys([[1024, 1], [3072, epsg]]), null, null);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
  });

  it('an international-foot code (EPSG:2222) is feet', () => {
    expect(impliedProjectedLinearUnit(2222)).toBe('foot');
  });

  it('a PROJCS with an AUTHORITY code and no UNIT takes the code\'s unit', () => {
    const ft = crsFromWkt('PROJCS["NAD83 / California zone 5 (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],AUTHORITY["EPSG","2229"]]');
    expect(ft.linearUnit).toBe('us-survey-foot');
    expect(ft.linearUnitToMetres).toBe(FT_US);
    const m = crsFromWkt('PROJCS["NAD83(2011) / Conus Albers",GEOGCS["NAD83(2011)",DATUM["NAD83_National_Spatial_Reference_System_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Albers_Conic_Equal_Area"],AUTHORITY["EPSG","6350"]]');
    expect(m.linearUnit).toBe('metre');
  });

  it('crsFromEpsg (EPT codes) gives US survey feet for 2229', () => {
    expect(crsFromEpsg(2229).linearUnit).toBe('us-survey-foot');
  });
});

describe('codes the table cannot vouch for stay unknown', () => {
  it.each([
    [2181, 'not in the table'],
    [90000, 'not in the table'],
    [2066, 'a unit other than metre or foot'],
    [4326, 'geographic'],
    [4978, 'geocentric'],
  ])('EPSG:%i (%s)', (epsg) => {
    expect(impliedProjectedLinearUnit(epsg)).toBe('unknown');
  });

  it('no code', () => {
    expect(impliedProjectedLinearUnit(undefined)).toBe('unknown');
  });
});

describe('Web Mercator keeps its grid-only verdict', () => {
  it('3072=3857 alone is metres, and measurement refuses it as grid-only', () => {
    expect(impliedProjectedLinearUnit(3857)).toBe('metre');
    const crs = crsFromGeoTiff(geoKeys([[1024, 1], [3072, 3857]]), null, null);
    expect(crs.linearUnit).toBe('metre');
    expect(validateCrsForMeasurement(resolvedFromCrsInfo(crs, 'las-vlr')).validity).toBe('grid-only');
    expect(spatialContextFrom(crs).metricClaimsPermitted).toBe(false);
  });
});
