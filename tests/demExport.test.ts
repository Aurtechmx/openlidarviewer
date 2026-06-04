import { describe, it, expect } from 'vitest';
import { writeAsciiGrid } from '../src/terrain/export/demAsciiGrid';
import { writeGeoTiff } from '../src/terrain/export/demGeoTiff';
import { buildDemPackage, parseEpsg } from '../src/terrain/export/demPackage';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

// A 2×2 grid, row-major (row 0 = south). Values rise to the north-east.
//   row1 (north): 30 40
//   row0 (south): 10 20
const COLS = 2;
const ROWS = 2;
const Z = new Float32Array([10, 20, 30, 40]);
const COV = new Uint8Array([2, 2, 1, 0]); // last cell empty

describe('writeAsciiGrid (Esri ASCII Grid / AAIGrid)', () => {
  it('writes a correct header and emits north-row-first with NODATA', () => {
    const txt = writeAsciiGrid({
      values: Z, coverage: COV, cols: COLS, rows: ROWS,
      cellSize: 1, xllCorner: 500, yllCorner: 4000, noData: -9999, precision: 1,
    });
    const lines = txt.trimEnd().split('\n');
    expect(lines[0]).toBe('ncols 2');
    expect(lines[1]).toBe('nrows 2');
    expect(lines[2]).toBe('xllcorner 500');
    expect(lines[3]).toBe('yllcorner 4000');
    expect(lines[4]).toBe('cellsize 1');
    expect(lines[5]).toBe('NODATA_value -9999');
    // North row (row 1) first: 30, 40 — but cell (1,1) is empty → NODATA.
    expect(lines[6]).toBe('30.0 -9999');
    // South row (row 0): 10, 20.
    expect(lines[7]).toBe('10.0 20.0');
  });
});

/** Read a classic little-endian TIFF's IFD into a tag→value map (count-1 tags). */
function readTiffTags(bytes: Uint8Array): Map<number, number> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dv.getUint8(0)).toBe(0x49); // 'I'
  expect(dv.getUint8(1)).toBe(0x49); // 'I'
  expect(dv.getUint16(2, true)).toBe(42);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  const tags = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const tag = dv.getUint16(p, true);
    const type = dv.getUint16(p + 2, true);
    const value = type === 3 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true);
    tags.set(tag, value);
  }
  return tags;
}

describe('writeGeoTiff (Float32 GeoTIFF)', () => {
  it('produces a valid TIFF with the expected raster + geo tags', () => {
    const tif = writeGeoTiff({
      values: Z, coverage: COV, cols: COLS, rows: ROWS,
      cellSize: 1, xllCorner: 500, yllCorner: 4000, noData: -9999,
      epsg: 32610, isGeographic: false, verticalEpsg: 5703,
    });
    const tags = readTiffTags(tif);
    expect(tags.get(256)).toBe(COLS); // ImageWidth
    expect(tags.get(257)).toBe(ROWS); // ImageLength
    expect(tags.get(258)).toBe(32); // BitsPerSample
    expect(tags.get(339)).toBe(3); // SampleFormat = IEEE float
    expect(tags.get(277)).toBe(1); // SamplesPerPixel
    expect(tags.has(33550)).toBe(true); // ModelPixelScale
    expect(tags.has(33922)).toBe(true); // ModelTiepoint
    expect(tags.has(34735)).toBe(true); // GeoKeyDirectory
    expect(tags.has(42113)).toBe(true); // GDAL_NODATA
    // Strip byte count = cols*rows*4.
    expect(tags.get(279)).toBe(COLS * ROWS * 4);
  });

  it('writes the north row first and NODATA for empty cells', () => {
    const tif = writeGeoTiff({
      values: Z, coverage: COV, cols: COLS, rows: ROWS,
      cellSize: 1, xllCorner: 0, yllCorner: 0, noData: -9999, epsg: 32610,
    });
    const tags = readTiffTags(tif);
    const strip = tags.get(273)!;
    const dv = new DataView(tif.buffer, tif.byteOffset, tif.byteLength);
    // First pixel = north-west = grid (row1,col0) = 30.
    expect(dv.getFloat32(strip, true)).toBeCloseTo(30, 4);
    // Second pixel = north-east = empty → NODATA.
    expect(dv.getFloat32(strip + 4, true)).toBeCloseTo(-9999, 4);
    // Third = south-west = 10, fourth = south-east = 20.
    expect(dv.getFloat32(strip + 8, true)).toBeCloseTo(10, 4);
    expect(dv.getFloat32(strip + 12, true)).toBeCloseTo(20, 4);
  });
});

describe('parseEpsg', () => {
  it('parses EPSG identifiers and rejects junk', () => {
    expect(parseEpsg('EPSG:32610')).toBe(32610);
    expect(parseEpsg('epsg:4326')).toBe(4326);
    expect(parseEpsg('32610')).toBe(32610);
    expect(parseEpsg(null)).toBeNull();
    expect(parseEpsg('local')).toBeNull();
  });
});

describe('buildDemPackage', () => {
  function fixtureResult(): AnalyseContoursResult {
    return {
      dtm: {
        z: Z, coverage: COV, cols: COLS, rows: ROWS, cellSizeM: 1,
        originH1: 10, originH2: 20, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703',
      },
      surface: { canopy: { heightM: new Float32Array([0, 5, NaN, NaN]) } },
      accuracyStandards: {
        rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
        qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
      },
    } as unknown as AnalyseContoursResult;
  }

  function hasName(zip: Uint8Array, name: string): boolean {
    const needle = new TextEncoder().encode(name);
    outer: for (let i = 0; i + needle.length <= zip.length; i++) {
      for (let j = 0; j < needle.length; j++) if (zip[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  it('bundles DTM/DSM/CHM as .asc + .tif, a .prj, and a README', () => {
    const zip = buildDemPackage(fixtureResult(), {
      worldOrigin: { x: 600000, y: 4000000 }, basename: 'site', wkt: 'PROJCS["x"]',
    });
    for (const key of ['dtm', 'dsm', 'chm']) {
      expect(hasName(zip, `site-${key}.asc`)).toBe(true);
      expect(hasName(zip, `site-${key}.tif`)).toBe(true);
    }
    expect(hasName(zip, 'site.prj')).toBe(true);
    expect(hasName(zip, 'site-README.txt')).toBe(true);
  });

  it('omits the .prj when no WKT is supplied', () => {
    const zip = buildDemPackage(fixtureResult(), { basename: 'site' });
    expect(hasName(zip, 'site.prj')).toBe(false);
    expect(hasName(zip, 'site-dtm.tif')).toBe(true);
  });
});
