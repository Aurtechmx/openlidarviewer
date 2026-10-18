/**
 * lasCrsKindAssign.test.ts — an assigned EPSG code is written as the kind of
 * CRS it names, and a code of unknown kind is refused, never taken to be
 * projected.
 *
 * The defect: a geographic XYZ cloud assigned EPSG:9990 (ITRF2020, geographic
 * 2D, absent from an EPSG v10 table) and written as LAS reported success with
 * GTModelTypeGeoKey 1, ProjectedCSTypeGeoKey 9990 and an X/Y scale of 0.001,
 * so -111.12345678 came back as -111.123. Byte-level checks on the written
 * header and GeoKeyDirectory.
 */

import { describe, it, expect } from 'vitest';
import { convertCloud } from '../src/convert/convertCloud';
import { PointCloud } from '../src/model/PointCloud';
import { epsgCrsKind, isGeographicEpsg } from '../src/convert/epsg';
import { EPSG_DATASET_VERSION } from '../src/convert/geographicEpsgCodes';
import { crsFromEpsg } from '../src/io/crs';

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** GeoKeyDirectory entries (keyId → value) from the VLRs of a LAS file. */
function geoKeys(bytes: Uint8Array): Map<number, number> {
  const v = view(bytes);
  let p = v.getUint16(94, true);
  const out = new Map<number, number>();
  for (let i = 0; i < v.getUint32(100, true); i++) {
    const id = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    if (id === 34735) {
      const d = p + 54;
      for (let k = 0; k < v.getUint16(d + 6, true); k++) out.set(v.getUint16(d + 8 + k * 8, true), v.getUint16(d + 8 + k * 8 + 6, true));
    }
    p += 54 + len;
  }
  return out;
}

/** The OGC WKT VLR payload, or null. */
function wktVlr(bytes: Uint8Array): string | null {
  const v = view(bytes);
  let p = v.getUint16(94, true);
  for (let i = 0; i < v.getUint32(100, true); i++) {
    const len = v.getUint16(p + 20, true);
    if (v.getUint16(p + 18, true) === 2112) return new TextDecoder().decode(bytes.subarray(p + 54, p + 54 + len - 1));
    p += 54 + len;
  }
  return null;
}

/** World X/Y of record `i`, rebuilt from the header scale and offset. */
function recordXY(bytes: Uint8Array, i: number): [number, number] {
  const v = view(bytes);
  const at = v.getUint32(96, true) + i * v.getUint16(105, true);
  return [
    v.getInt32(at, true) * v.getFloat64(131, true) + v.getFloat64(155, true),
    v.getInt32(at + 4, true) * v.getFloat64(139, true) + v.getFloat64(163, true),
  ];
}

const ORIGIN_LON = -111.12345678;
const ORIGIN_LAT = 28.12345678;

function angularCloud(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 0.00012345, 0.00015678, 1]),
    origin: [ORIGIN_LON, ORIGIN_LAT, 100],
    sourceFormat: 'xyz',
    name: 'angular.xyz',
  });
}

function projectedCloud(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10.25, 20.5, 1]),
    origin: [500000, 4000000, 100],
    sourceFormat: 'xyz',
    name: 'grid.xyz',
  });
}

const messages = (r: { log: readonly { message: string }[] }): string => r.log.map((l) => l.message).join('\n');

describe('EPSG tables', () => {
  it(`are generated from EPSG ${EPSG_DATASET_VERSION} and hold 9990 as geographic`, () => {
    expect(EPSG_DATASET_VERSION).toBe('v12.029');
    expect(isGeographicEpsg(9990)).toBe(true);
    expect(epsgCrsKind(9990)).toEqual({ kind: 'geographic', unit: 'degree', basis: 'epsg-table' });
  });

  it('resolves kind and unit for every family, and unknown for codes in no table', () => {
    expect(epsgCrsKind(4326)).toMatchObject({ kind: 'geographic', unit: 'degree', basis: 'registry' });
    expect(epsgCrsKind(4807)).toMatchObject({ kind: 'geographic', unit: 'grad' });
    expect(epsgCrsKind(26912)).toMatchObject({ kind: 'projected', unit: 'metre' });
    expect(epsgCrsKind(2231)).toMatchObject({ kind: 'projected', unit: 'us-survey-foot' });
    expect(epsgCrsKind(4978)).toMatchObject({ kind: 'geocentric' });
    expect(epsgCrsKind(6349)).toMatchObject({ kind: 'compound' });
    expect(epsgCrsKind(5703)).toMatchObject({ kind: 'vertical' });
    for (const code of [9999, 32767, 1, 123456]) expect(epsgCrsKind(code)).toEqual({ kind: 'unknown', unit: null, basis: 'none' });
  });
});

describe('assign a geographic code: geographic GeoKeys and 1e-7 degree steps', () => {
  it.each([9990, 4326, 4269, 6318])('EPSG:%i to LAS 1.2', (code) => {
    const { file, report } = convertCloud(angularCloud(), { format: 'las', crsMode: 'assign', targetEpsg: code });
    expect(report.ok).toBe(true);
    const keys = geoKeys(file!.bytes);
    expect(keys.get(1024)).toBe(2); // GTModelType geographic
    expect(keys.get(2048)).toBe(code); // GeographicTypeGeoKey
    expect(keys.has(3072)).toBe(false); // no ProjectedCSTypeGeoKey
    expect(view(file!.bytes).getFloat64(131, true)).toBe(1e-7);
    expect(view(file!.bytes).getFloat64(139, true)).toBe(1e-7);
    const [x0, y0] = recordXY(file!.bytes, 0);
    expect(Math.abs(x0 - ORIGIN_LON)).toBeLessThan(1e-7);
    expect(Math.abs(y0 - ORIGIN_LAT)).toBeLessThan(1e-7);
    // Requantisation is reported on its own line, apart from the assignment.
    expect(report.crsNote).toMatch(new RegExp(`assigned .*${code === 4326 ? 'WGS 84' : code === 4269 ? 'NAD83' : `EPSG:${code}`}`));
    expect(messages(report)).toContain('X and Y are written at 1e-7 degree steps because the output CRS is geographic.');
    expect(messages(report)).toContain(`EPSG:${code} is a geographic CRS in degrees.`);
  });

  it.each([4326, 4269, 6318])('EPSG:%i to LAS 1.4 writes its GEOGCS as WKT', (code) => {
    const { file, report } = convertCloud(angularCloud(), { format: 'las14', crsMode: 'assign', targetEpsg: code });
    expect(report.ok).toBe(true);
    expect(view(file!.bytes).getUint16(6, true) & 0x10).toBe(0x10);
    const wkt = wktVlr(file!.bytes)!;
    expect(wkt.startsWith('GEOGCS[')).toBe(true);
    expect(wkt.endsWith(`AUTHORITY["EPSG","${code}"]]`)).toBe(true);
    expect(view(file!.bytes).getFloat64(131, true)).toBe(1e-7);
  });

  it('EPSG:9990 to LAS 1.4 is refused by name: no verified WKT for it', () => {
    const { file, report } = convertCloud(angularCloud(), { format: 'las14', crsMode: 'assign', targetEpsg: 9990 });
    expect(file).toBeNull();
    expect(report.ok).toBe(false);
    expect(messages(report)).toMatch(/no verified WKT definition for EPSG:9990.*Choose LAS 1\.2/);
  });

  it('a LAS source on a 1 mm grid assigned a geographic code is re-quantised to 1e-7 degree', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 0.001, 0.002, 1]),
      origin: [ORIGIN_LON, ORIGIN_LAT, 100],
      sourceFormat: 'las',
      name: 'mislabelled.las',
      metadata: { sourceQuantisation: { scale: [0.001, 0.001, 0.001], offset: [-112, 28, 0] } },
    });
    const { file, report } = convertCloud(cloud, { format: 'las', crsMode: 'assign', targetEpsg: 4326 });
    expect(report.ok).toBe(true);
    expect(view(file!.bytes).getFloat64(131, true)).toBe(1e-7);
    expect(messages(report)).toMatch(/re-quantised \(the output CRS is geographic and the source X\/Y scale of 0\.001 0\.001/);
  });
});

describe('assign a projected code: projected GeoKeys and 1 mm steps', () => {
  it.each([26912, 32612, 2056])('EPSG:%i to LAS 1.2 and LAS 1.4', (code) => {
    const las = convertCloud(projectedCloud(), { format: 'las', crsMode: 'assign', targetEpsg: code });
    expect(las.report.ok).toBe(true);
    const keys = geoKeys(las.file!.bytes);
    expect(keys.get(1024)).toBe(1);
    expect(keys.get(3072)).toBe(code);
    expect(keys.has(2048)).toBe(false);
    expect(view(las.file!.bytes).getFloat64(131, true)).toBe(0.001);
    expect(messages(las.report)).toContain(`EPSG:${code} is a projected CRS in metres.`);

    const las14 = convertCloud(projectedCloud(), { format: 'las14', crsMode: 'assign', targetEpsg: code });
    expect(las14.report.ok).toBe(true);
    expect(view(las14.file!.bytes).getUint16(6, true) & 0x10).toBe(0x10);
    const wkt = wktVlr(las14.file!.bytes)!;
    expect(wkt.startsWith('PROJCS[')).toBe(true);
    expect(wkt.endsWith(`AUTHORITY["EPSG","${code}"]]`)).toBe(true);
    expect(view(las14.file!.bytes).getFloat64(131, true)).toBe(0.001);
  });
});

describe('assign a code of another or unknown kind: refused, nothing written', () => {
  it.each([
    [6349, /compound/],
    [4978, /geocentric/],
    [5703, /vertical CRS/],
  ])('EPSG:%i', (code, kind) => {
    for (const format of ['las', 'las14', 'xyz'] as const) {
      const { file, report } = convertCloud(projectedCloud(), { format, crsMode: 'assign', targetEpsg: code });
      expect(file).toBeNull();
      expect(report.ok).toBe(false);
      expect(messages(report)).toMatch(new RegExp(`EPSG:${code} was not assigned: it is `));
      expect(messages(report)).toMatch(kind);
    }
  });

  it.each([9999, 32767, 123456])('unknown EPSG:%i names the code and says its kind cannot be determined', (code) => {
    for (const format of ['las', 'las14', 'xyz', 'asc'] as const) {
      const { file, report } = convertCloud(angularCloud(), { format, crsMode: 'assign', targetEpsg: code });
      expect(file).toBeNull();
      expect(report.ok).toBe(false);
      expect(messages(report)).toContain(`EPSG:${code} was not assigned`);
      expect(messages(report)).toContain('whether it is a geographic or a projected CRS, and its units, cannot be determined');
    }
  });

  it('a kept code-only source of unknown kind is refused too', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      origin: [500000, 4000000, 0],
      sourceFormat: 'xyz',
      name: 'override.xyz',
      metadata: { crs: crsFromEpsg(9999, { linearUnit: 'metre' }) },
    });
    const { file, report } = convertCloud(cloud, { format: 'las', crsMode: 'keep' });
    expect(file).toBeNull();
    expect(messages(report)).toContain('EPSG:9999 was not exported');
  });
});
