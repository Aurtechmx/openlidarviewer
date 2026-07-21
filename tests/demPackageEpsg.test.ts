/**
 * The DEM package's authority-code parsing.
 *
 * `parseEpsg` is fed the CRS DISPLAY label — `terrainAnalysisRunner` passes
 * `cur.name` through as `dtm.crs`, and `dtm.verticalDatum` is a datum name —
 * and it used to accept any 3–6 digit run, with the `EPSG:` prefix optional.
 * Every CRS whose name carries a year therefore stamped its GeoTIFF with that
 * year as the authority code: a structurally valid raster asserting the wrong
 * coordinate system, which is worse than one asserting none, because a reader
 * places it confidently.
 */

import { describe, it, expect } from 'vitest';
import { parseEpsg } from '../src/terrain/export/demPackage';

describe('parseEpsg — a code, never a number found in prose', () => {
  it('does not read a year out of a CRS name', () => {
    expect(parseEpsg('Mexico ITRF2008 / LCC')).toBeNull();           // was 2008, real 6362
    expect(parseEpsg('CH1903+ / LV95')).toBeNull();                  // was 1903, real 2056
    expect(parseEpsg('Estonian Coordinate System 1997')).toBeNull(); // was 1997, real 3301
    expect(parseEpsg('Baltic 1977')).toBeNull();                     // was 1977, real 5705
    expect(parseEpsg('EGM2008 height')).toBeNull();                  // was 2008, real 3855
  });

  it('still reads a bare authority string', () => {
    expect(parseEpsg('EPSG:26913')).toBe(26913);
    expect(parseEpsg('epsg:4326')).toBe(4326);
  });

  it('still reads the parenthesised form the CRS parsers build', () => {
    // This is the shape that actually arrives for a well-identified CRS, so
    // losing it would trade a wrong code for a missing one on every scan whose
    // CRS the app resolved correctly.
    expect(parseEpsg('NAD83 / UTM zone 13N (EPSG:26913)')).toBe(26913);
  });

  it('returns null for an absent or empty label', () => {
    expect(parseEpsg(null)).toBeNull();
    expect(parseEpsg(undefined)).toBeNull();
    expect(parseEpsg('')).toBeNull();
  });

  it('does not read a code mentioned mid-sentence', () => {
    // Prose about a CRS is not a declaration of one.
    expect(parseEpsg('derived from EPSG:26913 by hand')).toBeNull();
  });
});
