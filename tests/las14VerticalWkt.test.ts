/**
 * las14VerticalWkt.test.ts — a LAS 1.4 export carries the vertical CRS in its
 * WKT, not only in GeoKeys beside it.
 *
 * The defect: EPSG:32613 metre XY over NAVD88 heights in US survey feet
 * (EPSG:6360) exported as LAS 1.4 wrote a horizontal-only WKT and put the
 * vertical datum and unit in GeoKeys. OLV's reader merges the two, so its own
 * check passed, but PDAL takes the CRS from the WKT alone once bit 4 is set:
 * it saw no vertical CRS, and a reprojection to EPSG:32613+5703 left 100 ftUS
 * as 100 m. Each case goes LAS bytes → parseLasHeader → CrsService →
 * convertCloud, as a loaded file does, and is checked on the bytes.
 */

import { describe, it, expect } from 'vitest';
import { convertCloud } from '../src/convert/convertCloud';
import { writeLas, writeLas14, type WriteLasOptions } from '../src/convert/writeLas';
import { verifyLasWktVertical } from '../src/convert/lasVerticalIdentity';
import { PointCloud } from '../src/model/PointCloud';
import { CrsService } from '../src/geo/CrsService';
import { crsFromWkt, type CrsInfo } from '../src/io/crs';
import { compoundWkt, wktForEpsg } from '../src/io/epsgWkt';
import { parseLasHeader } from '../src/io/lasHeader';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { ConvertOptions } from '../src/convert/types';

const US_FT = 1200 / 3937;

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

function wktOf(bytes: Uint8Array): string | null {
  const v = view(bytes);
  let p = v.getUint16(94, true);
  for (let i = 0; i < v.getUint32(100, true); i++) {
    const len = v.getUint16(p + 20, true);
    if (v.getUint16(p + 18, true) === 2112) return new TextDecoder().decode(bytes.subarray(p + 54, p + 54 + len - 1));
    p += 54 + len;
  }
  return null;
}

function geoKeys(bytes: Uint8Array): Map<number, number> {
  const v = view(bytes);
  let p = v.getUint16(94, true);
  const out = new Map<number, number>();
  for (let i = 0; i < v.getUint32(100, true); i++) {
    const len = v.getUint16(p + 20, true);
    if (v.getUint16(p + 18, true) === 34735) {
      for (let k = 0; k < v.getUint16(p + 54 + 6, true); k++) out.set(v.getUint16(p + 62 + k * 8, true), v.getUint16(p + 62 + k * 8 + 6, true));
    }
    p += 54 + len;
  }
  return out;
}

const service = (): CrsService => new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });

/** Load a source LAS the way the app does and return the cloud and its resolved CRS. */
function load(bytes: Uint8Array): { cloud: PointCloud; resolved: ResolvedCrs; detected: CrsInfo } {
  const detected = parseLasHeader(buf(bytes)).crs!;
  const resolved = service().resolveForScan({ name: 'mixed.las', detected, source: 'las-vlr' })!;
  const cloud = new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 10]),
    origin: [500000, 4000000, 100],
    sourceFormat: 'las',
    name: 'mixed.las',
    metadata: { crs: detected },
  });
  return { cloud, resolved, detected };
}

const points = { count: 2, x: Float64Array.of(500000, 500010), y: Float64Array.of(4000000, 4000020), z: Float64Array.of(100, 110) };
const geoKeySource = (o: WriteLasOptions): Uint8Array => writeLas(points, { epsg: 32613, linearUnitCode: 9001, ...o });

function convert(bytes: Uint8Array, opts: Omit<ConvertOptions, 'format' | 'resolvedSourceCrs'>) {
  const { cloud, resolved } = load(bytes);
  return convertCloud(cloud, { format: 'las14', resolvedSourceCrs: resolved, ...opts });
}

const messages = (r: { log: readonly { message: string }[] }): string => r.log.map((l) => l.message).join('\n');

describe('GeoKey-only source with a vertical CRS: compound WKT in the height unit', () => {
  it.each([
    ['metres', 5703, 9001, 1],
    ['international feet', 5703, 9002, 0.3048],
    ['US survey feet', 5703, 9003, US_FT],
  ] as const)('NAVD88 in %s', (_label, vEpsg, vUnit, factor) => {
    const { file, report } = convert(geoKeySource({ verticalEpsg: vEpsg, verticalUnitCode: vUnit }), { crsMode: 'keep' });
    expect(report.ok).toBe(true);
    const code = vUnit === 9001 ? 5703 : vUnit === 9002 ? 8228 : 6360;
    const wkt = wktOf(file!.bytes)!;
    expect(wkt).toBe(compoundWkt(wktForEpsg(32613)!, code));
    // A WKT-only reading states the vertical CRS and its unit.
    const fromWkt = crsFromWkt(wkt);
    expect(fromWkt.epsg).toBe(32613);
    expect(fromWkt.verticalEpsg).toBe(code);
    expect(fromWkt.verticalUnitToMetres).toBeCloseTo(factor, 12);
    // The GeoKeys beside it carry the same code and unit.
    expect(geoKeys(file!.bytes).get(4096)).toBe(code);
    expect(geoKeys(file!.bytes).get(4099)).toBe(vUnit);
    // Z is untouched.
    expect(parseLasHeader(buf(file!.bytes)).min[2]).toBe(100);
    expect(parseLasHeader(buf(file!.bytes)).max[2]).toBe(110);
  });
});

describe('source WKT', () => {
  it('a horizontal-only source WKT with vertical GeoKeys becomes a compound with the source horizontal', () => {
    const horizontal = wktForEpsg(32613)!.replace('"WGS 84 / UTM zone 13N"', '"WGS 84 / UTM 13N (source)"');
    const crs: CrsInfo = { ...crsFromWkt(horizontal), verticalEpsg: 6360, verticalDatum: 'NAVD88', verticalLinearUnit: 'us-survey-foot', verticalUnitToMetres: US_FT };
    const cloud = new PointCloud({ positions: Float32Array.from([0, 0, 0, 10, 20, 10]), origin: [500000, 4000000, 100], sourceFormat: 'las', name: 's.las', metadata: { crs } });
    const { file, report } = convertCloud(cloud, { format: 'las14', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    const wkt = wktOf(file!.bytes)!;
    expect(wkt).toBe(compoundWkt(horizontal, 6360));
    expect(messages(report)).toContain('CRS written as OGC WKT from the source WKT with its vertical CRS.');
  });

  it('a valid compound source WKT is kept as it is', () => {
    const compound =
      'COMPD_CS["NAD83(2011) / UTM zone 15N + NAVD88 height - Geoid18 (m)",PROJCS["NAD83(2011) / UTM zone 15N",GEOGCS["NAD83(2011)",DATUM["NAD83 (National Spatial Reference System 2011)",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","1116"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","6318"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-93],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["meter",1,AUTHORITY["EPSG","9001"]],AXIS["X",EAST],AXIS["Y",NORTH],AUTHORITY["EPSG","6344"]],VERT_CS["NAVD88 height - Geoid18 (m)",VERT_DATUM["North American Vertical Datum 1988",2005,AUTHORITY["EPSG","5103"]],UNIT["meter",1,AUTHORITY["EPSG","9001"]],AXIS["Up",UP],AUTHORITY["EPSG","5703"]]]';
    const crs = crsFromWkt(compound);
    const cloud = new PointCloud({ positions: Float32Array.from([0, 0, 0, 10, 20, 10]), origin: [500000, 4000000, 100], sourceFormat: 'las', name: 'c.las', metadata: { crs } });
    const { file, report } = convertCloud(cloud, { format: 'las14', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    expect(wktOf(file!.bytes)).toBe(compound);
  });
});

describe('a horizontal change keeps the source heights', () => {
  it.each(['assign', 'reproject'] as const)('%s 32613 → 32614 rebuilds the horizontal and keeps NAVD88 (ftUS)', (crsMode) => {
    const { file, report } = convert(geoKeySource({ verticalEpsg: 6360, verticalUnitCode: 9003 }), { crsMode, targetEpsg: 32614 });
    expect(report.ok).toBe(true);
    const wkt = wktOf(file!.bytes)!;
    expect(wkt).toBe(compoundWkt(wktForEpsg(32614)!, 6360));
    expect(crsFromWkt(wkt).verticalUnitToMetres).toBeCloseTo(US_FT, 12);
    expect(parseLasHeader(buf(file!.bytes)).min[2]).toBe(100);
  });
});

describe('what a WKT cannot carry truthfully is refused', () => {
  it('a height unit with no vertical datum, different from the horizontal unit', () => {
    const { file, report } = convert(geoKeySource({ verticalUnitCode: 9003 }), { crsMode: 'keep' });
    expect(file).toBeNull();
    expect(messages(report)).toMatch(/declared in US survey feet with no vertical datum.*would take the heights in metres.*Choose LAS 1\.2/);
  });

  it('a height unit with no vertical datum, equal to the horizontal unit, writes the horizontal WKT and the unit key', () => {
    const { file, report } = convert(geoKeySource({ verticalUnitCode: 9001 }), { crsMode: 'keep' });
    expect(report.ok).toBe(true);
    expect(wktOf(file!.bytes)).toBe(wktForEpsg(32613));
    expect(geoKeys(file!.bytes).get(4099)).toBe(9001);
    expect(geoKeys(file!.bytes).has(4096)).toBe(false);
  });

  it('a vertical CRS with no stored definition (EPSG:5710 Ostend height)', () => {
    const { file, report } = convert(geoKeySource({ verticalEpsg: 5710, verticalUnitCode: 9001 }), { crsMode: 'keep' });
    expect(file).toBeNull();
    expect(messages(report)).toMatch(/vertical CRS EPSG:5710, and this build cannot write that vertical CRS into the file's WKT/);
  });

  it('LAS 1.2 still records each of these as GeoKeys', () => {
    for (const o of [{ verticalUnitCode: 9003 }, { verticalEpsg: 5710, verticalUnitCode: 9001 }]) {
      const { cloud, resolved } = load(geoKeySource(o));
      expect(convertCloud(cloud, { format: 'las', crsMode: 'keep', resolvedSourceCrs: resolved }).report.ok).toBe(true);
    }
  });
});

describe('the WKT-only vertical check', () => {
  const plan = { ok: true as const, verticalEpsg: 5703, unitCode: 9003, expectedToMetres: US_FT, unknown: false, warning: null };
  const zToMetres = (c: CrsInfo): number | undefined => c.verticalUnitToMetres ?? (c.linearUnitToMetres > 0 ? c.linearUnitToMetres : undefined);

  it('fails a horizontal-only WKT over foot heights, which a merged read would pass', () => {
    // Built the way the old writer did: horizontal WKT, vertical only in GeoKeys.
    const bytes = writeLas14(points, { epsg: 32613, wkt: wktForEpsg(32613), verticalUnitCode: 9001 });
    expect(verifyLasWktVertical(bytes, plan, zToMetres)).toMatch(/read from its WKT alone.*1 m per height unit/);
  });

  it('passes the compound the writer now produces', () => {
    const bytes = writeLas14(points, { epsg: 32613, verticalEpsg: 5703, verticalUnitCode: 9003 });
    expect(verifyLasWktVertical(bytes, plan, zToMetres)).toBeNull();
  });
});
