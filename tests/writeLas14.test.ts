/**
 * writeLas14.test.ts — the LAS 1.4 writer (point formats 6/7).
 *
 * Round-trips use the project's OWN LAS reader (`loadLas`, built on
 * `lasHeader.ts` + `lasDecodeShared.ts`) — if our reader recovers the data,
 * the output is genuinely valid, not just structurally plausible. The
 * classification round-trip with classes 64 and 200 is the regression pin
 * for the audit defect where the 1.2 writer's 5-bit mask zeroed class 64.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { writeLas, writeLas14, pickPointFormat14 } from '../src/convert/writeLas';
import { parseLasHeader } from '../src/io/lasHeader';
import { loadLas } from '../src/io/loadLas';
import { convertCloud } from '../src/convert/convertCloud';

function sampleGlobal(over: Partial<GlobalPoints> = {}): GlobalPoints {
  return {
    count: 3,
    x: Float64Array.from([500000.123, 500001.5, 500002.0]),
    y: Float64Array.from([4100000.0, 4100000.25, 4100001.0]),
    z: Float64Array.from([12.34, 13.0, 14.5]),
    ...over,
  };
}

describe('global-encoding GPS Time Type bit (convert-1)', () => {
  const enc = (las: Uint8Array): number =>
    new DataView(las.buffer, las.byteOffset, las.byteLength).getUint16(6, true);

  it('LAS 1.4 declares Adjusted Standard GPS Time (bit 0) by default', () => {
    // PDRF 6/7 always carry GPS time, so the bit must be set, not left clear.
    expect(enc(writeLas14(sampleGlobal(), { epsg: 32611 })) & 0x1).toBe(1);
  });

  it('LAS 1.4 clears bit 0 when the caller opts into legacy GPS Week Time', () => {
    expect(enc(writeLas14(sampleGlobal(), { epsg: 32611, gpsStandardTime: false })) & 0x1).toBe(0);
  });

  it('LAS 1.2 sets bit 0 only when the chosen format carries GPS time', () => {
    // With gpsTime → format 1, bit 0 set; without → format 0, bit 0 clear.
    const withGps = writeLas(sampleGlobal({ gpsTime: Float64Array.from([1, 2, 3]) }));
    const noGps = writeLas(sampleGlobal());
    expect(enc(withGps) & 0x1).toBe(1);
    expect(enc(noGps) & 0x1).toBe(0);
  });

  it('LAS 1.2 honours gpsStandardTime: false even with GPS time present', () => {
    const las = writeLas(sampleGlobal({ gpsTime: Float64Array.from([1, 2, 3]) }), { gpsStandardTime: false });
    expect(enc(las) & 0x1).toBe(0);
  });
});

describe('writeLas14 header', () => {
  it('writes a LAS 1.4 header: version, 375-byte size, zero legacy counts, uint64 extended counts', () => {
    const g = sampleGlobal({
      returnNumber: Uint8Array.from([1, 2, 2]),
      returnCount: Uint8Array.from([2, 2, 2]),
    });
    const las = writeLas14(g, { epsg: 32611, isGeographic: false });
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);

    // Signature + version 1.4.
    expect(String.fromCharCode(las[0], las[1], las[2], las[3])).toBe('LASF');
    expect(view.getUint8(24)).toBe(1);
    expect(view.getUint8(25)).toBe(4);
    expect(view.getUint16(94, true)).toBe(375); // header size

    // Format 6 (no colour), 30-byte records.
    expect(view.getUint8(104)).toBe(6);
    expect(view.getUint16(105, true)).toBe(30);

    // Legacy point count + legacy by-return MUST be zero for formats 6+.
    expect(view.getUint32(107, true)).toBe(0);
    for (let r = 0; r < 5; r++) {
      expect(view.getUint32(111 + r * 4, true)).toBe(0);
    }

    // Extended counts: uint64 total at 247, 15 × uint64 by-return at 255.
    // returnNumber [1, 2, 2] → slot 0 (return 1) = 1, slot 1 (return 2) = 2.
    expect(view.getBigUint64(247, true)).toBe(3n);
    expect(view.getBigUint64(255, true)).toBe(1n);
    expect(view.getBigUint64(263, true)).toBe(2n);
    for (let r = 2; r < 15; r++) {
      expect(view.getBigUint64(255 + r * 8, true)).toBe(0n);
    }

    // Point data offset: 375-byte header + one GeoKey VLR. The VLR is a
    // 54-byte header + 8-byte GeoKey header + 2 keys × 8 bytes = 78 bytes.
    expect(view.getUint32(100, true)).toBe(1); // one VLR (GeoKeys, no WKT)
    expect(view.getUint32(96, true)).toBe(375 + 54 + 8 + 2 * 8); // 453
    // No WKT given → global-encoding WKT bit (bit 4) stays clear.
    expect(view.getUint16(6, true) & 0x10).toBe(0);

    // Returns above the extended 15-slot range clamp to the TOP slot, exactly
    // like the record field's Math.min(15, …) clamp — never into slot 1.
    // Hand-computed for [1, 16, 20]: slot 1 → 1, slot 15 → 2.
    const high = writeLas14(sampleGlobal({ returnNumber: Uint8Array.from([1, 16, 20]) }));
    const hv = new DataView(high.buffer, high.byteOffset, high.byteLength);
    expect(hv.getBigUint64(255, true)).toBe(1n); // return 1
    for (let r = 1; r < 14; r++) expect(hv.getBigUint64(255 + r * 8, true)).toBe(0n);
    expect(hv.getBigUint64(255 + 14 * 8, true)).toBe(2n); // returns 16+20 → slot 15

    // The app's own header parser agrees.
    const header = parseLasHeader(las.buffer as ArrayBuffer);
    expect(header.versionMinor).toBe(4);
    expect(header.pointFormat).toBe(6);
    expect(header.pointCount).toBe(3); // read from the extended uint64
    expect(header.offsetToPointData).toBe(453);
  });

  it('picks format 7 (36-byte records) when the cloud has colour, 6 otherwise', () => {
    expect(pickPointFormat14(sampleGlobal())).toBe(6);
    expect(pickPointFormat14(sampleGlobal({ colors: new Uint8Array(9) }))).toBe(7);

    const las = writeLas14(sampleGlobal({ colors: new Uint8Array(9) }));
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
    expect(view.getUint8(104)).toBe(7);
    expect(view.getUint16(105, true)).toBe(36);
    // No CRS at all → no VLRs, points start right after the 375-byte header.
    expect(view.getUint32(100, true)).toBe(0);
    expect(view.getUint32(96, true)).toBe(375);
  });

  it('writes an OGC WKT VLR and sets global-encoding bit 4 when WKT is supplied', async () => {
    const wkt = 'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84"],UNIT["metre",1],AUTHORITY["EPSG","32611"]]';
    const las = writeLas14(sampleGlobal(), { epsg: 32611, isGeographic: false, wkt });
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);

    expect(view.getUint16(6, true) & 0x10).toBe(0x10); // WKT bit set
    expect(view.getUint32(100, true)).toBe(1); // the WKT VLR replaces GeoKeys
    // Offset: 375 header + 54 VLR header + WKT chars + NUL terminator.
    expect(view.getUint32(96, true)).toBe(375 + 54 + wkt.length + 1);
    expect(view.getUint16(375 + 18, true)).toBe(2112); // record id: OGC WKT

    // The app's own CRS parser recovers the EPSG from the WKT payload.
    const out = await loadLas(las.buffer as ArrayBuffer, 'las', 'wkt14.las');
    expect(out.metadata?.crs?.source).toBe('wkt');
    expect(out.metadata?.crs?.epsg).toBe(32611);
  });
});

describe('writeLas14 round-trip (write → read back with loadLas)', () => {
  it('classes 64 and 200 survive exactly — the 1.2 5-bit-mask regression pin', async () => {
    const g = sampleGlobal({
      classification: Uint8Array.from([64, 200, 2]),
      intensity: Uint16Array.from([10, 20, 30]),
      pointSourceId: Uint16Array.from([7, 7, 8]),
    });
    const las = writeLas14(g);
    const out = await loadLas(las.buffer as ArrayBuffer, 'las', 'cls14.las');
    expect(out.pointCount).toBe(3);
    // The reader masks 0xff for formats 6+ — full 8-bit classes come back.
    expect(Array.from(out.classification ?? [])).toEqual([64, 200, 2]);
    expect(Array.from(out.intensity ?? [])).toEqual([10, 20, 30]);
    expect(Array.from(out.pointSourceId ?? [])).toEqual([7, 7, 8]);
  });

  it('recovers coordinates within the storage scale (mm for projected)', async () => {
    const g = sampleGlobal();
    const las = writeLas14(g, { epsg: 32611 });
    const out = await loadLas(las.buffer as ArrayBuffer, 'las', 'xyz14.las');
    expect(out.pointCount).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(out.positions[i * 3] + out.origin[0]).toBeCloseTo(g.x[i], 2); // ≤ 1 cm
      expect(out.positions[i * 3 + 1] + out.origin[1]).toBeCloseTo(g.y[i], 2);
      expect(out.positions[i * 3 + 2] + out.origin[2]).toBeCloseTo(g.z[i], 2);
    }
  });

  it('8-bit RGB → format 7 (×257 = v<<8|v) → reader high-byte narrowing → same 8-bit RGB', async () => {
    const colors = Uint8Array.from([255, 0, 0, 0, 255, 0, 8, 16, 32]);
    const g = sampleGlobal({ colors });
    const las = writeLas14(g);
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);

    // Byte level: first point's red channel at record offset 30 is 255 × 257.
    const pdo = view.getUint32(96, true);
    expect(view.getUint16(pdo + 30, true)).toBe(255 * 257); // 65535

    const out = await loadLas(las.buffer as ArrayBuffer, 'las', 'rgb14.las');
    expect(Array.from(out.colors ?? [])).toEqual(Array.from(colors));
  });

  it('return number/count map through the 4-bit extended fields', async () => {
    const g = sampleGlobal({
      returnNumber: Uint8Array.from([1, 2, 15]),
      returnCount: Uint8Array.from([2, 2, 15]),
    });
    const las = writeLas14(g);
    const out = await loadLas(las.buffer as ArrayBuffer, 'las', 'ret14.las');
    expect(Array.from(out.returnNumber ?? [])).toEqual([1, 2, 15]);
    expect(Array.from(out.returnCount ?? [])).toEqual([2, 2, 15]);
  });
});

describe('LAS 1.2 classification clamp warning (convertCloud)', () => {
  function cloudWithHighClasses(): PointCloud {
    return new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      origin: [500000, 4100000, 0],
      classification: Uint8Array.from([2, 64, 200]),
      sourceFormat: 'las',
      name: 'hi.las',
    });
  }

  it('warns per file when classes > 31 are clamped by the 1.2 writer', () => {
    const { report } = convertCloud(cloudWithHighClasses(), { format: 'las' });
    expect(report.ok).toBe(true);
    // 2 of the 3 points (classes 64 and 200) exceed the 5-bit field.
    expect(report.log).toContainEqual({
      level: 'warn',
      message: 'LAS 1.2 stores 5-bit classes — 2 points with classes > 31 were clamped; use LAS 1.4 to preserve them.',
    });
  });

  it('does not warn when no class exceeds 31, nor on the LAS 1.4 path', async () => {
    const low = convertCloud(
      new PointCloud({
        positions: Float32Array.from([0, 0, 0]),
        origin: [0, 0, 0],
        classification: Uint8Array.from([31]),
        sourceFormat: 'las',
        name: 'low.las',
      }),
      { format: 'las' },
    );
    expect(low.report.log.some((l) => l.level === 'warn')).toBe(false);

    // LAS 1.4 carries the full byte — no clamp, and the classes round-trip.
    const { file, report } = convertCloud(cloudWithHighClasses(), { format: 'las14' });
    expect(report.ok).toBe(true);
    expect(report.log.some((l) => l.level === 'warn')).toBe(false);
    const out = await loadLas(
      file!.bytes.buffer as ArrayBuffer,
      'las',
      file!.filename,
    );
    expect(Array.from(out.classification ?? [])).toEqual([2, 64, 200]);
  });

  it('the full orchestrator writes LAS 1.4 with the kept WKT CRS', () => {
    const wkt = 'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84"],UNIT["metre",1],AUTHORITY["EPSG","32611"]]';
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      origin: [500000, 4100000, 0],
      sourceFormat: 'las',
      name: 'crs.las',
      metadata: {
        crs: {
          source: 'wkt',
          wkt,
          name: 'WGS 84 / UTM zone 11N (EPSG:32611)',
          epsg: 32611,
          linearUnit: 'metre',
          linearUnitToMetres: 1,
          isGeographic: false,
        },
      },
    });
    const { file, report } = convertCloud(cloud, { format: 'las14', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    const view = new DataView(file!.bytes.buffer, file!.bytes.byteOffset, file!.bytes.byteLength);
    expect(view.getUint8(25)).toBe(4); // version 1.4
    expect(view.getUint16(6, true) & 0x10).toBe(0x10); // WKT bit carried through
  });
});
