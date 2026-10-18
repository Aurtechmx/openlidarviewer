/**
 * las14WktRequired.test.ts — LAS 1.4 point formats 6 and 7 always carry the
 * CRS as an OGC WKT record with global-encoding bit 4 set.
 *
 * The defect: a cloud whose CRS was known from GeoTIFF keys alone (EPSG:26912)
 * exported as LAS 1.4 with "keep" reported "kept NAD83 / UTM zone 12N" and
 * wrote point format 6 with global encoding 1 and only a GeoKey VLR. LAS 1.4
 * R15 requires WKT for formats 6-10, and PDAL reported such a file with an
 * empty SRS. Byte-level checks on the header, the VLRs and the EVLRs.
 */

import { describe, it, expect } from 'vitest';
import { convertCloud } from '../src/convert/convertCloud';
import { LasCrsError, planLas14Crs, writeLas14 } from '../src/convert/writeLas';
import { PointCloud } from '../src/model/PointCloud';
import type { CrsInfo } from '../src/io/crs';
import { compoundWkt, isUsableWkt, wktForEpsg } from '../src/io/epsgWkt';
import { parseLasHeader } from '../src/io/lasHeader';
import { loadLas } from '../src/io/loadLas';

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

interface Vlr { readonly recordId: number; readonly payload: Uint8Array }

function vlrs(bytes: Uint8Array): Vlr[] {
  const v = view(bytes);
  let p = v.getUint16(94, true);
  const out: Vlr[] = [];
  for (let i = 0; i < v.getUint32(100, true); i++) {
    const len = v.getUint16(p + 20, true);
    out.push({ recordId: v.getUint16(p + 18, true), payload: bytes.subarray(p + 54, p + 54 + len) });
    p += 54 + len;
  }
  return out;
}

function geoKeys(bytes: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  const gk = vlrs(bytes).find((r) => r.recordId === 34735);
  if (!gk) return out;
  const v = new DataView(gk.payload.buffer, gk.payload.byteOffset, gk.payload.byteLength);
  for (let k = 0; k < v.getUint16(6, true); k++) out.set(v.getUint16(8 + k * 8, true), v.getUint16(8 + k * 8 + 6, true));
  return out;
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b[b.length - 1] === 0 ? b.subarray(0, b.length - 1) : b);
const wktOf = (bytes: Uint8Array): string | null => {
  const r = vlrs(bytes).find((x) => x.recordId === 2112);
  return r ? text(r.payload) : null;
};
const encoding = (bytes: Uint8Array): number => view(bytes).getUint16(6, true);

function geotiffCrs(epsg: number, name: string, extra: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'geotiff', name, epsg, isGeographic: false, linearUnit: 'metre', linearUnitToMetres: 1, ...extra };
}

function cloud(crs: CrsInfo | undefined, rgb: boolean, origin: [number, number, number] = [500000, 4000000, 100]): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 5, 2]),
    origin,
    sourceFormat: 'las',
    name: 'geokeys.las',
    ...(rgb ? { colors: Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90]) } : {}),
    metadata: crs ? { crs } : {},
  });
}

const messages = (r: { log: readonly { message: string }[] }): string => r.log.map((l) => l.message).join('\n');

const GEOKEY_ONLY: ReadonlyArray<[number, string, [number, number, number]]> = [
  [26912, 'NAD83 / UTM zone 12N', [500000, 4000000, 100]],
  [32633, 'WGS 84 / UTM zone 33N', [400000, 5600000, 100]],
  [2154, 'RGF93 v1 / Lambert-93', [650000, 6860000, 100]],
];

describe('GeoKey-only source CRS, kept, LAS 1.4: WKT record and bit 4', () => {
  for (const rgb of [false, true]) {
    const pdrf = rgb ? 7 : 6;
    it.each(GEOKEY_ONLY)(`PDRF ${pdrf}: EPSG:%i`, async (code, name, origin) => {
      const { file, report } = convertCloud(cloud(geotiffCrs(code, name), rgb, origin), { format: 'las14', crsMode: 'keep' });
      expect(report.ok).toBe(true);
      const bytes = file!.bytes;
      expect(view(bytes).getUint8(104)).toBe(pdrf);
      expect(encoding(bytes) & 0x10).toBe(0x10);
      expect(wktOf(bytes)).toBe(wktForEpsg(code));
      expect(wktOf(bytes)!.endsWith(`AUTHORITY["EPSG","${code}"]]`)).toBe(true);
      // The WKT is the only horizontal authority: no horizontal GeoKeys beside it.
      expect(geoKeys(bytes).has(3072)).toBe(false);
      expect(geoKeys(bytes).has(1024)).toBe(false);
      expect(messages(report)).toContain(`CRS written as OGC WKT for EPSG:${code}.`);
      // The app's own reader takes the CRS back from the WKT.
      expect(parseLasHeader(buf(bytes)).crs?.epsg).toBe(code);
      const again = await loadLas(buf(bytes), 'las', 'again.las');
      expect(again.metadata?.crs?.epsg).toBe(code);
    });
  }
});

describe('source WKT', () => {
  const SOURCE_WKT = wktForEpsg(26912)!.replace('"NAD83 / UTM zone 12N"', '"NAD83 / UTM zone 12N (from source)"');

  it('a usable source WKT is written as is', () => {
    const crs: CrsInfo = { ...geotiffCrs(26912, 'NAD83 / UTM zone 12N'), source: 'wkt', wkt: SOURCE_WKT };
    for (const rgb of [false, true]) {
      const { file, report } = convertCloud(cloud(crs, rgb), { format: 'las14', crsMode: 'keep' });
      expect(report.ok).toBe(true);
      expect(encoding(file!.bytes) & 0x10).toBe(0x10);
      expect(wktOf(file!.bytes)).toBe(SOURCE_WKT);
      expect(messages(report)).toContain('CRS written as OGC WKT from the source WKT.');
    }
  });

  it('a truncated source WKT is replaced by the verified one for its code, with a warning', () => {
    const crs: CrsInfo = { ...geotiffCrs(26912, 'NAD83 / UTM zone 12N'), source: 'wkt', wkt: 'PROJCS["NAD83 / UTM zone 12N",GEOGCS[' };
    expect(isUsableWkt(crs.wkt)).toBe(false);
    const { file, report } = convertCloud(cloud(crs, false), { format: 'las14', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    expect(wktOf(file!.bytes)).toBe(wktForEpsg(26912));
    expect(messages(report)).toContain('The source WKT is not a usable definition');
  });

  it('a truncated source WKT with no code is refused', () => {
    expect(planLas14Crs({ wkt: 'PROJCS["x",' })).toMatchObject({ ok: false });
    expect(() => writeLas14({ count: 1, x: Float64Array.of(1), y: Float64Array.of(1), z: Float64Array.of(1) }, { wkt: 'PROJCS["x",' }))
      .toThrow(/not a usable coordinate-system definition/);
  });
});

describe('no WKT can be produced: refused, never "kept"', () => {
  it('EPSG:2231 (NAD83 / Colorado North (ftUS)) from GeoKeys: LAS 1.4 refused, LAS 1.2 still offered', () => {
    const crs = geotiffCrs(2231, 'NAD83 / Colorado North (ftUS)', { linearUnit: 'us-survey-foot', linearUnitToMetres: 1200 / 3937 });
    for (const rgb of [false, true]) {
      const { file, report } = convertCloud(cloud(crs, rgb), { format: 'las14', crsMode: 'keep' });
      expect(file).toBeNull();
      expect(report.ok).toBe(false);
      expect(messages(report)).toMatch(/LAS 1\.4 was not written\. Point formats 6 to 10 require the coordinate system as OGC WKT, and this build has no verified WKT definition for EPSG:2231\. Choose LAS 1\.2/);
      expect(messages(report)).not.toMatch(/kept/);
    }
    // LAS 1.2 is the existing explicit choice, and it records the code as GeoKeys.
    const las12 = convertCloud(cloud(crs, false), { format: 'las', crsMode: 'keep' });
    expect(las12.report.ok).toBe(true);
    expect(geoKeys(las12.file!.bytes).get(3072)).toBe(2231);
  });

  it('the writer itself refuses rather than clearing bit 4 over GeoKeys', () => {
    const g = { count: 1, x: Float64Array.of(1), y: Float64Array.of(1), z: Float64Array.of(1) };
    expect(() => writeLas14(g, { epsg: 2231 })).toThrow(LasCrsError);
  });

  it('a cloud with no CRS writes no WKT and leaves bit 4 clear', () => {
    const { file, report } = convertCloud(cloud(undefined, false), { format: 'las14', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    expect(encoding(file!.bytes) & 0x10).toBe(0);
    expect(vlrs(file!.bytes).some((r) => r.recordId === 2112 || r.recordId === 34735)).toBe(false);
  });
});

describe('oversized WKT goes in an extended VLR', () => {
  // A valid WKT padded past the 65,535-byte VLR payload limit through its name.
  const BIG = wktForEpsg(26912)!.replace('"NAD83 / UTM zone 12N"', `"NAD83 / UTM zone 12N ${'x'.repeat(70000)}"`);

  it('writes record 2112 as an EVLR after the points, with bit 4 and the EVLR header fields', async () => {
    const crs: CrsInfo = { ...geotiffCrs(26912, 'NAD83 / UTM zone 12N'), source: 'wkt', wkt: BIG };
    const { file, report } = convertCloud(cloud(crs, true), { format: 'las14', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    expect(messages(report)).toContain('in an extended VLR because it exceeds the 65,535-byte VLR limit');
    const bytes = file!.bytes;
    const v = view(bytes);
    expect(encoding(bytes) & 0x10).toBe(0x10);
    expect(vlrs(bytes).some((r) => r.recordId === 2112)).toBe(false);
    const n = Number(v.getBigUint64(247, true));
    const evlrStart = Number(v.getBigUint64(235, true));
    expect(evlrStart).toBe(v.getUint32(96, true) + n * v.getUint16(105, true));
    expect(v.getUint32(243, true)).toBe(1);
    expect(new TextDecoder().decode(bytes.subarray(evlrStart + 2, evlrStart + 17))).toBe('LASF_Projection');
    expect(v.getUint16(evlrStart + 18, true)).toBe(2112);
    const len = Number(v.getBigUint64(evlrStart + 20, true));
    expect(len).toBe(BIG.length + 1);
    expect(evlrStart + 60 + len).toBe(bytes.byteLength);
    expect(text(bytes.subarray(evlrStart + 60, evlrStart + 60 + len))).toBe(BIG);
    const again = await loadLas(buf(bytes), 'las', 'again.las');
    expect(again.metadata?.crs?.epsg).toBe(26912);
    expect(again.pointCount).toBe(3);
  });
});

describe('vertical metadata stays consistent with the WKT', () => {
  const navd88 = (unit: 'metre' | 'us-survey-foot'): Partial<CrsInfo> => ({
    verticalEpsg: 5703,
    verticalDatum: 'NAVD88',
    verticalLinearUnit: unit,
    verticalUnitToMetres: unit === 'metre' ? 1 : 1200 / 3937,
  });

  it.each([
    ['metre', 5703, 9001],
    ['us-survey-foot', 6360, 9003],
  ] as const)('NAVD88 heights in %s: compound WKT with VERT_CS %i, and the same code in the GeoKeys', (unit, code, unitCode) => {
    const crs = geotiffCrs(26912, 'NAD83 / UTM zone 12N', navd88(unit));
    for (const rgb of [false, true]) {
      const { file, report } = convertCloud(cloud(crs, rgb), { format: 'las14', crsMode: 'keep' });
      expect(report.ok).toBe(true);
      const wkt = wktOf(file!.bytes)!;
      expect(wkt).toBe(compoundWkt(wktForEpsg(26912)!, code));
      expect(wkt.startsWith(`COMPD_CS["NAD83 / UTM zone 12N + NAVD88 height`)).toBe(true);
      expect(wkt.endsWith(`AUTHORITY["EPSG","${code}"]]]`)).toBe(true);
      expect(geoKeys(file!.bytes).get(4096)).toBe(code);
      expect(geoKeys(file!.bytes).get(4099)).toBe(unitCode);
      expect(messages(report)).toContain(`CRS written as OGC WKT for EPSG:26912 with its vertical CRS.`);
      const h = parseLasHeader(buf(file!.bytes)).crs!;
      expect(h.epsg).toBe(26912);
      expect(h.verticalEpsg).toBe(code);
    }
  });
});
