/**
 * epsgWkt.test.ts — WKT synthesised from EPSG codes we can derive exactly.
 *
 * A LAS 1.4 file using point formats 6-10 must describe its CRS as OGC WKT
 * with global-encoding bit 4 set. The writer honours that whenever a WKT is
 * handed to it, but the only WKT ever supplied came from the source file, so
 * a scan georeferenced by a GeoTIFF GeoKey VLR — the common case for LAS 1.2
 * and for anything PDAL wrote — produced a 1.4 file carrying GeoKeys and a
 * clear bit 4. Correct codes, non-conformant encoding.
 *
 * Deriving the WKT is not the "parameterless WKT" the writer refuses to
 * fabricate: a WGS 84 UTM zone is fully determined by its zone number, so the
 * parameters are a computation, not a guess. Anything we cannot derive still
 * falls back to GeoKeys.
 */

import { describe, it, expect } from 'vitest';
import { wktForEpsg } from '../src/io/epsgWkt';

describe('wktForEpsg', () => {
  it('derives WGS 84 / UTM zone 29N with the right central meridian', () => {
    const wkt = wktForEpsg(32629);
    expect(wkt).not.toBeNull();
    expect(wkt).toContain('PROJCS["WGS 84 / UTM zone 29N"');
    // Zone n has central meridian 6n - 183. Zone 29 -> -9.
    expect(wkt).toContain('PARAMETER["central_meridian",-9]');
    expect(wkt).toContain('PARAMETER["scale_factor",0.9996]');
    expect(wkt).toContain('PARAMETER["false_easting",500000]');
    expect(wkt).toContain('PARAMETER["false_northing",0]');
    expect(wkt).toContain('AUTHORITY["EPSG","32629"]');
    expect(wkt).toContain('UNIT["metre",1');
  });

  it('gives southern-hemisphere zones the 10 000 km false northing', () => {
    const wkt = wktForEpsg(32729)!;
    expect(wkt).toContain('PROJCS["WGS 84 / UTM zone 29S"');
    expect(wkt).toContain('PARAMETER["false_northing",10000000]');
    expect(wkt).toContain('AUTHORITY["EPSG","32729"]');
  });

  it('spans the zone range at both ends', () => {
    expect(wktForEpsg(32601)).toContain('central_meridian",-177]');
    expect(wktForEpsg(32660)).toContain('central_meridian",177]');
  });

  it('derives geographic WGS 84', () => {
    const wkt = wktForEpsg(4326)!;
    expect(wkt).toContain('GEOGCS["WGS 84"');
    expect(wkt).toContain('AUTHORITY["EPSG","4326"]');
    expect(wkt).not.toContain('PROJCS');
  });

  it('refuses codes it cannot derive rather than inventing them', () => {
    // Zone 0 and 61 do not exist; 25829 (ETRS89 UTM 29N) is a different datum
    // we have no parameters for; 5703 is vertical-only.
    for (const code of [32600, 32661, 32700, 32761, 25829, 5703, 27700, 0, -1, 1.5, NaN]) {
      expect(wktForEpsg(code)).toBeNull();
    }
  });

  it('emits ASCII only, since the VLR payload is written as 7-bit', () => {
    for (const code of [32629, 32729, 4326]) {
      // eslint-disable-next-line no-control-regex
      expect(wktForEpsg(code)!).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
