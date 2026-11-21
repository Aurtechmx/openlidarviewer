/**
 * sheetTrueNorth.test.ts: the angle the map sheet's true-north arrow is drawn at.
 */
import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { epsgToProj4 } from '../src/convert/epsg';
import { trueNorthFromGridDeg } from '../src/export/sheetKit/trueNorth';

/** Grid coordinates of a lon/lat in an EPSG CRS. */
function at(epsg: number, lon: number, lat: number): [number, number] {
  return proj4(epsgToProj4(epsg)!).forward([lon, lat]) as [number, number];
}

describe('trueNorthFromGridDeg', () => {
  it('is zero on the central meridian of a UTM zone', () => {
    const [x, y] = at(32612, -111, 40);
    expect(trueNorthFromGridDeg(32612, x, y)).toBeCloseTo(0, 6);
  });

  it('matches the meridian convergence east and west of the central meridian', () => {
    // Convergence is about (lon - lon0) x sin(lat): 2 x sin(40) = 1.286 degrees.
    // East of the central meridian grid north lies east of true north, so true
    // north is drawn west of grid north (negative), and the reverse to the west.
    const [xe, ye] = at(32612, -109, 40);
    const east = trueNorthFromGridDeg(32612, xe, ye)!;
    expect(east).toBeLessThan(0);
    expect(Math.abs(east)).toBeCloseTo(1.29, 2);
    const [xw, yw] = at(32612, -113, 40);
    expect(trueNorthFromGridDeg(32612, xw, yw)!).toBeCloseTo(-east, 6);
  });

  it('changes sign with the hemisphere', () => {
    const [x, y] = at(32712, -109, -40);
    expect(trueNorthFromGridDeg(32712, x, y)!).toBeGreaterThan(0);
  });

  it('is null for an unknown CRS, a geographic CRS, or a point that does not convert', () => {
    expect(trueNorthFromGridDeg(null, 0, 0)).toBeNull();
    expect(trueNorthFromGridDeg(99999999, 500000, 4000000)).toBeNull();
    expect(trueNorthFromGridDeg(4326, -109, 40)).toBeNull();
    expect(trueNorthFromGridDeg(32612, Number.NaN, 0)).toBeNull();
  });
});
