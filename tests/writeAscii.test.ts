/**
 * ASCII export coordinate precision.
 *
 * Three decimals is millimetre precision in a projected CRS and roughly 110 m
 * in a geographic one. The ASCII writers used one fixed precision for all three
 * axes with no geographic branch, so a cloud reprojected to WGS84 — reachable
 * because the target EPSG is a free-text field and 4326 resolves — was written
 * with every point snapped to a lattice about 55 m across in latitude.
 *
 * `exporters.ts` already switches to 7 dp for geographic CRSs, and
 * `writeLas.ts` already uses a 1e-7 scale for them. The convert path is the one
 * that never got it. Z stays at 3 dp throughout: a height is a linear unit even
 * when the horizontal frame is degrees.
 */

import { describe, it, expect } from 'vitest';
import { writeXyz, writeAsc } from '../src/convert/writeAscii';
import type { GlobalPoints } from '../src/convert/globalPoints';

/** One point, at whatever coordinates the case needs. */
function pts(x: number, y: number, z: number): GlobalPoints {
  return {
    count: 1,
    x: Float64Array.from([x]),
    y: Float64Array.from([y]),
    z: Float64Array.from([z]),
  };
}

// A real WGS84 position: 1e-3 deg of latitude is ~111 m, so 3 dp cannot
// describe it. The seventh decimal is ~1.1 cm, the survey convention.
const LON = -105.0000001;
const LAT = 39.7392358;
const ELEV = 1609.344;

describe('writeXyz — geographic coordinates keep degree precision', () => {
  it('writes 7 decimals for a geographic CRS', () => {
    const out = writeXyz(pts(LON, LAT, ELEV), 3, true);
    expect(out).toContain('-105.0000001');
    expect(out).toContain('39.7392358');
  });

  it('keeps Z at the linear precision even in a geographic CRS', () => {
    // Elevation is metres (or feet) regardless of the horizontal frame.
    expect(writeXyz(pts(LON, LAT, ELEV), 3, true).trim().split(/\s+/)[2]).toBe('1609.344');
  });

  it('still writes 3 decimals for a projected CRS', () => {
    const out = writeXyz(pts(500000.1234, 4400000.5678, 1609.3444), 3, false);
    expect(out).toContain('500000.123');
    expect(out).toContain('4400000.568');
  });

  it('defaults to projected precision when no flag is given', () => {
    // The existing single-argument callers must stay byte-identical.
    expect(writeXyz(pts(500000.1234, 4400000.5678, 1.5))).toContain('500000.123');
  });

  it('shows the ~55 m quantization the flag prevents', () => {
    // Pins the magnitude of the defect at the third decimal of latitude.
    const coarse = writeXyz(pts(LON, LAT, ELEV), 3, false);
    expect(coarse).toContain('39.739');
    expect(coarse).not.toContain('39.7392358');
  });
});

describe('writeAsc — geographic coordinates keep degree precision', () => {
  it('writes 7 decimals for a geographic CRS', () => {
    const out = writeAsc(pts(LON, LAT, ELEV), { epsg: 4326, geographic: true });
    expect(out).toContain('-105.0000001');
    expect(out).toContain('39.7392358');
  });

  it('still writes 3 decimals for a projected CRS', () => {
    expect(writeAsc(pts(500000.1234, 4400000.5678, 1.5), { epsg: 26913 })).toContain('500000.123');
  });

  it('keeps its CRS header', () => {
    expect(writeAsc(pts(LON, LAT, ELEV), { epsg: 4326, geographic: true }))
      .toContain('# crs: EPSG:4326');
  });
});
