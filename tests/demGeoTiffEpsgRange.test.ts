/**
 * A GeoTIFF CRS key holds an EPSG code only from 1024 to 32766.
 *
 * OGC 19-008r4 (GeoTIFF 1.1), requirements 12.4, 13.4 and 14.4: values of
 * ProjectedCRSGeoKey (3072), GeodeticCRSGeoKey (2048) and VerticalGeoKey
 * (4096) in 1024-32766 are EPSG codes, 32767 is user-defined and 32768-65535
 * are private. The keys are 16-bit, so a larger code was written as its low 16
 * bits: EPSG:90000 became 24464 and 163684 became 32612 (WGS 84 / UTM 12N), a
 * valid CRS in another place. Outside the range the writer now writes
 * GTModelType 32767 and no CRS key, and the DEM README says why.
 */
import { describe, expect, it } from 'vitest';
import { writeGeoTiff, type DemGeoTiffInput } from '../src/terrain/export/demGeoTiff';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { demResultAround } from './helpers/demPackageFixture';
import { extractEntry } from './helpers/zipReader';

const GEO_KEY_DIRECTORY = 34735;

/** The GeoKey directory of the first IFD as a key -> value map. */
function geoKeys(bytes: Uint8Array): Map<number, number> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    if (dv.getUint16(p, true) !== GEO_KEY_DIRECTORY) continue;
    const count = dv.getUint32(p + 4, true);
    const off = dv.getUint32(p + 8, true);
    const u16 = Array.from({ length: count }, (_, k) => dv.getUint16(off + k * 2, true));
    const keys = new Map<number, number>();
    for (let k = 0; k < u16[3]; k++) keys.set(u16[4 + k * 4], u16[7 + k * 4]);
    return keys;
  }
  throw new Error('no GeoKey directory');
}

const base: DemGeoTiffInput = {
  values: Float32Array.from([1, 2, 3, 4]),
  coverage: Uint8Array.from([1, 1, 1, 1]),
  cols: 2, rows: 2, cellSize: 1, xllCorner: 500_000, yllCorner: 4_000_000,
};

describe('writeGeoTiff writes a CRS key only for a code in 1024..32766', () => {
  it.each([90000, 163684, 32767, 32768, 1023, 3.5])('projected EPSG %s: GTModelType 32767, no 3072', (epsg) => {
    const keys = geoKeys(writeGeoTiff({ ...base, epsg }));
    expect(keys.get(1024)).toBe(32767);
    expect(keys.has(3072)).toBe(false);
    expect(keys.has(2048)).toBe(false);
  });

  it('geographic EPSG 70000: GTModelType 32767, no 2048', () => {
    const keys = geoKeys(writeGeoTiff({ ...base, epsg: 70000, isGeographic: true }));
    expect(keys.get(1024)).toBe(32767);
    expect(keys.has(2048)).toBe(false);
  });

  it('EPSG:32612 is written as it is', () => {
    const keys = geoKeys(writeGeoTiff({ ...base, epsg: 32612 }));
    expect(keys.get(1024)).toBe(1);
    expect(keys.get(3072)).toBe(32612);
  });

  it('the ends of the range are written', () => {
    expect(geoKeys(writeGeoTiff({ ...base, epsg: 1024 })).get(3072)).toBe(1024);
    expect(geoKeys(writeGeoTiff({ ...base, epsg: 32766 })).get(3072)).toBe(32766);
    expect(geoKeys(writeGeoTiff({ ...base, epsg: 4326, isGeographic: true })).get(2048)).toBe(4326);
  });

  it('a vertical CRS in range is still written', () => {
    const keys = geoKeys(writeGeoTiff({ ...base, epsg: 32612, verticalEpsg: 5703, verticalUnitCode: 9001 }));
    expect(keys.get(4096)).toBe(5703);
  });
});

const CUSTOM_WKT = 'PROJCS["Custom grid",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","90000"]]';

function dtm(epsg: number): DtmGrid {
  return {
    cols: 2, rows: 2, cellSizeM: 1, originH1: 0, originH2: 0,
    z: new Float32Array([1, 2, 3, 4]), coverage: new Uint8Array([2, 2, 2, 2]),
    confidence: new Float32Array(4).fill(90), counts: new Uint32Array(4).fill(1),
    interpDistanceCells: new Float32Array(4), meanConfidence: 90,
    crs: `EPSG:${epsg}`, horizontalEpsg: epsg, verticalDatum: null, verticalEpsg: null, verticalUnitToMetres: 1,
    coverageMode: 'full', sourcePointCount: 100, analyzedPointCount: 100, warnings: [],
  } as unknown as DtmGrid;
}

const OPTS = { basename: 's', worldOrigin: { x: 500_000, y: 4_000_000 }, generationDateIso: '2026-01-01T00:00:00.000Z' } as const;

function readme(zip: Uint8Array): string {
  return new TextDecoder().decode(extractEntry(zip, 's-README.txt')!).replace(/\s+/g, ' ');
}

describe('the DEM package for a code outside the GeoTIFF range', () => {
  it('a WKT with EPSG 90000: no CRS key, the .prj from the WKT, and the README says so', () => {
    const zip = buildDemPackage(demResultAround(dtm(90000)), { ...OPTS, wkt: CUSTOM_WKT });
    const keys = geoKeys(extractEntry(zip, 's-dtm.tif')!);
    expect(keys.get(1024)).toBe(32767);
    expect(keys.has(3072)).toBe(false);
    expect(new TextDecoder().decode(extractEntry(zip, 's-dtm.prj')!)).toContain('AUTHORITY["EPSG","90000"]');
    expect(readme(zip)).toContain('EPSG:90000 cannot be stored in GeoTIFF keys; the CRS is in the .prj only.');
  });

  it('a code with no WKT: no CRS key, no .prj, and the README says the rasters carry no CRS', () => {
    const zip = buildDemPackage(demResultAround(dtm(163684)), OPTS);
    const keys = geoKeys(extractEntry(zip, 's-dtm.tif')!);
    expect(keys.get(1024)).toBe(32767);
    expect(keys.has(3072)).toBe(false);
    expect(extractEntry(zip, 's-dtm.prj')).toBeFalsy();
    expect(readme(zip)).toContain('EPSG:163684 cannot be stored in GeoTIFF keys; the rasters carry no CRS.');
  });

  it('EPSG:32612 is unchanged and the README says nothing about it', () => {
    const zip = buildDemPackage(demResultAround(dtm(32612)), OPTS);
    expect(geoKeys(extractEntry(zip, 's-dtm.tif')!).get(3072)).toBe(32612);
    expect(readme(zip)).not.toContain('cannot be stored in GeoTIFF keys');
  });
});
