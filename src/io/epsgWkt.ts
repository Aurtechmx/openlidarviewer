/**
 * epsgWkt.ts — OGC WKT for the EPSG codes OLV can describe exactly.
 *
 * LAS 1.4 requires the CRS as WKT for point data record formats 6-10, with
 * global-encoding bit 4 set. A scan georeferenced by GeoTIFF keys alone (what
 * LAS 1.2 uses, and what many tools emit) has no WKT of its own, so one has to
 * be written for it, and it has to be the right one.
 *
 * Every string this module returns is either stored verbatim from PROJ
 * (`projinfo EPSG:<code> -o WKT1_GDAL`, see epsgWktTable.ts) or assembled from
 * a stored base geographic CRS by the UTM template, which the table generator
 * checked against projinfo for every zone it covers. Codes outside those sets
 * return null: a datum is not something to guess at when the difference is
 * metres on the ground, and the LAS 1.4 writer then refuses rather than write
 * a GeoKey-only file that strict readers report as having no CRS.
 */

import { STATIC_WKT, UTM_FAMILIES, VERT_CS_WKT } from './epsgWktTable';

function utmWkt(code: number): string | null {
  for (const f of UTM_FAMILIES) {
    if (code < f.first || code > f.last) continue;
    const zone = code - f.zoneBase;
    const base = STATIC_WKT[f.base];
    return (
      `PROJCS["${f.name.replace('{z}', String(zone))}",${base},`
      + 'PROJECTION["Transverse_Mercator"],'
      + 'PARAMETER["latitude_of_origin",0],'
      // Zone 1 is centred on -177 and each zone steps 6 degrees east.
      + `PARAMETER["central_meridian",${6 * zone - 183}],`
      + 'PARAMETER["scale_factor",0.9996],'
      + 'PARAMETER["false_easting",500000],'
      + `PARAMETER["false_northing",${f.south ? 10000000 : 0}],`
      + 'UNIT["metre",1,AUTHORITY["EPSG","9001"]],'
      + 'AXIS["Easting",EAST],'
      + 'AXIS["Northing",NORTH],'
      + `AUTHORITY["EPSG","${code}"]]`
    );
  }
  return null;
}

/**
 * OGC WKT1 for a horizontal (or geocentric) EPSG `code`, or null when this
 * build holds no verified definition for it.
 */
export function wktForEpsg(code: number | null | undefined): string | null {
  if (code == null || !Number.isInteger(code)) return null;
  return STATIC_WKT[code] ?? utmWkt(code);
}

/** The name in a WKT1 node's first quoted string. */
function wktName(wkt: string): string | null {
  const m = /^[A-Z_]+\["([^"]*)"/.exec(wkt);
  return m ? m[1] : null;
}

/**
 * A WKT1 compound CRS of a horizontal WKT1 (`PROJCS` or `GEOGCS`) and the
 * stored VERT_CS for `verticalEpsg`, in the form PROJ writes for
 * `EPSG:<h>+<v>`. Null when either half is missing or not WKT1.
 */
export function compoundWkt(horizontal: string, verticalEpsg: number | null | undefined): string | null {
  if (verticalEpsg == null) return null;
  const vert = VERT_CS_WKT[verticalEpsg];
  if (vert == null) return null;
  if (!/^(PROJCS|GEOGCS)\[/.test(horizontal)) return null;
  const h = wktName(horizontal);
  const v = wktName(vert);
  if (h == null || v == null) return null;
  return `COMPD_CS["${h} + ${v}",${horizontal},${vert}]`;
}

/** WKT1 and WKT2 root keywords a coordinate-system WKT can start with. */
const WKT_ROOT =
  /^(PROJCS|GEOGCS|GEOCCS|COMPD_CS|LOCAL_CS|PROJCRS|PROJECTEDCRS|GEOGCRS|GEOGRAPHICCRS|GEODCRS|GEODETICCRS|COMPOUNDCRS|BOUNDCRS|ENGCRS|ENGINEERINGCRS)\s*[[(]/i;

/**
 * True when `text` has the shape of a coordinate-system WKT: a CRS root
 * keyword and balanced brackets outside quoted names. A VERT_CS alone is not
 * accepted because it cannot stand for a point cloud's horizontal frame.
 * This is a shape check, not a parse; it keeps a truncated or empty record
 * from being copied into an output file as if it were a definition.
 */
export function isUsableWkt(text: string | null | undefined): text is string {
  if (text == null) return false;
  const s = text.trim();
  if (!WKT_ROOT.test(s)) return false;
  let depth = 0;
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '[' || ch === '(')) depth++;
    else if (!quoted && (ch === ']' || ch === ')')) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quoted && /[\])]$/.test(s);
}
