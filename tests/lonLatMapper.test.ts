/**
 * The KML export's local → lon/lat mapper.
 *
 * Two behaviours here previously had no unit cover because the mapper lived
 * inline in `main.ts`: declining a CRS the converter cannot handle, and
 * REFUSING a point it cannot convert. The refusal is the load-bearing one —
 * this mapper used to fall back to raw easting/northing, which wrote easting
 * 500000 into a KML `<coordinates>` element as longitude 500000, and the
 * grid-range gate made that branch reachable.
 */

import { describe, it, expect } from 'vitest';
import { makeLocalToLonLat, LonLatConversionError } from '../src/export/lonLatMapper';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const utm12: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

const geographic: ResolvedCrs = {
  ...utm12,
  kind: 'geographic',
  name: 'WGS 84',
  epsg: 4326,
  linearUnit: 'unknown',
};

describe('makeLocalToLonLat', () => {
  it('declines with no CRS at all', () => {
    expect(makeLocalToLonLat(null, [0, 0, 0])).toBeNull();
  });

  it('declines an unknown/local frame rather than inventing degrees', () => {
    expect(makeLocalToLonLat({ ...utm12, kind: 'unknown' } as ResolvedCrs, [0, 0, 0])).toBeNull();
  });

  it('declines a projected CRS the converter does not handle', () => {
    // A state-plane code is projected but not UTM; the probe fails and the
    // export button stays honestly disabled instead of approximating.
    expect(
      makeLocalToLonLat({ ...utm12, epsg: 2231, name: 'NAD83 / Colorado Central' }, [500000, 4400000, 0]),
    ).toBeNull();
  });

  it('passes a geographic frame through with the origin restored', () => {
    const map = makeLocalToLonLat(geographic, [-111, 40, 1500]);
    expect(map).not.toBeNull();
    expect(map!([0.5, 0.25, 10])).toEqual([-110.5, 40.25, 1510]);
  });

  it('converts a UTM point to real degrees', () => {
    const map = makeLocalToLonLat(utm12, [500_000, 4_400_000, 0]);
    const [lon, lat] = map!([0, 0, 0]);
    // Easting 500000 is the central meridian of zone 12 (111°W).
    expect(lon).toBeCloseTo(-111, 5);
    expect(lat).toBeGreaterThan(39);
    expect(lat).toBeLessThan(41);
  });

  it('REFUSES a point that leaves the grid instead of emitting raw metres', () => {
    // The probe proves only the ORIGIN converts; this point's absolute easting
    // is 950000, outside the grid, so conversion fails — and the mapper must
    // throw, not return [950000, …] as if that were a longitude.
    const map = makeLocalToLonLat(utm12, [500_000, 4_400_000, 0]);
    expect(() => map!([450_000, 0, 0])).toThrow(LonLatConversionError);
  });

  it('carries the converter reason in the refusal', () => {
    const map = makeLocalToLonLat(utm12, [500_000, 4_400_000, 0]);
    expect(() => map!([450_000, 0, 0])).toThrow(/easting/i);
  });
});
