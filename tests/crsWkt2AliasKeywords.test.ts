import { describe, it, expect } from 'vitest';
import { crsFromWkt } from '../src/io/crs';

const DEG = 'ANGLEUNIT["degree",0.0174532925199433]';
const PROJECTED =
  'PROJECTEDCRS["NAD83 / UTM zone 12N",BASEGEOGCRS["NAD83",DATUM["North American Datum 1983",' +
  `ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,${DEG}]],` +
  `CONVERSION["UTM zone 12N",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,${DEG}],` +
  `PARAMETER["Longitude of natural origin",-111,${DEG}],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],` +
  'PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],' +
  'CS[Cartesian,2],AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",26912]]';
const GEOGRAPHIC =
  'GEOGRAPHICCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],' +
  `PRIMEM["Greenwich",0,${DEG}],CS[ellipsoidal,2],AXIS["latitude",north,ORDER[1],${DEG}],AXIS["longitude",east,ORDER[2],${DEG}],ID["EPSG",4326]]`;

describe('WKT2-2019 alias keywords', () => {
  it('reads PROJECTEDCRS as a projected CRS with its name and code', () => {
    const crs = crsFromWkt(PROJECTED);
    expect(crs.isGeographic).toBe(false);
    expect(crs.horizontalUnresolved).not.toBe(true);
    expect(crs.name).toMatch(/UTM zone 12N/);
    expect(crs.epsg).toBe(26912);
  });

  it('reads GEOGRAPHICCRS as geographic', () => {
    const crs = crsFromWkt(GEOGRAPHIC);
    expect(crs.isGeographic).toBe(true);
    expect(crs.epsg).toBe(4326);
  });
});
