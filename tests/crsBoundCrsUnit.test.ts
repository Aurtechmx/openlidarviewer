/**
 * A WKT2 BOUNDCRS wraps the CRS the coordinates are in (SOURCECRS) together
 * with a TARGETCRS and the transformation between them. Name, EPSG and units
 * come from the source CRS only: the target's ellipsoid metre and the
 * transformation's parameter units say nothing about the coordinate unit.
 */
import { describe, it, expect } from 'vitest';
import { crsFromWkt, toMetres } from '../src/io/crs';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';

const FTUS = '0.304800609601219';
const US_FT = 0.3048006096012192;
const DEG = 'ANGLEUNIT["degree",0.0174532925199433]';

const projcrs = (unitName: string, factor: string, id = ',ID["EPSG",2276]') =>
  `PROJCRS["NAD83 / Texas North Central (ftUS)",BASEGEOGCRS["NAD83",DATUM["North American Datum 1983",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,${DEG}]],CONVERSION["SPCS83 Texas North Central zone",METHOD["Lambert Conic Conformal (2SP)",ID["EPSG",9802]],PARAMETER["Latitude of false origin",31.6666666666667,${DEG}],PARAMETER["Easting at false origin",1968500,LENGTHUNIT["${unitName}",${factor}]]],CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["${unitName}",${factor}]],AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["${unitName}",${factor}]]${id}]`;

const TARGET = `TARGETCRS[GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,${DEG}],CS[ellipsoidal,2],AXIS["latitude",north,ORDER[1],${DEG}],AXIS["longitude",east,ORDER[2],${DEG}],ID["EPSG",4326]]]`;
const TRANSFORM = 'ABRIDGEDTRANSFORMATION["NAD83 to WGS 84 (1)",METHOD["Geocentric translations (geog2D domain)",ID["EPSG",9603]],PARAMETER["X-axis translation",0,LENGTHUNIT["metre",1],ID["EPSG",8605]],PARAMETER["Y-axis translation",0,LENGTHUNIT["metre",1],ID["EPSG",8606]],PARAMETER["Z-axis translation",0,LENGTHUNIT["metre",1],ID["EPSG",8607]]]';
const bound = (source: string) => `BOUNDCRS[SOURCECRS[${source}],${TARGET},${TRANSFORM}]`;

const VERT_FTUS = `VERTCRS["NAVD88 height (ftUS)",VDATUM["North American Vertical Datum 1988"],CS[vertical,1],AXIS["gravity-related height (H)",up,LENGTHUNIT["US survey foot",${FTUS}]],ID["EPSG",6360]]`;
const VERT_TARGET = 'TARGETCRS[VERTCRS["EGM2008 height",VDATUM["EGM2008 geoid"],CS[vertical,1],AXIS["gravity-related height (H)",up,LENGTHUNIT["metre",1]],ID["EPSG",3855]]]';
const VERT_TRANSFORM = 'ABRIDGEDTRANSFORMATION["NAVD88 to EGM2008",METHOD["Vertical Offset",ID["EPSG",9616]],PARAMETER["Vertical Offset",0,LENGTHUNIT["metre",1],ID["EPSG",8603]]]';

describe('BOUNDCRS horizontal unit comes from the source CRS', () => {
  it('reads US survey feet from a bound state-plane CRS', () => {
    const c = crsFromWkt(bound(projcrs('US survey foot', FTUS)));
    expect(c.linearUnit).toBe('us-survey-foot');
    expect(c.linearUnitToMetres).toBe(US_FT);
    expect(c.epsg).toBe(2276);
    expect(c.isGeographic).toBe(false);
    expect(toMetres(100, c)).toBeCloseTo(30.480061, 6);
    const r = resolvedFromCrsInfo(c, 'las-vlr')!;
    expect(r.linearUnitToMetres).toBe(US_FT);
  });

  it('reads US survey feet when the source CRS has no EPSG code', () => {
    const c = crsFromWkt(bound(projcrs('US survey foot', FTUS, '')));
    expect(c.epsg).toBeUndefined();
    expect(c.linearUnit).toBe('us-survey-foot');
    expect(c.linearUnitToMetres).toBe(US_FT);
  });

  it('reads international feet from a bound CRS', () => {
    const c = crsFromWkt(bound(projcrs('foot', '0.3048', '')));
    expect(c.linearUnit).toBe('foot');
    expect(c.linearUnitToMetres).toBe(0.3048);
  });

  it('takes the source datum, not the target one', () => {
    const c = crsFromWkt(bound(projcrs('US survey foot', FTUS)));
    expect(c.horizontalDatum).toBe('NAD83');
    expect(c.name).toContain('Texas North Central');
  });

  it('reads the source unit inside a compound CRS whose parts are bound', () => {
    const wkt = `COMPOUNDCRS["TX NC (ftUS) + NAVD88 (ftUS)",${bound(projcrs('US survey foot', FTUS))},BOUNDCRS[SOURCECRS[${VERT_FTUS}],${VERT_TARGET},${VERT_TRANSFORM}]]`;
    const c = crsFromWkt(wkt);
    expect(c.linearUnit).toBe('us-survey-foot');
    expect(c.linearUnitToMetres).toBe(US_FT);
    expect(c.epsg).toBe(2276);
    expect(c.verticalUnitToMetres).toBe(US_FT);
    expect(c.verticalLinearUnit).toBe('us-survey-foot');
  });

  it('reads the vertical unit from the source of a bound vertical CRS', () => {
    const wkt = `BOUNDCRS[SOURCECRS[${VERT_FTUS}],${VERT_TARGET},${VERT_TRANSFORM}]`;
    const c = crsFromWkt(wkt);
    expect(c.verticalUnitToMetres).toBe(US_FT);
  });

  it('does not read a unit when the bound CRS has no source CRS', () => {
    const c = crsFromWkt(`BOUNDCRS[${TARGET},${TRANSFORM}]`);
    expect(c.horizontalUnresolved).toBe(true);
    expect(c.epsg).toBeUndefined();
  });
});

describe('unbound CRSs keep their unit (regression guards)', () => {
  it('plain WKT2 PROJCRS in US survey feet', () => {
    const c = crsFromWkt(projcrs('US survey foot', FTUS));
    expect(c.linearUnit).toBe('us-survey-foot');
    expect(c.linearUnitToMetres).toBe(US_FT);
  });

  it('WKT1 PROJCS with TOWGS84 in US survey feet', () => {
    const wkt = `PROJCS["NAD83 / Texas North Central (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[0,0,0,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["false_easting",1968500],UNIT["US survey foot",${FTUS}],AUTHORITY["EPSG","2276"]]`;
    const c = crsFromWkt(wkt);
    expect(c.linearUnit).toBe('us-survey-foot');
    expect(c.linearUnitToMetres).toBe(US_FT);
    const compd = crsFromWkt(`COMPD_CS["TX NC + NAVD88",${wkt},VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["US survey foot",${FTUS}],AXIS["Up",UP]]]`);
    expect(compd.linearUnit).toBe('us-survey-foot');
    expect(compd.verticalUnitToMetres).toBe(US_FT);
  });

  it('WKT1 PROJCS in international feet', () => {
    const c = crsFromWkt('PROJCS["Custom ft",GEOGCS["NAD83",DATUM["NAD83",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["false_easting",0],UNIT["foot",0.3048]]');
    expect(c.linearUnit).toBe('foot');
    expect(c.linearUnitToMetres).toBe(0.3048);
  });
});
