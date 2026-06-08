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

/**
 * Read the GeoKeyDirectory (tag 34735) of a classic little-endian TIFF and
 * return the CRS EPSG carried by it: ProjectedCSTypeGeoKey (3072) for a
 * projected CRS, or GeographicTypeGeoKey (2048) for a geographic one. null when
 * no CRS key is present.
 */
function readTiffCrsEpsg(bytes: Uint8Array): number | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  let geoDirOffset = -1;
  let geoDirCount = 0;
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    if (dv.getUint16(p, true) === 34735) {
      geoDirCount = dv.getUint32(p + 4, true);
      geoDirOffset = dv.getUint32(p + 8, true); // SHORT array > 2 entries → offset
      break;
    }
  }
  if (geoDirOffset < 0) return null;
  // Header is 4 shorts; keys follow as [keyId, tagLoc, count, value].
  for (let i = 4; i + 4 <= geoDirCount; i += 4) {
    const keyId = dv.getUint16(geoDirOffset + i * 2, true);
    const value = dv.getUint16(geoDirOffset + (i + 3) * 2, true);
    if (keyId === 3072 || keyId === 2048) return value;
  }
  return null;
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
  // A COMPLETE, full-coverage, export-ready result. buildDemPackage now derives
  // the README's shared provenance via terrainAssessment(result), so the fixture
  // carries the same fields a real analysis run produces (cellStatusTally,
  // cellMetrics, qualityScore) — this is a fuller, not weaker, fixture.
  function fixtureResult(): AnalyseContoursResult {
    return {
      dtm: {
        z: Z, coverage: COV, cols: COLS, rows: ROWS, cellSizeM: 1,
        originH1: 10, originH2: 20, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703',
        coverageMode: 'full', meanConfidence: 80,
      },
      intervalM: 1,
      surface: { canopy: { heightM: new Float32Array([0, 5, NaN, NaN]) } },
      accuracyStandards: {
        rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
        qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
      },
      quality: {
        readiness: 'ready', exportReadiness: 'available',
        crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
      },
      qualityScore: { score: 85 },
      cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
      cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
      generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
      warnings: [],
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

  /** Extract a stored (uncompressed) entry's bytes from a store-only ZIP. */
  function extractEntry(zip: Uint8Array, name: string): Uint8Array | null {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const wantName = new TextEncoder().encode(name);
    let p = 0;
    while (p + 30 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
      const compSize = dv.getUint32(p + 18, true);
      const nameLen = dv.getUint16(p + 26, true);
      const extraLen = dv.getUint16(p + 28, true);
      const nameBytes = zip.subarray(p + 30, p + 30 + nameLen);
      const dataStart = p + 30 + nameLen + extraLen;
      let match = nameBytes.length === wantName.length;
      for (let j = 0; match && j < wantName.length; j++) {
        if (nameBytes[j] !== wantName[j]) match = false;
      }
      if (match) return zip.subarray(dataStart, dataStart + compSize);
      p = dataStart + compSize;
    }
    return null;
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

  it('propagates the CRS EPSG into every GeoTIFF and bundles the full file set', () => {
    const zip = buildDemPackage(fixtureResult(), {
      worldOrigin: { x: 600000, y: 4000000 }, basename: 'site', wkt: 'PROJCS["x"]',
    });
    // Expected entries: .asc + .tif for DTM/DSM/CHM, a .prj, and a README.
    for (const key of ['dtm', 'dsm', 'chm']) {
      expect(extractEntry(zip, `site-${key}.asc`)).not.toBeNull();
      const tif = extractEntry(zip, `site-${key}.tif`);
      expect(tif).not.toBeNull();
      // CRS must survive into each GeoTIFF's GeoKeyDirectory.
      expect(readTiffCrsEpsg(tif!)).toBe(32610);
    }
    expect(extractEntry(zip, 'site.prj')).not.toBeNull();
    expect(extractEntry(zip, 'site-README.txt')).not.toBeNull();
  });

  it('writes a README that documents coverage, the quality gate and provenance', () => {
    const zip = buildDemPackage(fixtureResult(), {
      basename: 'site', generationDateIso: '2026-06-05T00:00:00.000Z',
      softwareVersion: '9.9.9', metricVersion: 'v0.4.1',
    });
    const readme = new TextDecoder().decode(extractEntry(zip, 'site-README.txt')!);
    expect(readme).toMatch(/Coverage mode/i);
    expect(readme).toMatch(/Quality gate/i);
    expect(readme).toContain('2026-06-05T00:00:00.000Z');
    expect(readme).toContain('v0.4.1');
    // The unified provenance block carries the same verdicts every export shows.
    expect(readme).toMatch(/Provenance/);
    expect(readme).toMatch(/Surface quality\s+Good/);
    expect(readme).toMatch(/Export readiness\s+Ready/);
    expect(readme).toMatch(/not survey-grade/i);
    // A full + ready result must NOT carry the preliminary caveat.
    expect(readme).not.toMatch(/PRELIMINARY/);
  });
});
