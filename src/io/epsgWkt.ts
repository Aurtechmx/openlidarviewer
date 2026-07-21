/**
 * epsgWkt.ts — OGC WKT for the EPSG codes whose parameters we can derive.
 *
 * LAS 1.4 requires the CRS as WKT for point data record formats 6-10, with
 * global-encoding bit 4 set. The writer does that whenever it is given a WKT,
 * but the only source of one used to be the input file, so a scan carrying a
 * GeoTIFF GeoKey VLR (what LAS 1.2 uses, and what PDAL commonly emits) came
 * back out as a 1.4 file with GeoKeys and bit 4 clear. The codes in it were
 * right; the encoding was not the one the format mandates.
 *
 * The writer deliberately refuses to invent "a parameterless WKT downstream
 * tools could not use", and that refusal is correct. This is not that. A WGS
 * 84 UTM zone is fully determined by its zone number: the central meridian is
 * 6n - 183, the scale factor is 0.9996, the false easting is 500 km, and the
 * false northing is 0 north of the equator and 10 000 km south of it. Writing
 * those is arithmetic, not fabrication.
 *
 * The line is drawn at what is derivable. ETRS89 or NAD83 UTM zones share the
 * projection but not the datum, and a datum is not something to guess at when
 * the difference is metres on the ground, so they return null and fall back to
 * GeoKeys. Same for national grids and vertical-only codes.
 */

/** WGS 84 UTM: 326zz northern, 327zz southern, zz = 01..60. */
const UTM_NORTH_BASE = 32600;
const UTM_SOUTH_BASE = 32700;
const UTM_ZONE_MIN = 1;
const UTM_ZONE_MAX = 60;

/** The WGS 84 geographic CRS, used standalone and as every UTM zone's base. */
const WGS84_GEOGCS =
  'GEOGCS["WGS 84",'
  + 'DATUM["WGS_1984",'
  + 'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],'
  + 'AUTHORITY["EPSG","6326"]],'
  + 'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
  + 'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
  + 'AUTHORITY["EPSG","4326"]]';

/**
 * Central meridian of UTM zone `n`, in degrees. Zone 1 is centred on -177 and
 * each zone steps 6 degrees east, so zone 29 is -9 and zone 60 is 177.
 */
function centralMeridian(zone: number): number {
  return 6 * zone - 183;
}

function utmWkt(zone: number, south: boolean): string {
  const code = (south ? UTM_SOUTH_BASE : UTM_NORTH_BASE) + zone;
  const name = `WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'}`;
  return (
    `PROJCS["${name}",`
    + `${WGS84_GEOGCS},`
    + 'PROJECTION["Transverse_Mercator"],'
    + 'PARAMETER["latitude_of_origin",0],'
    + `PARAMETER["central_meridian",${centralMeridian(zone)}],`
    + 'PARAMETER["scale_factor",0.9996],'
    + 'PARAMETER["false_easting",500000],'
    + `PARAMETER["false_northing",${south ? 10000000 : 0}],`
    + 'UNIT["metre",1,AUTHORITY["EPSG","9001"]],'
    + 'AXIS["Easting",EAST],'
    + 'AXIS["Northing",NORTH],'
    + `AUTHORITY["EPSG","${code}"]]`
  );
}

/**
 * OGC WKT for `code`, or null when we cannot derive it exactly.
 *
 * Null is the honest answer, not a failure: the caller falls back to a GeoKey
 * tag, which records the code faithfully even though strict LAS 1.4 readers
 * prefer WKT for the extended point formats.
 */
export function wktForEpsg(code: number | null | undefined): string | null {
  if (code == null || !Number.isInteger(code)) return null;

  if (code === 4326) return WGS84_GEOGCS;

  for (const [base, south] of [[UTM_NORTH_BASE, false], [UTM_SOUTH_BASE, true]] as const) {
    const zone = code - base;
    if (zone >= UTM_ZONE_MIN && zone <= UTM_ZONE_MAX) return utmWkt(zone, south);
  }

  return null;
}
