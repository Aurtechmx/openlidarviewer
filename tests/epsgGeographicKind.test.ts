/**
 * Geographic versus projected for the EPSG codes the converter writes, checked
 * against the EPSG dataset (PROJ proj.db):
 *   6318 NAD83(2011)                                   geographic 2D
 *   4547 CGCS2000 / 3-degree Gauss-Kruger CM 114E      projected, metre
 *   6349 NAD83(2011) + NAVD88 height                   compound
 *   6348 NAD83(2011) / UTM zone 19N                    projected, metre
 * The converter takes the kind from the resolved CRS (a WKT with no authority
 * code included), and the code table only when a code is all it has.
 */
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { crsFromEpsg, crsFromWkt } from '../src/io/crs';
import { loadLas } from '../src/io/loadLas';
import { reprojectGlobal } from '../src/convert/reproject';
import { epsgDatumFamily, epsgToProj4, isGeographicEpsg, isGeographicProj4 } from '../src/convert/epsg';
import { GEOGRAPHIC_EPSG_RANGES } from '../src/convert/geographicEpsgCodes';
import { resolveEptCrs } from '../src/render/streaming/eptCrs';

function geoKeys(bytes: Uint8Array): Map<number, number> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = v.getUint16(94, true);
  const nVlr = v.getUint32(100, true);
  let p = headerSize;
  const out = new Map<number, number>();
  for (let i = 0; i < nVlr; i++) {
    const rid = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    if (rid === 34735) {
      const n = v.getUint16(p + 54 + 6, true);
      for (let k = 0; k < n; k++) {
        const o = p + 54 + 8 + k * 8;
        out.set(v.getUint16(o, true), v.getUint16(o + 6, true));
      }
    }
    p += 54 + len;
  }
  return out;
}

const scaleX = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(131, true);

function geoCloud(crs: ReturnType<typeof crsFromEpsg>): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 0.00012, 0.00034, 1, 0.0005, 0.0007, 2]),
    origin: [-100.123456, 40.654321, 100],
    sourceFormat: 'ply',
    name: 'geo.ply',
    metadata: { crs },
  });
}

function gkCloud(crs: ReturnType<typeof crsFromEpsg>): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1]),
    origin: [500000, 3400000, 50],
    sourceFormat: 'ply',
    name: 'cn.ply',
    metadata: { crs },
  });
}

describe('isGeographicEpsg against the EPSG dataset', () => {
  it('classifies codes outside the 4001-4999 block and projected codes inside it', () => {
    expect(isGeographicEpsg(6318)).toBe(true); // NAD83(2011)
    expect(isGeographicEpsg(6668)).toBe(true); // JGD2011
    expect(isGeographicEpsg(7844)).toBe(true); // GDA2020
    expect(isGeographicEpsg(4979)).toBe(true); // WGS 84 geographic 3D
    expect(isGeographicEpsg(4326)).toBe(true);
    expect(isGeographicEpsg(4547)).toBe(false); // CGCS2000 / 3-degree GK CM 114E
    expect(isGeographicEpsg(4978)).toBe(false); // geocentric
    expect(isGeographicEpsg(6349)).toBe(false); // compound
    expect(isGeographicEpsg(32611)).toBe(false);
    expect(isGeographicEpsg(4326.5)).toBe(false);
  });

  it('stores sorted, non-overlapping inclusive ranges', () => {
    const r = GEOGRAPHIC_EPSG_RANGES;
    expect(r.length % 2).toBe(0);
    for (let i = 0; i < r.length; i += 2) {
      expect(r[i]).toBeLessThanOrEqual(r[i + 1]);
      if (i > 0) expect(r[i]).toBeGreaterThan(r[i - 1] + 1);
    }
  });

  it('agrees with every longitude/latitude definition the converter resolves', () => {
    for (const code of [4326, 4269, 4267, 4258, 4283, 7844, 4167, 4490]) {
      expect(isGeographicProj4(epsgToProj4(code))).toBe(true);
      expect(isGeographicEpsg(code)).toBe(true);
    }
    expect(isGeographicProj4(epsgToProj4(32611))).toBe(false);
  });
});

describe('EPSG 6330 to 6348 are NAD83(2011) / UTM; 6349 is compound', () => {
  it('maps 6330 to zone 1N and 6348 to zone 19N', () => {
    expect(epsgToProj4(6330)).toMatch(/\+zone=1 /);
    expect(epsgToProj4(6348)).toMatch(/\+zone=19 /);
  });

  it('does not resolve 6349 to a UTM definition', () => {
    expect(epsgToProj4(6349)).toBeNull();
    expect(epsgDatumFamily(6349)).toBe('NAD83');
  });

  it('does not write UTM metres under the 6349 label', () => {
    const g = { count: 1, x: new Float64Array([-100]), y: new Float64Array([40]), z: new Float64Array([0]) };
    const r = reprojectGlobal(g as never, 4326, 6349);
    expect(r.transformed).toBe(false);
    expect(r.points.x[0]).toBe(-100);
  });
});

describe('convert writes the resolved CRS kind', () => {
  it('tags a NAD83(2011) geographic (6318) LAS geographic and keeps sub-metre coordinates', async () => {
    const { file, report } = convertCloud(geoCloud(crsFromEpsg(6318, { isGeographic: true })), { format: 'las', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    const keys = geoKeys(file!.bytes);
    expect(keys.get(1024)).toBe(2);
    expect(keys.get(2048)).toBe(6318);
    expect(keys.has(3072)).toBe(false);
    expect(scaleX(file!.bytes)).toBeLessThanOrEqual(1e-7);
    const out = await loadLas(file!.bytes.slice().buffer as ArrayBuffer, 'las', 'geo.las');
    const lon1 = out.positions[3] + out.origin[0];
    expect(Math.abs(lon1 - (-100.123456 + Math.fround(0.00012)))).toBeLessThan(1e-6);
  });

  it('writes a 6318 XYZ with at least 7 decimals of degrees', () => {
    const { file, report } = convertCloud(geoCloud(crsFromEpsg(6318, { isGeographic: true })), { format: 'xyz', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    const lines = new TextDecoder().decode(file!.bytes).trim().split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[1].split(' ')[0].split('.')[1].length).toBeGreaterThanOrEqual(7);
  });

  it('quantises a geographic WKT with no authority code at a geographic scale', () => {
    const wkt =
      'GEOGCS["NAD83(2011)",DATUM["NAD83_National_Spatial_Reference_System_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
    const crs = crsFromWkt(wkt);
    expect(crs.isGeographic).toBe(true);
    expect(crs.epsg).toBeUndefined();
    const { file, report } = convertCloud(geoCloud(crs), { format: 'las', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    expect(scaleX(file!.bytes)).toBeLessThanOrEqual(1e-6);
  });

  it('tags a CGCS2000 Gauss-Kruger (4547) LAS projected', () => {
    const crs = crsFromEpsg(4547, { isGeographic: false, linearUnit: 'metre', verticalEpsg: 5773 });
    const { file, report } = convertCloud(gkCloud(crs), { format: 'las', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    const keys = geoKeys(file!.bytes);
    expect(keys.get(1024)).toBe(1);
    expect(keys.get(3072)).toBe(4547);
    expect(keys.get(3076)).toBe(9001);
    expect(scaleX(file!.bytes)).toBe(0.001);
  });

  it('writes a 4547 LAS with no vertical datum instead of refusing on its vertical unit', () => {
    const crs = crsFromEpsg(4547, { isGeographic: false, linearUnit: 'metre' });
    for (const format of ['las', 'las14'] as const) {
      const { file, report } = convertCloud(gkCloud(crs), { format, crsMode: 'keep' });
      const messages = report.log.map((l) => l.message).join('\n');
      expect(messages).not.toMatch(/Vertical check failed/);
      expect(report.ok).toBe(true);
      expect(geoKeys(file!.bytes).get(3072)).toBe(4547);
    }
  });

  it('takes the kind of an assigned code from the EPSG table', () => {
    const { file, report } = convertCloud(gkCloud(crsFromEpsg(32650, { linearUnit: 'metre', verticalEpsg: 5773 })), {
      format: 'las',
      crsMode: 'assign',
      targetEpsg: 4547,
    });
    expect(report.ok).toBe(true);
    const keys = geoKeys(file!.bytes);
    expect(keys.get(1024)).toBe(1);
    expect(keys.get(3072)).toBe(4547);
  });
});

describe('EPT authority codes', () => {
  it('reads 6318 as geographic and 4547 as projected', () => {
    expect(resolveEptCrs({ srs: undefined, srsCodes: { horizontalEpsg: 6318 } } as never)?.isGeographic).toBe(true);
    expect(resolveEptCrs({ srs: undefined, srsCodes: { horizontalEpsg: 4547 } } as never)?.isGeographic).toBe(false);
  });
});
