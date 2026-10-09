/**
 * Datum handling in the longitude/latitude export mapper.
 *
 * The mapper feeds the site KML, the scan-area KML, the RFC 7946 contour
 * GeoJSON and the accepted building-footprint GeoJSON. Every one of those
 * files states WGS 84 longitude/latitude, so the mapper must either produce
 * WGS 84 (or say how far from it the output may be) or refuse.
 *
 * Reference values come from PROJ 9.8 (`cs2cs`):
 *   EPSG:4267 -> 4326 at (-100, 40): 40.0000044924, -100.0004050132 (34.6 m)
 *   EPSG:26712 -> 4326 at (500000, 4428236.064): 40.0061672505, -111.0007207048
 *   EPSG:32612 -> 4326 at the same point: 40.0043142998, -111
 *   EPSG:26912 -> 4269 at the same point: 40.0043143009, -111
 */

import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  makeLocalToLonLat,
  resolveLocalToLonLat,
  LonLatConversionError,
} from '../src/export/lonLatMapper';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const base: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

const geographic = (epsg: number | undefined, name = `EPSG:${epsg}`): ResolvedCrs => ({
  ...base,
  kind: 'geographic',
  name,
  epsg,
  linearUnit: 'unknown',
});
const projected = (epsg: number, name = `EPSG:${epsg}`): ResolvedCrs => ({ ...base, name, epsg });

const UTM_PT: [number, number, number] = [500_000, 4_428_236.064, 0];

function hasCs2cs(): boolean {
  try {
    execFileSync('cs2cs', [], { stdio: 'ignore' });
    return true;
  } catch (e) {
    // cs2cs with no arguments prints usage and exits non-zero; only a missing
    // binary is ENOENT.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** PROJ's answer for one point, as [lon, lat]. */
function cs2cs(src: string, dst: string, a: number, b: number): [number, number] {
  const out = execFileSync('cs2cs', ['-f', '%.10f', src, dst], { input: `${a} ${b}\n` })
    .toString()
    .trim()
    .split(/\s+/)
    .map(Number);
  // EPSG geographic CRSs are latitude-first.
  return [out[1], out[0]];
}

describe('geographic CRSs: only WGS 84 passes unchanged', () => {
  it('passes EPSG:4326 and EPSG:4979 through unchanged, with no caveat', () => {
    for (const epsg of [4326, 4979]) {
      const r = resolveLocalToLonLat(geographic(epsg), [-100, 40, 0]);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.map([0, 0, 0])).toEqual([-100, 40, 0]);
      expect(r.datumCaveat).toBeNull();
    }
  });

  it('refuses NAD27 (EPSG:4267) instead of returning the unshifted point', () => {
    const r = resolveLocalToLonLat(geographic(4267, 'NAD27'), [-100, 40, 0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/NAD27/);
    expect(r.reason).toMatch(/datum transformation/);
    expect(r.reason).toMatch(/Reproject the scan to WGS 84 with PROJ, GDAL or PDAL/);
    expect(makeLocalToLonLat(geographic(4267), [-100, 40, 0])).toBeNull();
  });

  it('allows ETRS89, GDA94, GDA2020 and NZGD2000 geographic with the plate-motion note', () => {
    const expected: Array<[number, RegExp, RegExp]> = [
      [4258, /ETRS89/, /about 1 m/],
      [4283, /GDA94/, /about 2 m/],
      [7844, /GDA2020/, /about 0\.4 m/],
      [4167, /NZGD2000/, /about 1 m/],
    ];
    for (const [epsg, family, size] of expected) {
      const r = resolveLocalToLonLat(geographic(epsg), [140, -37, 0]);
      expect(r.ok, `EPSG:${epsg}`).toBe(true);
      if (!r.ok) continue;
      expect(r.map([0, 0, 0])).toEqual([140, -37, 0]);
      expect(r.datumCaveat).toMatch(family);
      expect(r.datumCaveat).toMatch(size);
      expect(r.datumCaveat).toMatch(/no .* to WGS 84 transformation was applied/);
    }
  });

  it('refuses CGCS2000 and unknown geographic datums', () => {
    for (const epsg of [4490, 4322]) {
      const r = resolveLocalToLonLat(geographic(epsg), [10, 45, 0]);
      expect(r.ok, `EPSG:${epsg}`).toBe(false);
    }
  });

  it('refuses a geographic CRS with no EPSG code, whose datum cannot be confirmed', () => {
    const r = resolveLocalToLonLat(geographic(undefined, 'GCS from WKT'), [-100, 40, 0]);
    expect(r.ok).toBe(false);
  });

  it('allows NAD83 (4269) and NAD83(2011) (6318) with the approximate-datum caveat', () => {
    for (const epsg of [4269, 6318]) {
      const r = resolveLocalToLonLat(geographic(epsg), [-100, 40, 0]);
      expect(r.ok, `EPSG:${epsg}`).toBe(true);
      if (!r.ok) continue;
      expect(r.map([0, 0, 0])).toEqual([-100, 40, 0]);
      expect(r.datumCaveat).toMatch(/NAD83/);
      expect(r.datumCaveat).toMatch(/1 to 2 m/);
      expect(r.map.datumCaveat).toBe(r.datumCaveat);
    }
  });
});

describe('geographic CRSs: range and finiteness', () => {
  const map = makeLocalToLonLat(geographic(4326), [0, 0, 0])!;

  it('refuses latitude beyond +-90', () => {
    expect(() => map([0, 100, 0])).toThrow(LonLatConversionError);
    expect(() => map([0, -95, 0])).toThrow(LonLatConversionError);
  });

  it('refuses NaN and Infinity', () => {
    expect(() => map([Number.NaN, 0, 0])).toThrow(LonLatConversionError);
    expect(() => map([0, Number.POSITIVE_INFINITY, 0])).toThrow(LonLatConversionError);
    expect(() => map([Number.NEGATIVE_INFINITY, 0, 0])).toThrow(LonLatConversionError);
  });

  it('refuses longitude outside [-180, 180] rather than wrapping it', () => {
    expect(() => map([400, 0, 0])).toThrow(/longitude/i);
    expect(() => map([-180.5, 0, 0])).toThrow(LonLatConversionError);
    expect(map([180, 90, 0])).toEqual([180, 90, 0]);
    expect(map([-180, -90, 0])).toEqual([-180, -90, 0]);
  });

  it('refuses an origin outside the geographic domain at the gate', () => {
    expect(resolveLocalToLonLat(geographic(4326), [-100, 100, 0]).ok).toBe(false);
    expect(resolveLocalToLonLat(geographic(4326), [400, 40, 0]).ok).toBe(false);
  });
});

describe('projected CRSs: datum gate', () => {
  it('refuses NAD27 / UTM 12N (EPSG:26712) instead of the 61.7 m unshifted value', () => {
    const r = resolveLocalToLonLat(projected(26712, 'NAD27 / UTM zone 12N'), UTM_PT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/NAD27/);
    // The advice must not lead back to OLV's own grid-less reprojection.
    expect(r.reason).toMatch(/PROJ, GDAL or PDAL/);
    expect(r.reason).toMatch(/NADCON or NTv2/);
    expect(r.reason).toMatch(/Reproject in OLV applies no NAD27 shift/);
  });

  it('carries the family note for every null-shift projected grid', () => {
    const cases: Array<[number, [number, number], RegExp]> = [
      [25832, [500_000, 5_540_000], /ETRS89/],
      [3035, [4_321_000, 3_210_000], /ETRS89/],
      [28355, [320_000, 5_900_000], /GDA94/],
      [3577, [1_100_000, -4_200_000], /GDA94/],
      [7855, [320_000, 5_900_000], /GDA2020/],
      [2193, [1_750_000, 5_430_000], /NZGD2000/],
      [2154, [652_000, 6_862_000], /RGF93/],
    ];
    for (const [epsg, [e, n], family] of cases) {
      const r = resolveLocalToLonLat(projected(epsg), [e, n, 0]);
      expect(r.ok, `EPSG:${epsg}`).toBe(true);
      if (!r.ok) continue;
      expect(r.datumCaveat, `EPSG:${epsg}`).toMatch(family);
      expect(r.map.datumCaveat).toBe(r.datumCaveat);
    }
  });

  it('allows NAD83 / UTM 12N (EPSG:26912) and carries the datum caveat', () => {
    const r = resolveLocalToLonLat(projected(26912, 'NAD83 / UTM zone 12N'), UTM_PT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [lon, lat] = r.map([0, 0, 0]);
    expect(lon).toBeCloseTo(-111, 9);
    expect(lat).toBeCloseTo(40.0043143, 6);
    expect(r.datumCaveat).toMatch(/NAD83/);
    expect(r.map.datumCaveat).toBe(r.datumCaveat);
  });

  it('carries the caveat for NAD83(2011) / UTM through the proj4 path', () => {
    const r = resolveLocalToLonLat(projected(6339), [500_000, 4_400_000, 0]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datumCaveat).toMatch(/NAD83/);
  });

  it('leaves WGS 84 / UTM (EPSG:32612) unchanged and uncaveated', () => {
    const r = resolveLocalToLonLat(projected(32612), UTM_PT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datumCaveat).toBeNull();
    const [lon, lat] = r.map([0, 0, 0]);
    expect(lon).toBeCloseTo(-111, 9);
    expect(lat).toBeCloseTo(40.0043142996, 9);
  });

  it('keeps Web Mercator (NODATUM in proj4, WGS 84 in EPSG) allowed', () => {
    const r = resolveLocalToLonLat(projected(3857), [-12_356_463, 4_865_942, 0]);
    expect(r.ok).toBe(true);
  });

  it('does not decode a NAD83 State Plane code (EPSG:26929, Alabama East) as UTM zone 29', () => {
    // 26929 is a Transverse Mercator State Plane zone, not UTM. It has no proj4
    // definition here, so the honest answer is a decline.
    const r = resolveLocalToLonLat(projected(26929, 'NAD83 / Alabama East'), [200_000, 300_000, 0]);
    expect(r.ok).toBe(false);
  });
});

/**
 * Frozen PROJ answers for the projection leg of every case the mapper allows:
 * source CRS to its OWN geographic CRS, so the comparison isolates the
 * projection maths (the datum leg is what the caveat describes). Produced with
 *
 *   python3 -c "from pyproj import Transformer; t = Transformer.from_crs(
 *     'EPSG:<src>', 'EPSG:<dst>', always_xy=True); print(t.transform(<e>, <n>))"
 *
 * using pyproj 3.7.2 (PROJ 9.5.1), and confirmed with cs2cs from PROJ 9.8.1.
 * Columns: source, its geographic CRS, easting, northing, lon, lat, and whether
 * the source CRS is northing-first in the EPSG registry (for cs2cs).
 */
const FROZEN: ReadonlyArray<readonly [number, number, number, number, number, number, boolean]> = [
  [32612, 4326, 500000, 4428236.064, -111.0, 40.0043142998, false],
  [26912, 4269, 500000, 4428236.064, -111.0, 40.0043143009, false],
  [6339, 6318, 500000, 4400000, -123.0, 39.7499075201, false],
  [5070, 4269, -500000, 1800000, -101.8380096044, 39.0867872028, false],
  [25832, 4258, 500000, 5540000, 9.0, 50.0123155197, false],
  [3035, 4258, 4321000, 3210000, 10.0, 52.0, true],
  [28355, 4283, 320000, 5900000, 144.9763329086, -37.0289620226, false],
  [3577, 4283, 1100000, -4200000, 144.4497183676, -37.9265316785, false],
  [7855, 7844, 320000, 5900000, 144.9763329086, -37.0289620226, false],
  [2193, 4167, 1750000, 5430000, 174.7907800304, -41.2675073066, true],
  [2154, 4171, 652000, 6862000, 2.3458119587, 48.856248141, false],
  [3857, 4326, -12356463, 4865942, -110.9999957056, 39.9999980766, false],
];

describe('frozen PROJ values for every allowed projected case', () => {
  for (const [src, , e, n, lon, lat] of FROZEN) {
    it(`EPSG:${src} at (${e}, ${n}) matches PROJ to 1e-8 degrees`, () => {
      const map = makeLocalToLonLat(projected(src), [e, n, 0]);
      expect(map).not.toBeNull();
      const [x, y] = map!([0, 0, 0]);
      expect(Math.abs(x - lon)).toBeLessThan(1e-8);
      expect(Math.abs(y - lat)).toBeLessThan(1e-8);
    });
  }
});

describe.skipIf(!hasCs2cs())('live cross-check against PROJ cs2cs', () => {
  for (const [src, dst, e, n, , , northingFirst] of FROZEN) {
    it(`EPSG:${src} matches cs2cs EPSG:${src} EPSG:${dst} to 1e-8 degrees`, () => {
      const [x, y] = makeLocalToLonLat(projected(src), [e, n, 0])!([0, 0, 0]);
      const [plon, plat] = northingFirst
        ? cs2cs(`EPSG:${src}`, `EPSG:${dst}`, n, e)
        : cs2cs(`EPSG:${src}`, `EPSG:${dst}`, e, n);
      expect(Math.abs(x - plon)).toBeLessThan(1e-8);
      expect(Math.abs(y - plat)).toBeLessThan(1e-8);
    });
  }

  it('EPSG:4326 matches PROJ identity', () => {
    const [lon, lat] = makeLocalToLonLat(geographic(4326), [-100, 40, 0])!([0, 0, 0]);
    const [plon, plat] = cs2cs('EPSG:4326', 'EPSG:4326', 40, -100);
    expect(lon).toBeCloseTo(plon, 10);
    expect(lat).toBeCloseTo(plat, 10);
  });
});
