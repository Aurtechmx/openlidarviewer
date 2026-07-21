/**
 * las14WktConformance.test.ts — the bytes a strict LAS 1.4 reader looks at.
 *
 * Reproduces the defect found in a real export: a 47.9 M point UAV scan
 * georeferenced to EPSG:32629 by a GeoTIFF GeoKey VLR came back out as LAS
 * 1.4 point format 7 carrying GeoKeys and global-encoding bit 4 clear. LAS
 * 1.4 R15 requires the CRS as OGC WKT for formats 6-10, so a strict reader is
 * entitled to treat that file as unreferenced.
 *
 * These assertions parse the header rather than the writer's inputs, because
 * the defect was invisible from the call site — every code passed in was
 * correct and the file was still non-conformant.
 */

import { describe, it, expect } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import { wktForEpsg } from '../src/io/epsgWkt';
import type { GlobalPoints } from '../src/convert/globalPoints';

const GLOBAL_ENCODING_WKT = 0x10;
const HEADER_SIZE_14 = 375;

function points(): GlobalPoints {
  return {
    count: 2,
    x: Float64Array.from([517084.786, 517243.59]),
    y: Float64Array.from([4645003.452, 4645195.65]),
    z: Float64Array.from([58.718, 94.769]),
  } as unknown as GlobalPoints;
}

/** Walk the VLRs the way a reader does, from the header's own counts. */
function readVlrs(bytes: Uint8Array): Array<{ userId: string; recordId: number; payload: string }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(100, true);
  const out = [];
  let p = HEADER_SIZE_14;
  for (let i = 0; i < count; i++) {
    const userId = new TextDecoder().decode(bytes.subarray(p + 2, p + 18)).replace(/\0+$/, '');
    const recordId = view.getUint16(p + 18, true);
    const len = view.getUint16(p + 20, true);
    const payload = new TextDecoder().decode(bytes.subarray(p + 54, p + 54 + len)).replace(/\0+$/, '');
    out.push({ userId, recordId, payload });
    p += 54 + len;
  }
  return out;
}

describe('LAS 1.4 CRS conformance', () => {
  it('writes WKT and sets bit 4 for a UTM code with no source WKT', () => {
    const bytes = writeLas14(points(), {
      epsg: 32629,
      linearUnitCode: 9001,
      wkt: wktForEpsg(32629),
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 6 without colour, 7 with it — the WKT requirement covers 6-10 alike, so
    // the condition to assert is the record family, not one member of it.
    expect(view.getUint8(104)).toBeGreaterThanOrEqual(6);
    expect(view.getUint8(104)).toBeLessThanOrEqual(10);
    expect(view.getUint16(6, true) & GLOBAL_ENCODING_WKT).toBe(GLOBAL_ENCODING_WKT);

    const vlrs = readVlrs(bytes);
    const wktVlr = vlrs.find((v) => v.recordId === 2112);
    expect(wktVlr, 'a 2112 WKT record must be present').toBeDefined();
    expect(wktVlr!.userId).toBe('LASF_Projection');
    expect(wktVlr!.payload).toContain('AUTHORITY["EPSG","32629"]');
    expect(wktVlr!.payload).toContain('central_meridian",-9]');

    // The GeoKey tag is the fallback, not a companion — emitting both invites
    // a reader to pick the one we did not intend.
    expect(vlrs.some((v) => v.recordId === 34735)).toBe(false);
  });

  it('still falls back to GeoKeys, honestly, when no WKT can be derived', () => {
    // ETRS89 / UTM 29N: same projection, different datum, not ours to guess.
    const bytes = writeLas14(points(), {
      epsg: 25829,
      linearUnitCode: 9001,
      wkt: wktForEpsg(25829),
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(view.getUint16(6, true) & GLOBAL_ENCODING_WKT).toBe(0);
    const vlrs = readVlrs(bytes);
    expect(vlrs.some((v) => v.recordId === 2112)).toBe(false);
    expect(vlrs.some((v) => v.recordId === 34735)).toBe(true);
  });

  it('keeps the WKT payload inside the VLR length it declared', () => {
    const bytes = writeLas14(points(), { epsg: 32729, wkt: wktForEpsg(32729) });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declared = view.getUint16(HEADER_SIZE_14 + 20, true);
    const pointOffset = view.getUint32(96, true);
    expect(HEADER_SIZE_14 + 54 + declared).toBeLessThanOrEqual(pointOffset);
    expect(readVlrs(bytes)[0].payload).toContain('false_northing",10000000]');
  });
});
