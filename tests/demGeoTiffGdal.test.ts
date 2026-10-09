/**
 * demGeoTiffGdal.test.ts — read the DTM GeoTIFF back with GDAL.
 *
 * The byte-level tests in demGeoTiffVerticalCrs.test.ts say which GeoKeys the
 * writer emits. This file asks an independent reader what those keys mean:
 * GDAL's default read of each file, with no configuration options, for the
 * CRS (horizontal and vertical), the band unit, the geotransform and the
 * sample values. It also checks every entry of the writer's vertical CRS table
 * against the EPSG registry through `projinfo`.
 *
 * GDAL is not part of the CI image, so every test here is skipped when
 * `gdalsrsinfo` is not on the PATH. A skipped run is not coverage; the
 * byte-level tests are what CI enforces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeGeoTiff,
  GeoTiffVerticalCrsConflictError,
  VERTICAL_CRS_UNITS,
  type DemGeoTiffInput,
} from '../src/terrain/export/demGeoTiff';
import { writeAsciiGrid } from '../src/terrain/export/demAsciiGrid';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import { extractEntry } from './helpers/zipReader';
import { DEM_PKG_OPTS, demResultFor } from './helpers/demPackageFixture';

const HAS_GDAL = spawnSync('gdalsrsinfo', ['--version'], { stdio: 'ignore' }).status === 0;
const HAS_TIFFFILE = spawnSync('python3', ['-I', '-c', 'import tifffile'], { stdio: 'ignore' }).status === 0;
const HAS_PROJINFO = spawnSync('projinfo', ['-q', '-o', 'PROJJSON', 'EPSG:5703'], { stdio: 'ignore' }).status === 0;

let dir = '';
beforeAll(() => {
  if (HAS_GDAL) dir = mkdtempSync(join(tmpdir(), 'olv-geotiff-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface GdalRead {
  crsType: string;
  crsName: string;
  horizontalEpsg: number | undefined;
  verticalName: string | null;
  verticalUnit: string | null;
  unitType: string | null;
  geoTransform: number[];
  xyz: number[][];
  stderr: string;
}

/** Write `bytes` and read it back with GDAL's command-line tools. */
function readWithGdal(name: string, bytes: Uint8Array): GdalRead {
  const file = join(dir, `${name}.tif`);
  writeFileSync(file, bytes);
  const srs = spawnSync('gdalsrsinfo', ['-o', 'projjson', file], { encoding: 'utf8' });
  const crs = JSON.parse(srs.stdout);
  const horizontal = crs.type === 'CompoundCRS' ? crs.components[0] : crs;
  const vertical = crs.type === 'CompoundCRS' ? crs.components[1] : null;
  const info = spawnSync('gdalinfo', ['-json', file], { encoding: 'utf8' });
  const j = JSON.parse(info.stdout);
  const xyz = execFileSync('gdal_translate', ['-q', '-of', 'XYZ', file, '/vsistdout/'], { encoding: 'utf8' })
    .trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  return {
    crsType: crs.type,
    crsName: crs.name,
    horizontalEpsg: horizontal.id?.code,
    verticalName: vertical?.name ?? null,
    verticalUnit: vertical ? unitName(vertical.coordinate_system.axis[0].unit) : null,
    unitType: j.bands[0].unit ?? null,
    geoTransform: j.geoTransform,
    xyz,
    stderr: `${srs.stderr}${info.stderr}`,
  };
}

const unitName = (u: string | { name: string }): string => (typeof u === 'string' ? u : u.name);

// Grid rows are south first: row 0 = [11, hole], row 1 = [21, 22]. Two-unit
// cells, lower-left corner at (500100, 4500200).
const base: DemGeoTiffInput = {
  values: Float32Array.from([11, 99, 21, 22]),
  coverage: Uint8Array.from([2, 0, 2, 2]),
  cols: 2, rows: 2, cellSize: 2, xllCorner: 500_100, yllCorner: 4_500_200,
  epsg: 32612, isGeographic: false,
};

/** Placement and samples every case must keep, whatever its vertical keys. */
function expectPlacement(r: GdalRead): void {
  expect(r.horizontalEpsg).toBe(32612);
  expect(r.geoTransform).toEqual([500_100, 2, 0, 4_500_204, 0, -2]);
  expect(r.xyz).toEqual([
    [500_101, 4_500_203, 21],
    [500_103, 4_500_203, 22],
    [500_101, 4_500_201, 11],
    [500_103, 4_500_201, -9999],
  ]);
  expect(r.stderr).not.toMatch(/ERROR/);
}

describe('GDAL reads the vertical CRS the writer means', () => {
  it.skipIf(!HAS_GDAL)('metre: NAVD88 height', () => {
    const r = readWithGdal('metre', writeGeoTiff({ ...base, verticalEpsg: 5703, verticalUnitCode: 9001 }));
    expect(r.crsType).toBe('CompoundCRS');
    expect(r.crsName).toBe('WGS 84 / UTM zone 12N + NAVD88 height');
    expect(r.verticalUnit).toBe('metre');
    expect(r.unitType).toBe('metre');
    expectPlacement(r);
  });

  it.skipIf(!HAS_GDAL)('international foot: NAVD88 height (ft)', () => {
    const r = readWithGdal('intl-foot', writeGeoTiff({ ...base, verticalEpsg: 5703, verticalUnitCode: 9002 }));
    expect(r.crsName).toBe('WGS 84 / UTM zone 12N + NAVD88 height (ft)');
    expect(r.verticalUnit).toBe('foot');
    expect(r.unitType).toBe('foot');
    expectPlacement(r);
  });

  it.skipIf(!HAS_GDAL)('US survey foot: NAVD88 height (ftUS)', () => {
    const r = readWithGdal('us-foot', writeGeoTiff({ ...base, verticalEpsg: 5703, verticalUnitCode: 9003 }));
    expect(r.crsName).toBe('WGS 84 / UTM zone 12N + NAVD88 height (ftUS)');
    expect(r.verticalUnit).toBe('US survey foot');
    expect(r.unitType).toBe('US survey foot');
    expectPlacement(r);
  });

  it.skipIf(!HAS_GDAL)('unknown vertical CRS: no vertical component, horizontal intact', () => {
    const r = readWithGdal('unknown', writeGeoTiff({ ...base, verticalEpsg: 12345, verticalUnitCode: 9001 }));
    expect(r.crsType).toBe('ProjectedCRS');
    expect(r.crsName).toBe('WGS 84 / UTM zone 12N');
    expect(r.verticalName).toBeNull();
    expect(r.unitType).toBe('metre');
    expectPlacement(r);
  });

  it.skipIf(!HAS_GDAL)('contradictory code and unit: refused, and the package ships no vertical CRS', () => {
    expect(() => writeGeoTiff({ ...base, verticalEpsg: 6360, verticalUnitCode: 9001 }))
      .toThrow(GeoTiffVerticalCrsConflictError);
    const g = {
      z: Float32Array.from([11, 12, 21, 22]), counts: new Uint32Array(4).fill(3),
      coverage: new Uint8Array(4).fill(2), confidence: new Float32Array(4).fill(100),
      interpDistanceCells: new Float32Array(4), cols: 2, rows: 2, cellSizeM: 1, originH1: 0, originH2: 0,
    };
    const result = demResultFor(g, 1);
    (result.dtm as { verticalEpsg: number | null }).verticalEpsg = 6360;
    const zip = buildDemPackage(result, DEM_PKG_OPTS);
    const r = readWithGdal('contradictory', extractEntry(zip, 'terrain-dtm.tif')!);
    expect(r.crsType).toBe('ProjectedCRS');
    expect(r.crsName).toBe('WGS 84 / UTM zone 10N');
    expect(r.unitType).toBe('metre');
    expect(r.stderr).not.toMatch(/ERROR/);
  });
});

describe('the vertical CRS table matches the EPSG registry', () => {
  const UNIT_NAME: Record<number, string> = { 9001: 'metre', 9002: 'foot', 9003: 'US survey foot' };
  it.skipIf(!HAS_PROJINFO)('names each code with the unit and direction the table gives it', () => {
    for (const [code, entry] of Object.entries(VERTICAL_CRS_UNITS)) {
      const j = JSON.parse(execFileSync('projinfo', ['-q', '-o', 'PROJJSON', `EPSG:${code}`], { encoding: 'utf8' }));
      expect(j.type, `EPSG:${code}`).toBe('VerticalCRS');
      expect(unitName(j.coordinate_system.axis[0].unit), `EPSG:${code}`).toBe(UNIT_NAME[entry.unitCode]);
      expect(j.name, `EPSG:${code}`).toBe(entry.name);
      expect(j.coordinate_system.axis[0].direction, `EPSG:${code}`).toBe(entry.direction);
    }
  });
});

/** STATISTICS_VALID_PERCENT of every band, from `gdalinfo -stats`. */
function validPercent(file: string): number[] {
  const j = JSON.parse(execFileSync('gdalinfo', ['-json', '-stats', file], { encoding: 'utf8' }));
  return j.bands.map((b: { metadata: Record<string, Record<string, string>> }) => Number(b.metadata[''].STATISTICS_VALID_PERCENT));
}

/** Samples equal to the declared NoData, counted by tifffile (an independent TIFF reader). */
function tifffileNoDataHits(file: string): number {
  const py = 'import sys,tifffile,numpy as np\n' +
    't=tifffile.TiffFile(sys.argv[1]); p=t.pages[0]\n' +
    'a=p.asarray().astype(np.float32); nd=np.float32(float(p.tags[42113].value))\n' +
    'print(int((a==nd).sum()))';
  return Number(execFileSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' }).trim());
}

describe('GDAL and tifffile read no measured height as NoData', () => {
  const geo = { cols: 2, rows: 1, cellSize: 1, xllCorner: 500_000, yllCorner: 4_500_000, epsg: 32612 };
  const both = new Uint8Array([1, 1]);
  const CASES: Array<[string, number[]]> = [
    ['exact', [-9999, 100]],
    ['above', [-9998.9996, 100]],
    ['below', [-9999.0003, 100]],
    ['control', [-9998.5, 100]],
  ];

  for (const [name, values] of CASES) {
    it.skipIf(!HAS_GDAL)(`${name} [${values}]: GeoTIFF and ASCII grid are 100% valid`, () => {
      const tif = join(dir, `nd-${name}.tif`);
      writeFileSync(tif, writeGeoTiff({ ...geo, values: Float32Array.from(values), coverage: both }));
      expect(validPercent(tif)).toEqual([100]);
      if (HAS_TIFFFILE) expect(tifffileNoDataHits(tif)).toBe(0);
      const asc = join(dir, `nd-${name}.asc`);
      writeFileSync(asc, writeAsciiGrid({ ...geo, values, coverage: both }));
      expect(validPercent(asc)).toEqual([100]);
    });
  }

  it.skipIf(!HAS_GDAL)('multiband [-9999, 1] and [5, -9998.9996]: every band is 100% valid', () => {
    const tif = join(dir, 'nd-multiband.tif');
    writeFileSync(tif, writeGeoTiff({
      ...geo,
      bands: [{ values: Float32Array.from([-9999, 1]) }, { values: Float32Array.from([5, -9998.9996]) }],
      coverage: both,
    }));
    expect(validPercent(tif)).toEqual([100, 100]);
    if (HAS_TIFFFILE) expect(tifffileNoDataHits(tif)).toBe(0);
  });
});
