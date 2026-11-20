/**
 * When the DEM GeoTIFFs carry no horizontal CRS key but a .prj in the
 * package holds the CRS, the README says so and names that .prj. A stored
 * vertical code still gives the DTM and DSM their vertical keys, so the line
 * names the horizontal key only.
 *
 * GDAL's GeoTIFF driver does not read a .prj beside a .tif, so a GIS opens
 * those rasters with no CRS. That happens for an EPSG code outside 1024..32766
 * (the keys cannot hold it) and for a custom horizontal WKT with no EPSG code.
 * The evidence raster has no .prj of its own, so the line names the CHM's
 * .prj (horizontal only) for every GeoTIFF. A code the keys can hold, or no
 * .prj at all, prints nothing new.
 */
import { describe, expect, it } from 'vitest';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { demResultAround } from './helpers/demPackageFixture';
import { extractEntry } from './helpers/zipReader';
import { tiffGeoKeys as geoKeys } from './helpers/crsTestKit';

const LINES = [
  '  GeoTIFF CRS    No .tif file here carries a horizontal CRS key. Assign every',
  '                 GeoTIFF in this folder the horizontal CRS in s-chm.prj.',
];
const LINE = LINES[0]!;

const CODE_90000_WKT = 'PROJCS["Custom grid",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","90000"]]';
const NO_CODE_WKT = 'PROJCS["Site transverse Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["central_meridian",-111.5],PARAMETER["scale_factor",0.9999],UNIT["metre",1]]';

function dtm(epsg: number | null, crs: string, verticalEpsg: number | null = null): DtmGrid {
  return {
    cols: 2, rows: 2, cellSizeM: 1, originH1: 0, originH2: 0,
    z: new Float32Array([1, 2, 3, 4]), coverage: new Uint8Array([2, 2, 2, 2]),
    confidence: new Float32Array(4).fill(90), counts: new Uint32Array(4).fill(1),
    interpDistanceCells: new Float32Array(4), meanConfidence: 90,
    crs, horizontalEpsg: epsg, verticalDatum: null, verticalEpsg, verticalUnitToMetres: 1,
    coverageMode: 'full', sourcePointCount: 100, analyzedPointCount: 100, warnings: [],
  } as unknown as DtmGrid;
}

const OPTS = { basename: 's', worldOrigin: { x: 500_000, y: 4_000_000 }, generationDateIso: '2026-01-01T00:00:00.000Z' } as const;

const readme = (zip: Uint8Array): string => new TextDecoder().decode(extractEntry(zip, 's-README.txt')!);

describe('the GeoTIFFs carry no CRS key and a .prj holds the CRS', () => {
  it('an EPSG code outside 1024..32766 with a WKT', () => {
    const zip = buildDemPackage(demResultAround(dtm(90000, 'EPSG:90000')), { ...OPTS, wkt: CODE_90000_WKT });
    expect(geoKeys(extractEntry(zip, 's-dtm.tif')!).has(3072)).toBe(false);
    expect(extractEntry(zip, 's-dtm.prj')).toBeTruthy();
    const text = readme(zip);
    expect(text).toContain(LINES.join('\n'));
    expect(text.split('\n').filter((l) => l === LINE)).toHaveLength(1);
    // The file the line names is in the package.
    expect(extractEntry(zip, 's-chm.prj')).toBeTruthy();
    // The existing line stays.
    expect(text.replace(/\s+/g, ' ')).toContain('EPSG:90000 cannot be stored in GeoTIFF keys; the CRS is in the .prj only.');
  });

  it('an EPSG code outside the range with a WKT and a stored vertical code', () => {
    const zip = buildDemPackage(demResultAround(dtm(90000, 'EPSG:90000', 5703)), { ...OPTS, wkt: CODE_90000_WKT });
    const keys = geoKeys(extractEntry(zip, 's-dtm.tif')!);
    // The DTM carries its vertical CRS keys, and no horizontal one.
    expect(keys.get(4096)).toBe(5703);
    expect(keys.get(4099)).toBe(9001);
    expect(keys.has(3072)).toBe(false);
    expect(keys.has(2048)).toBe(false);
    const text = readme(zip);
    expect(text).toContain(LINES.join('\n'));
    expect(text).not.toContain('carries a CRS key');
    expect(text).toContain('Vertical CRS   EPSG:5703');
  });

  it('a custom horizontal WKT with no EPSG code', () => {
    const zip = buildDemPackage(demResultAround(dtm(null, 'Site transverse Mercator')), { ...OPTS, wkt: NO_CODE_WKT });
    const keys = geoKeys(extractEntry(zip, 's-dtm.tif')!);
    expect(keys.get(1024)).toBe(32767);
    expect(keys.has(3072)).toBe(false);
    expect(extractEntry(zip, 's-dtm.prj')).toBeTruthy();
    expect(readme(zip)).toContain(LINES.join('\n'));
    expect(extractEntry(zip, 's-chm.prj')).toBeTruthy();
  });
});

describe('no new line when the keys hold the CRS or there is no .prj', () => {
  it('EPSG:32612 is unchanged', () => {
    const zip = buildDemPackage(demResultAround(dtm(32612, 'EPSG:32612')), OPTS);
    expect(geoKeys(extractEntry(zip, 's-dtm.tif')!).get(3072)).toBe(32612);
    expect(readme(zip)).not.toContain('GeoTIFF CRS');
  });

  it('an EPSG code outside the range with no WKT keeps its own line only', () => {
    const zip = buildDemPackage(demResultAround(dtm(90000, 'EPSG:90000')), { ...OPTS, linearUnit: 'unknown' });
    expect(extractEntry(zip, 's-dtm.prj')).toBeFalsy();
    const text = readme(zip);
    expect(text).not.toContain('GeoTIFF CRS');
    expect(text.replace(/\s+/g, ' ')).toContain('EPSG:90000 cannot be stored in GeoTIFF keys; the rasters carry no CRS.');
  });
});
