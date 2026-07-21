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

  it('reads VerticalUnitsGeoKey (4099) as the Z-axis unit, distinct from horizontal', () => {
    // Horizontal grid in metres (3076 = 9001), vertical height in US survey feet
    // (4099 = 9003). Elevation must convert by the foot unit, not the metre one.
    const bytes = geoKeyBytes([[1024, 1], [3072, 26911], [3076, 9001], [4096, 5703], [4099, 9003]]);
    const crs = crsFromGeoTiff(bytes, null, null);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.verticalLinearUnit).toBe('us-survey-foot');
    expect(crs.verticalUnitToMetres).toBeCloseTo(0.3048006096012192, 10);
  });

  it('leaves the vertical unit undefined when no 4099 key is present', () => {
    const crs = crsFromGeoTiff(geoKeyBytes([[1024, 1], [3072, 26911], [4096, 5703]]), null, null);
    expect(crs.verticalLinearUnit).toBeUndefined();
    expect(crs.verticalUnitToMetres).toBeUndefined();
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
    // verticalUnitCode is now explicit — the writer no longer infers it from
    // the horizontal, because Z never moves during conversion and a foot
    // horizontal over metre heights (or the reverse) was being relabelled.
    const las = writeLas(cloudToGlobal(cloud()), {
      epsg: 26911, isGeographic: false, linearUnitCode: 9002,
      verticalEpsg: 5703, verticalUnitCode: 9002,
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
    expect(map.get(4099)).toBe(9002); // the explicitly-passed vertical unit
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
      [{ name: 'survey.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) }],
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
    const r1 = await runBatch([{ name: 's.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) }], { format: 'las', crsMode: 'keep' }, decode);
    expect(r1[0].sidecar).toBeUndefined();
    const r2 = await runBatch([{ name: 's.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) }], { format: 'xyz', crsMode: 'reproject', targetEpsg: 4326 }, decode);
    expect(r2[0].sidecar).toBeUndefined();
  });
});

/**
 * GTModelTypeGeoKey (1024) is OPTIONAL in the wild — GeographicTypeGeoKey (2048)
 * alone is a legal georeference. Deriving "is this geographic?" from key 1024
 * alone therefore misread a lat/lon file as projected metres, and because the
 * measurement guard keys off that, distances over DEGREES were reported in
 * metres and saved. 0.001 deg of latitude is ~111 m on the ground.
 *
 * The kind is recoverable without key 1024: 3072 is ProjectedCSTypeGeoKey and
 * 2048 is GeographicTypeGeoKey, so whichever key CARRIES the code already says
 * which kind it is.
 */
describe('crsFromGeoTiff — CRS kind without GTModelTypeGeoKey', () => {
  it('reads a geographic CRS declared only by GeographicTypeGeoKey', () => {
    const crs = crsFromGeoTiff(geoKeyBytes([[2048, 4326]]), null, null);
    expect(crs.epsg).toBe(4326);
    expect(crs.isGeographic).toBe(true);
    // Degrees are not a linear unit, so no metre factor may be asserted.
    expect(crs.linearUnit).toBe('unknown');
  });

  it('reads a projected CRS declared only by ProjectedCSTypeGeoKey', () => {
    const crs = crsFromGeoTiff(geoKeyBytes([[3072, 26913]]), null, null);
    expect(crs.epsg).toBe(26913);
    expect(crs.isGeographic).toBe(false);
  });

  it('still trusts GTModelTypeGeoKey when it IS present', () => {
    expect(crsFromGeoTiff(geoKeyBytes([[1024, 2], [2048, 4326]]), null, null).isGeographic).toBe(true);
    expect(crsFromGeoTiff(geoKeyBytes([[1024, 1], [3072, 26913]]), null, null).isGeographic).toBe(false);
  });

  it('prefers the projected key when a file carries both', () => {
    // A projected CRS names its base geographic CRS in 2048; that does not make
    // the file geographic.
    const crs = crsFromGeoTiff(geoKeyBytes([[2048, 4269], [3072, 26913]]), null, null);
    expect(crs.epsg).toBe(26913);
    expect(crs.isGeographic).toBe(false);
  });

  it('refuses the user-defined sentinel rather than printing it as a code', () => {
    // 32767 means "user-defined" — the file declared NO code, so reporting
    // EPSG:32767 invents an identity. The vertical path already rejects it.
    expect(crsFromGeoTiff(geoKeyBytes([[1024, 1], [3072, 32767]]), null, null).epsg).toBeUndefined();
    expect(crsFromGeoTiff(geoKeyBytes([[1024, 2], [2048, 32767]]), null, null).epsg).toBeUndefined();
  });
});

/**
 * A WKT body carries many AUTHORITY clauses — datum, spheroid, primem, axis and
 * unit all have their own. Taking the LAST one in the EPSG range worked only
 * because well-formed WKT happens to put the CRS's own authority last; a PROJCS
 * with no top-level authority (older / non-GDAL writers) latched onto
 * UNIT[...AUTHORITY["EPSG","9001"]] and reported the scan's CRS as EPSG:9001 —
 * a unit of measure presented as a coordinate system.
 *
 * The CRS's authority is the one at the OUTERMOST node; a nested clause's is
 * not a candidate at all.
 */
describe('crsFromWkt — the CRS authority, not a nested one', () => {
  it('ignores a unit authority when the CRS declares none', () => {
    const crs = crsFromWkt(
      'PROJCS["Custom Zone",GEOGCS["WGS 84",DATUM["WGS_1984",' +
        'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],' +
        'AUTHORITY["EPSG","6326"]],AUTHORITY["EPSG","4326"]],' +
        'UNIT["metre",1,AUTHORITY["EPSG","9001"]]]',
    );
    // No authority on the PROJCS itself, so no code is claimed at all.
    expect(crs.epsg).toBeUndefined();
    expect(crs.name).not.toContain('9001');
  });

  it('still reads a well-formed PROJCS authority', () => {
    const crs = crsFromWkt(
      'PROJCS["NAD83 / UTM zone 13N",GEOGCS["NAD83",AUTHORITY["EPSG","4269"]],' +
        'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","26913"]]',
    );
    expect(crs.epsg).toBe(26913);
  });

  it('reads a bare GEOGCS authority', () => {
    const crs = crsFromWkt(
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
        'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],' +
        'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
    );
    expect(crs.epsg).toBe(4326);
  });

  it('does not mistake a datum authority for the CRS authority', () => {
    // 6326 (datum) sits at depth 2; with no CRS authority nothing is claimed.
    const crs = crsFromWkt(
      'GEOGCS["Unnamed",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563],' +
        'AUTHORITY["EPSG","6326"]]]',
    );
    expect(crs.epsg).toBeUndefined();
  });
});

/**
 * A projected CRS must not be NAMED by its base geographic CRS.
 *
 * GeoTIFF citations are free text and writers fill them in loosely. When a
 * file carries ProjectedCSTypeGeoKey 32629 but only a GeogCitation of
 * "WGS 84", the resolver used that citation as the CRS name — so a UTM zone
 * 29N scan displayed as "WGS 84 (EPSG:32629)". A reader who sees "WGS 84"
 * reasonably concludes EPSG:4326 and degrees, which is the wrong frame, the
 * wrong units, and the wrong idea of what the numbers mean. Observed on a
 * PDAL-written survey with eastings around 517,000.
 */
function geoKeyBytesWithAscii(
  keys: Array<[number, number, number?, number?]>,
): Uint8Array {
  const u16 = new Uint16Array(4 + keys.length * 4);
  u16[0] = 1; u16[1] = 1; u16[2] = 0; u16[3] = keys.length;
  keys.forEach(([k, v, loc, count], i) => {
    const o = 4 + i * 4;
    u16[o] = k; u16[o + 1] = loc ?? 0; u16[o + 2] = count ?? 1; u16[o + 3] = v;
  });
  return new Uint8Array(u16.buffer);
}
const ascii = (s: string) => new TextEncoder().encode(s);

describe('crsFromGeoTiff — projected CRS naming', () => {
  it('does not adopt a geographic citation as a projected CRS’s name', () => {
    // 3072 = 32629 (projected), and the ONLY citation is 2049 = "WGS 84".
    const bytes = geoKeyBytesWithAscii([[1024, 1], [3072, 32629], [2049, 0, 34737, 7]]);
    const crs = crsFromGeoTiff(bytes, ascii('WGS 84|'), null);
    expect(crs.epsg).toBe(32629);
    expect(crs.isGeographic).toBe(false);
    expect(crs.name).not.toBe('WGS 84');
    expect(crs.name).not.toBe('WGS 84 (EPSG:32629)');
  });

  it('names a WGS 84 UTM zone from its code, which fully determines it', () => {
    // The app's convention is "Name (EPSG:code)" — both halves must be there.
    const north = crsFromGeoTiff(geoKeyBytesWithAscii([[1024, 1], [3072, 32629]]), null, null);
    expect(north.name).toBe('WGS 84 / UTM zone 29N (EPSG:32629)');
    const south = crsFromGeoTiff(geoKeyBytesWithAscii([[1024, 1], [3072, 32733]]), null, null);
    expect(south.name).toBe('WGS 84 / UTM zone 33S (EPSG:32733)');
    // A code outside the systematic ranges must NOT be invented into a name.
    const other = crsFromGeoTiff(geoKeyBytesWithAscii([[1024, 1], [3072, 2056]]), null, null);
    expect(other.name).toBe('EPSG:2056');
  });

  it('still prefers a PROJECTED citation, which does describe this CRS', () => {
    const bytes = geoKeyBytesWithAscii([[1024, 1], [3072, 32629], [3073, 0, 34737, 22]]);
    const crs = crsFromGeoTiff(bytes, ascii('WGS 84 / UTM zone 29N|'), null);
    expect(crs.name).toContain('UTM zone 29N');
  });

  it('leaves a geographic CRS free to use its geographic citation', () => {
    const bytes = geoKeyBytesWithAscii([[1024, 2], [2048, 4326], [2049, 0, 34737, 7]]);
    const crs = crsFromGeoTiff(bytes, ascii('WGS 84|'), null);
    expect(crs.isGeographic).toBe(true);
    expect(crs.name).toContain('WGS 84');
  });
});
