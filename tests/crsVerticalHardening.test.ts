/**
 * crsVerticalHardening.test.ts — vertical datum detection, compound-CRS WKT,
 * LAS GeoKey fidelity (linear-unit + vertical), assign validation, .prj sidecar.
 */

import { describe, it, expect } from 'vitest';
import { crsFromWkt, crsFromGeoTiff } from '../src/io/crs';
import { writeLas } from '../src/convert/writeLas';
import { cloudToGlobal } from '../src/convert/globalPoints';
import { convertCloud } from '../src/convert/convertCloud';
import { runBatch, type DecodeFn } from '../src/convert/convertRunner';
import { PointCloud } from '../src/model/PointCloud';

const COMPOUND_WKT =
  'COMPD_CS["NAD83 / UTM zone 11N + NAVD88 height",' +
  'PROJCS["NAD83 / UTM zone 11N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",' +
  'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],' +
  'UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
  'UNIT["metre",1],AUTHORITY["EPSG","26911"]],' +
  'VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005],' +
  'UNIT["metre",1],AUTHORITY["EPSG","5703"]]]';

describe('crsFromWkt — compound CRS (horizontal vs vertical)', () => {
  it('keeps the horizontal EPSG/unit and reads the vertical datum separately', () => {
    const crs = crsFromWkt(COMPOUND_WKT);
    expect(crs.epsg).toBe(26911); // horizontal — NOT the vertical 5703
    expect(crs.isGeographic).toBe(false);
    expect(crs.linearUnit).toBe('metre'); // not polluted by the vertical UNIT
    expect(crs.verticalDatum).toMatch(/NAVD88/);
    expect(crs.verticalEpsg).toBe(5703);
  });

  it('still parses a plain projected WKT, with no vertical datum', () => {
    const crs = crsFromWkt('PROJCS["WGS 84 / UTM zone 12N",AUTHORITY["EPSG","32612"]]');
    expect(crs.epsg).toBe(32612);
    expect(crs.isGeographic).toBe(false);
    expect(crs.verticalEpsg).toBeUndefined();
  });

  it('detects a geographic WKT', () => {
    const crs = crsFromWkt('GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]');
    expect(crs.isGeographic).toBe(true);
  });

  it('reads an EXPLICIT vertical EPSG even when the datum name is unrecognised', () => {
    const wkt =
      'COMPD_CS["x",PROJCS["NAD83 / UTM zone 11N",AUTHORITY["EPSG","26911"]],' +
      'VERT_CS["Some local height datum",VERT_DATUM["Local",2005,AUTHORITY["EPSG","1234"]],' +
      'UNIT["metre",1],AUTHORITY["EPSG","5703"]]]';
    const crs = crsFromWkt(wkt);
    expect(crs.epsg).toBe(26911); // horizontal, not the datum 1234 or vertical 5703
    expect(crs.verticalEpsg).toBe(5703); // the vertical CRS authority, not the datum 1234
    expect(crs.verticalDatum).toBe('Some local height datum');
  });

  it('parses a standalone VERT_CS (no horizontal CRS)', () => {
    const crs = crsFromWkt('VERT_CS["NAVD88 height",VERT_DATUM["NAVD88",2005],UNIT["metre",1],AUTHORITY["EPSG","5703"]]');
    expect(crs.verticalEpsg).toBe(5703);
    expect(crs.verticalDatum).toMatch(/NAVD88/);
    expect(crs.isGeographic).toBe(false);
  });
});

/** Build a minimal GeoKeyDirectory byte array from [keyId, value] pairs. */
function geoKeyBytes(keys: Array<[number, number]>): Uint8Array {
  const u16 = new Uint16Array(4 + keys.length * 4);
  u16[0] = 1; u16[1] = 1; u16[2] = 0; u16[3] = keys.length;
  keys.forEach(([k, v], i) => {
    const o = 4 + i * 4;
    u16[o] = k; u16[o + 1] = 0; u16[o + 2] = 1; u16[o + 3] = v;
  });
  return new Uint8Array(u16.buffer);
}

describe('crsFromGeoTiff — vertical key', () => {
  it('reads VerticalCSTypeGeoKey (4096) into the vertical datum', () => {
    const bytes = geoKeyBytes([[1024, 1], [3072, 26911], [4096, 5703]]);
    const crs = crsFromGeoTiff(bytes, null, null);
    expect(crs.epsg).toBe(26911);
    expect(crs.verticalEpsg).toBe(5703);
    expect(crs.verticalDatum).toBe('NAVD88');
  });
});

function cloud(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
    origin: [500000, 4000000, 0],
    sourceFormat: 'las',
    name: 'c.las',
  });
}

describe('writeLas — linear-unit + vertical GeoKeys', () => {
  it('writes ProjLinearUnits (3076) and VerticalCSType (4096)+Units (4099)', () => {
    const las = writeLas(cloudToGlobal(cloud()), {
      epsg: 26911, isGeographic: false, linearUnitCode: 9002, verticalEpsg: 5703,
    });
    const view = new DataView(las.buffer);
    expect(view.getUint32(100, true)).toBe(1); // 1 VLR
    const geoStart = 227 + 54; // header + VLR header
    const numKeys = view.getUint16(geoStart + 6, true);
    const map = new Map<number, number>();
    for (let i = 0; i < numKeys; i++) {
      const o = geoStart + 8 + i * 8;
      map.set(view.getUint16(o, true), view.getUint16(o + 6, true));
    }
    expect(map.get(1024)).toBe(1); // projected
    expect(map.get(3072)).toBe(26911); // ProjectedCSType
    expect(map.get(3076)).toBe(9002); // linear unit = international foot
    expect(map.get(4096)).toBe(5703); // vertical CRS
    expect(map.get(4099)).toBe(9002); // vertical unit matches the foot horizontal
  });
});

describe('convertCloud — assign-EPSG validation', () => {
  it('warns for an out-of-range EPSG and notes an unrecognised one', () => {
    const bad = convertCloud(cloud(), { format: 'las', crsMode: 'assign', targetEpsg: 7 });
    expect(bad.report.log.some((l) => l.level === 'warn' && /valid EPSG range/i.test(l.message))).toBe(true);

    const unknown = convertCloud(cloud(), { format: 'las', crsMode: 'assign', targetEpsg: 2227 });
    expect(unknown.report.log.some((l) => /in the built-in registry/i.test(l.message))).toBe(true);
  });
});

describe('runBatch — .prj sidecar for kept ASCII with WKT', () => {
  it('emits a .prj carrying the source WKT next to the XYZ output', async () => {
    const decode: DecodeFn = async () =>
      new PointCloud({
        positions: Float32Array.from([0, 0, 0]),
        origin: [500000, 4000000, 0],
        sourceFormat: 'las',
        name: 'survey.las',
        metadata: { crs: crsFromWkt('PROJCS["NAD83 / UTM zone 11N",AUTHORITY["EPSG","26911"]]') },
      });
    const results = await runBatch(
      [{ name: 'survey.las', buffer: new ArrayBuffer(8) }],
      { format: 'xyz', crsMode: 'keep' },
      decode,
    );
    const sc = results[0].sidecar;
    expect(sc).toBeDefined();
    expect(sc!.filename).toBe('survey.prj');
    expect(new TextDecoder().decode(sc!.bytes)).toMatch(/PROJCS\["NAD83/);
  });

  it('no sidecar for reproject (output CRS ≠ source WKT) or LAS output', async () => {
    const decode: DecodeFn = async () =>
      new PointCloud({
        positions: Float32Array.from([0, 0, 0]),
        origin: [500000, 4000000, 0],
        sourceFormat: 'las',
        name: 's.las',
        metadata: { crs: crsFromWkt('PROJCS["NAD83 / UTM zone 11N",AUTHORITY["EPSG","26911"]]') },
      });
    const r1 = await runBatch([{ name: 's.las', buffer: new ArrayBuffer(8) }], { format: 'las', crsMode: 'keep' }, decode);
    expect(r1[0].sidecar).toBeUndefined();
    const r2 = await runBatch([{ name: 's.las', buffer: new ArrayBuffer(8) }], { format: 'xyz', crsMode: 'reproject', targetEpsg: 4326 }, decode);
    expect(r2[0].sidecar).toBeUndefined();
  });
});
