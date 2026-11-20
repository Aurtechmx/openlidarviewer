/**
 * The linear unit of a projected CRS is read from the projected CRS's own unit
 * clause, never from a unit inside its base geographic CRS, a projection
 * parameter or the conversion.
 *
 * A WKT1 PROJCS with no UNIT of its own still contains the GEOGCS angular unit
 * (degree, 0.0174532925199433). Taking that as the linear unit reported every
 * distance at about 1.7 percent of its length as a permitted metre figure.
 * With no unit of its own, the projected CRS takes the unit its EPSG code
 * defines, or 'unknown'.
 */
import { describe, expect, it } from 'vitest';
import { crsFromWkt } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';

const GEOGCS_WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';

/** A projected CRS with no UNIT of its own. */
const SITE_GRID_NO_UNIT = `PROJCS["Site grid",${GEOGCS_WGS84},PROJECTION["Transverse_Mercator"]]`;

/** The same, carrying the EPSG code of a metre CRS. */
const UTM12N_NO_UNIT = `PROJCS["WGS 84 / UTM zone 12N",${GEOGCS_WGS84},PROJECTION["Transverse_Mercator"],AUTHORITY["EPSG","32612"]]`;

const UTM12N = `PROJCS["WGS 84 / UTM zone 12N",${GEOGCS_WGS84},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-111],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","32612"]]`;

const STATE_PLANE_FTUS = 'PROJCS["NAD83 / California zone 5 (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["standard_parallel_1",35.46666666666667],PARAMETER["standard_parallel_2",34.03333333333333],PARAMETER["latitude_of_origin",33.5],PARAMETER["central_meridian",-118],PARAMETER["false_easting",6561666.667],PARAMETER["false_northing",1640416.667],UNIT["US survey foot",0.3048006096012192],AUTHORITY["EPSG","2229"]]';

/** WKT2: the conversion parameters carry metres, the CS axes US survey feet. */
const WKT2_FTUS = 'PROJCRS["NAD83 / California zone 5 (ftUS)",BASEGEOGCRS["NAD83",DATUM["North American Datum 1983",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]],CONVERSION["SPCS83 California zone 5 (US survey foot)",METHOD["Lambert Conic Conformal (2SP)"],PARAMETER["Latitude of false origin",33.5,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Easting at false origin",2000000,LENGTHUNIT["metre",1]],PARAMETER["Northing at false origin",500000,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["US survey foot",0.304800609601219]],AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["US survey foot",0.304800609601219]],ID["EPSG",2229]]';

describe('a PROJCS with no UNIT of its own', () => {
  it('does not take the GEOGCS degree as its linear unit', () => {
    const info = crsFromWkt(SITE_GRID_NO_UNIT);
    expect(info.isGeographic).toBe(false);
    expect(info.linearUnit).toBe('unknown');
    expect(info.linearUnitToMetres).toBe(1);
    expect(info.linearUnitByFactor).toBeUndefined();
    expect(spatialContextFrom(info).metricClaimsPermitted).toBe(false);
  });

  it('takes the unit its EPSG code defines', () => {
    const info = crsFromWkt(UTM12N_NO_UNIT);
    expect(info.epsg).toBe(32612);
    expect(info.linearUnit).toBe('metre');
    expect(info.linearUnitToMetres).toBe(1);
  });
});

describe('a projected CRS with its own unit is unchanged', () => {
  it('UTM WKT1 is metre', () => {
    const info = crsFromWkt(UTM12N);
    expect(info.linearUnit).toBe('metre');
    expect(info.linearUnitToMetres).toBe(1);
  });

  it('state plane ftUS WKT1 is US survey foot', () => {
    const info = crsFromWkt(STATE_PLANE_FTUS);
    expect(info.linearUnit).toBe('us-survey-foot');
    expect(info.linearUnitToMetres).toBe(1200 / 3937);
  });

  it('WKT2 with metre parameters and a US survey foot CS is US survey foot', () => {
    const info = crsFromWkt(WKT2_FTUS);
    expect(info.linearUnit).toBe('us-survey-foot');
    expect(info.linearUnitToMetres).toBe(1200 / 3937);
  });
});
