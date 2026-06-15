/**
 * epsg.ts — resolve EPSG codes to proj4 definition strings.
 *
 * proj4 ships only WGS84 (4326) and Web Mercator (3857) built in, so we derive
 * the common parametric families (UTM in several datums) on demand and keep a
 * curated table of widely-used national/regional grids. This covers the great
 * majority of LiDAR/survey CRS without bundling the full EPSG registry or
 * making any network call. Anything unresolved returns null, and the converter
 * degrades gracefully (it warns and leaves coordinates unchanged) rather than
 * producing wrong data.
 *
 * Pure data — no DOM, no proj4 import (keeps this leaf trivially testable).
 */

/** Curated non-parametric definitions for common named CRS. */
const STATIC_DEFS: Record<number, string> = {
  // Geographic (lon/lat)
  4326: '+proj=longlat +datum=WGS84 +no_defs',
  4269: '+proj=longlat +datum=NAD83 +no_defs',
  4267: '+proj=longlat +datum=NAD27 +no_defs',
  4258: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0 +no_defs', // ETRS89
  4283: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0 +no_defs', // GDA94
  7844: '+proj=longlat +ellps=GRS80 +no_defs', // GDA2020
  4167: '+proj=longlat +ellps=GRS80 +no_defs', // NZGD2000
  4490: '+proj=longlat +ellps=GRS80 +no_defs', // CGCS2000
  4978: '+proj=geocent +datum=WGS84 +units=m +no_defs', // ECEF
  // World projected
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
  3395: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  // National / regional grids
  27700:
    '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs', // British National Grid
  2154:
    '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs', // RGF93 / Lambert-93 (France)
  2193:
    '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs', // NZGD2000 / NZTM
  3035:
    '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs', // ETRS89-LAEA Europe
  3577:
    '+proj=aea +lat_1=-18 +lat_2=-36 +lat_0=0 +lon_0=132 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs', // GDA94 / Australian Albers
  5070:
    '+proj=aea +lat_1=29.5 +lat_2=45.5 +lat_0=23 +lon_0=-96 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs', // NAD83 / CONUS Albers
};

/** EPSG codes that are geographic (lon/lat) rather than projected. */
export function isGeographicEpsg(epsg: number): boolean {
  if (epsg === 4978) return false; // geocentric (metres), not lat/lon
  if (epsg === 7844 || epsg === 6668) return true; // GDA2020 / JGD2011 geographic
  return epsg >= 4001 && epsg <= 4999; // classic geographic 2D block
}

/**
 * Build a UTM proj4 string. With an explicit `datum` (WGS84/NAD83/NAD27) it is
 * used directly; otherwise the GRS80 ellipsoid with a null Helmert is applied
 * — the right reference for the ETRS89 / GDA families.
 */
function utm(zone: number, opts: { south?: boolean; datum?: string }): string {
  const south = opts.south ? ' +south' : '';
  const ref = opts.datum ? `+datum=${opts.datum}` : '+ellps=GRS80 +towgs84=0,0,0';
  return `+proj=utm +zone=${zone}${south} ${ref} +units=m +no_defs`;
}

/**
 * Resolve an EPSG code to a proj4 definition string, or null when it isn't one
 * we can derive without an external registry.
 *
 *   326zz → WGS84 / UTM zz N        327zz → WGS84 / UTM zz S
 *   269zz → NAD83 / UTM zz N        267zz → NAD27 / UTM zz N
 *   258zz → ETRS89 / UTM zz N (258 = 25800)
 *   283zz → GDA94 / MGA zz S        78zz  → GDA2020 / MGA zz S (7846–7859)
 */
export function epsgToProj4(epsg: number): string | null {
  if (!Number.isInteger(epsg)) return null;
  if (epsg in STATIC_DEFS) return STATIC_DEFS[epsg];

  // WGS84 UTM north / south.
  if (epsg >= 32601 && epsg <= 32660) return utm(epsg - 32600, { datum: 'WGS84' });
  if (epsg >= 32701 && epsg <= 32760) return utm(epsg - 32700, { datum: 'WGS84', south: true });
  // NAD83 / UTM (zones 1–23 N).
  if (epsg >= 26901 && epsg <= 26923) return utm(epsg - 26900, { datum: 'NAD83' });
  // NAD27 / UTM (zones 1–22 N).
  if (epsg >= 26701 && epsg <= 26722) return utm(epsg - 26700, { datum: 'NAD27' });
  // ETRS89 / UTM (zones 28–38 N).
  if (epsg >= 25828 && epsg <= 25838) return utm(epsg - 25800, {});
  // GDA94 / MGA (zones 48–58 S).
  if (epsg >= 28348 && epsg <= 28358) return utm(epsg - 28300, { south: true });
  // GDA2020 / MGA (zones 46–59 S).
  if (epsg >= 7846 && epsg <= 7859) return utm(epsg - 7800, { south: true });

  return null;
}

/**
 * The geodetic datum family behind an EPSG code we can resolve. Used ONLY for
 * transform honesty (below) — never for the projection math itself.
 */
export type DatumFamily =
  | 'WGS84'
  | 'NAD83'
  | 'NAD27'
  | 'ETRS89'
  | 'GDA94'
  | 'GDA2020'
  | 'NZGD2000'
  | 'CGCS2000'
  | 'OSGB36'
  | 'RGF93';

/** Map a resolvable EPSG code to its datum family, or null when unknown. */
export function epsgDatumFamily(epsg: number): DatumFamily | null {
  if (!Number.isInteger(epsg)) return null;
  // Geographic + world codes.
  if (epsg === 4326 || epsg === 3857 || epsg === 3395 || epsg === 4978) return 'WGS84';
  if (epsg === 4269 || epsg === 5070) return 'NAD83';
  if (epsg === 4267) return 'NAD27';
  if (epsg === 4258 || epsg === 3035) return 'ETRS89';
  if (epsg === 4283 || epsg === 3577) return 'GDA94';
  if (epsg === 7844) return 'GDA2020';
  if (epsg === 4167 || epsg === 2193) return 'NZGD2000';
  if (epsg === 4490) return 'CGCS2000';
  if (epsg === 27700) return 'OSGB36';
  if (epsg === 2154) return 'RGF93';
  // Parametric UTM / MGA families (mirror epsgToProj4's ranges exactly).
  if (epsg >= 32601 && epsg <= 32660) return 'WGS84';
  if (epsg >= 32701 && epsg <= 32760) return 'WGS84';
  if (epsg >= 26901 && epsg <= 26923) return 'NAD83';
  if (epsg >= 26701 && epsg <= 26722) return 'NAD27';
  if (epsg >= 25828 && epsg <= 25838) return 'ETRS89';
  if (epsg >= 28348 && epsg <= 28358) return 'GDA94';
  if (epsg >= 7846 && epsg <= 7859) return 'GDA2020';
  return null;
}

/**
 * Honesty check for a cross-datum transform our proj4 definitions cannot model
 * faithfully. Returns a human-readable caveat when the requested src→dst pair
 * resolves and proj4 will happily "succeed", but the DATUM leg of the
 * transform is known to be missing or degenerate:
 *
 *   - NAD27 ↔ anything else: proj4js bundles no NADCON/NTv2 distortion grids,
 *     so the NAD27 leg degrades to a coarse parametric shift — horizontal
 *     errors of 10 m+ are normal (worse in Alaska / at datum edges).
 *   - GDA94 ↔ GDA2020: both are defined here as null shifts to WGS84, so the
 *     "transform" applies an IDENTITY datum shift while the true plate-motion
 *     difference is ≈ 1.8 m and growing.
 *
 * Transforms WITHIN one family (e.g. NAD27 UTM zone → NAD27 geographic) are a
 * pure projection change — no datum leg, no caveat. Conventionally-coincident
 * pairs (WGS84↔ETRS89/NZGD2000/CGCS2000/GDA2020, sub-metre by definition at
 * their reference epochs) stay quiet so the warning keeps its signal.
 */
/**
 * The datum families our proj4 definitions realise as an IDENTITY shift to
 * WGS84 and that geodetic convention treats as coincident at their reference
 * epochs (sub-metre). A transform among these is intentionally quiet so the
 * caveat keeps its signal. NAD83 is deliberately NOT in this set: it is also
 * modelled as identity-to-WGS84 here, but it differs from this cluster by
 * ≈ 1–2 m, so it earns its own caveat below.
 */
const WGS84_COINCIDENT: ReadonlySet<DatumFamily> = new Set([
  'WGS84',
  'ETRS89',
  'NZGD2000',
  'CGCS2000',
  'GDA2020',
]);

export function datumShiftCaveat(srcEpsg: number, dstEpsg: number): string | null {
  const a = epsgDatumFamily(srcEpsg);
  const b = epsgDatumFamily(dstEpsg);
  if (a == null || b == null || a === b) return null;
  if (a === 'NAD27' || b === 'NAD27') {
    return (
      'NAD27 datum grids (NADCON/NTv2) are not bundled — the NAD27 leg of this ' +
      'transform uses a coarse parametric shift; horizontal errors of 10 m or more are expected'
    );
  }
  if ((a === 'GDA94' && b === 'GDA2020') || (a === 'GDA2020' && b === 'GDA94')) {
    return (
      'GDA94 and GDA2020 are both defined as identity shifts to WGS84 here, so no real ' +
      'datum shift was applied — the true GDA94→GDA2020 difference is ≈ 1.8 m (plate motion)'
    );
  }
  // NAD83 is realised here as an identity shift to WGS84, but it is offset from
  // the WGS84-coincident cluster (modern WGS84 / ETRS89 / GDA2020) by ≈ 1–2 m
  // in CONUS, and no NADCON/NTv2 grid is applied. Flag the identity so a
  // NAD83 ↔ WGS84/ETRS89 transform is not read as exact.
  if (
    (a === 'NAD83' && WGS84_COINCIDENT.has(b)) ||
    (b === 'NAD83' && WGS84_COINCIDENT.has(a))
  ) {
    return (
      'NAD83 is applied here as an identity shift to the WGS84 datum family, but the two ' +
      'differ by ≈ 1–2 m — no NAD83 datum grid was applied'
    );
  }
  return null;
}

/** A human label for an EPSG code (best-effort, for logs/UI). */
export function epsgLabel(epsg: number): string {
  const NAMED: Record<number, string> = {
    4326: 'WGS 84 (geographic)',
    4269: 'NAD83 (geographic)',
    3857: 'WGS 84 / Web Mercator',
    3395: 'WGS 84 / World Mercator',
    27700: 'OSGB36 / British National Grid',
    2154: 'RGF93 / Lambert-93',
    2193: 'NZGD2000 / NZTM',
    3035: 'ETRS89 / LAEA Europe',
    3577: 'GDA94 / Australian Albers',
    5070: 'NAD83 / CONUS Albers',
  };
  if (epsg in NAMED) return NAMED[epsg];
  if (epsg >= 32601 && epsg <= 32660) return `WGS 84 / UTM zone ${epsg - 32600}N`;
  if (epsg >= 32701 && epsg <= 32760) return `WGS 84 / UTM zone ${epsg - 32700}S`;
  if (epsg >= 26901 && epsg <= 26923) return `NAD83 / UTM zone ${epsg - 26900}N`;
  if (epsg >= 25828 && epsg <= 25838) return `ETRS89 / UTM zone ${epsg - 25800}N`;
  if (epsg >= 28348 && epsg <= 28358) return `GDA94 / MGA zone ${epsg - 28300}`;
  if (epsg >= 7846 && epsg <= 7859) return `GDA2020 / MGA zone ${epsg - 7800}`;
  return `EPSG:${epsg}`;
}
