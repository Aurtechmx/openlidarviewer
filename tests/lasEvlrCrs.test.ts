/**
 * lasEvlrCrs.test.ts: LAS 1.4 files whose CRS lives only in an extended VLR.
 *
 * The fixtures (`scripts/gen-evlr-crs-fixture.ts`) carry no CRS VLR; their one
 * LASF_Projection/2112 record is an EVLR after the point data, holding a
 * compound WKT (NAD83(2011) / UTM zone 15N + NAVD88 height, metres). Before the
 * EVLR walk existed they opened with no CRS, no units and no vertical datum.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bufferRangeReader,
  collectVlrProjectionRecords,
  crsFromProjectionRecords,
  emptyProjectionRecords,
  readEvlrProjectionRecords,
  resolveLasCrs,
  resolveLasCrsFromRange,
  readLasCrsLocation,
  MAX_EVLRS_WALKED,
  MAX_PROJECTION_EVLR_BYTES,
} from '../src/io/crs';
import { parseLasHeader } from '../src/io/lasHeader';
import { loadLas, loadLazFromFile } from '../src/io/loadLas';
import { convertCloud } from '../src/convert/convertCloud';
import { writeLas14 } from '../src/convert/writeLas';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { CopcSource } from '../src/io/copc/CopcSource';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';

const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const expectUtm15Navd88 = (crs: ReturnType<typeof crsFromProjectionRecords> | undefined): void => {
  expect(crs?.source).toBe('wkt');
  expect(crs?.epsg).toBe(6344);
  expect(crs?.isGeographic).toBe(false);
  expect(crs?.linearUnit).toBe('metre');
  expect(crs?.linearUnitToMetres).toBe(1);
  expect(crs?.verticalEpsg).toBe(5703);
  expect(crs?.verticalDatum).toMatch(/NAVD88/);
  expect(crs?.verticalLinearUnit).toBe('metre');
  expect(crs?.horizontalDatum).toBe('NAD83(2011)');
};

/** A minimal EVLR: 60-byte header then payload. */
function evlr(userId: string, recordId: number, payload: Uint8Array, declaredLength?: bigint): Uint8Array {
  const out = new Uint8Array(60 + payload.length);
  const v = new DataView(out.buffer);
  for (let i = 0; i < userId.length; i++) out[2 + i] = userId.charCodeAt(i);
  v.setUint16(18, recordId, true);
  v.setBigUint64(20, declaredLength ?? BigInt(payload.length), true);
  out.set(payload, 60);
  return out;
}
const ascii = (s: string): Uint8Array => Uint8Array.from([...s, '\0'].map((c) => c.charCodeAt(0)));
const concat = (...parts: Uint8Array[]): ArrayBuffer => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
};
const WKT_A = 'PROJCS["NAD83(2011) / UTM zone 15N",GEOGCS["NAD83(2011)"],UNIT["metre",1],AUTHORITY["EPSG","6344"]]';
const WKT_B = 'PROJCS["WGS 84 / UTM zone 13N",GEOGCS["WGS 84"],UNIT["metre",1],AUTHORITY["EPSG","32613"]]';

describe('LAS 1.4 header exposes the EVLR block', () => {
  it('reads the first-EVLR offset and count, and finds no CRS in the VLRs alone', () => {
    const buf = fixture('evlr-crs-utm15.las');
    const h = parseLasHeader(buf);
    expect(h.versionMinor).toBe(4);
    expect(h.pointFormat).toBe(6);
    expect(h.evlrCount).toBe(1);
    expect(h.evlrOffset).toBeGreaterThan(h.offsetToPointData);
    expect(h.crs).toBeNull();
    expect(new DataView(buf).getUint16(6, true) & 0x10).toBe(0x10);
  });
});

describe('loading a file whose CRS is only in an EVLR', () => {
  it('LAS: resolves the compound CRS, horizontal and vertical', async () => {
    const cloud = await loadLas(fixture('evlr-crs-utm15.las'), 'las', 'evlr.las');
    expectUtm15Navd88(cloud.metadata?.crs);
  });

  it('LAZ from a buffer: resolves the same CRS', async () => {
    const cloud = await loadLas(fixture('evlr-crs-utm15.laz'), 'laz', 'evlr.laz');
    expectUtm15Navd88(cloud.metadata?.crs);
  });

  it('LAZ from a File: reads the EVLR with a bounded range read, not the whole file', async () => {
    const bytes = fixture('evlr-crs-utm15.laz');
    const file = new File([bytes], 'evlr.laz');
    let stats: { metadataBytes: number; rangeRequests: number } | undefined;
    const cloud = await loadLazFromFile(file, 'evlr.laz', 1, undefined, undefined, (s) => { stats = s; });
    expectUtm15Navd88(cloud.metadata?.crs);
    expect(cloud.positions.length).toBe(400 * 3);
    expect(stats?.rangeRequests).toBeGreaterThanOrEqual(3);
  });
});

describe('EVLR walk: bounds and caps', () => {
  it('skips a non-projection EVLR by its header and reads the one after it', async () => {
    const big = new Uint8Array(4096);
    const file = concat(new Uint8Array(100), evlr('LASF_Spec', 65000, big), evlr('LASF_Projection', 2112, ascii(WKT_A)));
    const reads: Array<[number, number]> = [];
    const read = bufferRangeReader(file);
    const rec = await readEvlrProjectionRecords(
      (o, l) => { reads.push([o, l]); return read(o, l); }, file.byteLength, 100, 2,
    );
    expect(crsFromProjectionRecords(rec)?.epsg).toBe(6344);
    // The 4 KiB waveform-like payload is never read.
    expect(reads.every(([, l]) => l !== 4096)).toBe(true);
  });

  it('refuses a projection record larger than the cap without reading it', async () => {
    const header = evlr('LASF_Projection', 2112, new Uint8Array(0), BigInt(MAX_PROJECTION_EVLR_BYTES + 1));
    const reads: number[] = [];
    const fileSize = 100 + 60 + MAX_PROJECTION_EVLR_BYTES + 1;
    const file = concat(new Uint8Array(100), header);
    const read = bufferRangeReader(file);
    const rec = await readEvlrProjectionRecords((o, l) => { reads.push(l); return read(o, l); }, fileSize, 100, 1);
    expect(rec.wkt).toBeNull();
    expect(Math.max(...reads)).toBe(60);
  });

  it('stops at a declared length that runs past the file end', async () => {
    const file = concat(new Uint8Array(100), evlr('LASF_Projection', 2112, ascii(WKT_A), 1n << 40n));
    const rec = await readEvlrProjectionRecords(bufferRangeReader(file), file.byteLength, 100, 1);
    expect(rec.wkt).toBeNull();
  });

  it('walks at most MAX_EVLRS_WALKED headers whatever the declared count', async () => {
    const one = evlr('Other', 1, new Uint8Array(0));
    const file = concat(new Uint8Array(100), ...Array.from({ length: MAX_EVLRS_WALKED + 10 }, () => one));
    let calls = 0;
    const read = bufferRangeReader(file);
    await readEvlrProjectionRecords((o, l) => { calls++; return read(o, l); }, file.byteLength, 100, 0xffffffff);
    expect(calls).toBe(MAX_EVLRS_WALKED);
  });

  it('ignores an offset past the file end and a truncated header', async () => {
    const file = concat(new Uint8Array(100), evlr('LASF_Projection', 2112, ascii(WKT_A)).subarray(0, 30));
    expect((await readEvlrProjectionRecords(bufferRangeReader(file), file.byteLength, 100, 1)).wkt).toBeNull();
    expect((await readEvlrProjectionRecords(bufferRangeReader(file), file.byteLength, 10_000, 1)).wkt).toBeNull();
  });

  it('keeps the VLR result when the EVLR read throws', async () => {
    const vlrs = fixture('evlr-crs-utm15.las');
    const h = parseLasHeader(vlrs);
    const crs = await resolveLasCrs(vlrs, h.headerSize!, h.vlrCount!, h, () => Promise.reject(new Error('io')), vlrs.byteLength);
    expect(crs).toBeNull();
  });
});

describe('EVLR vs VLR precedence', () => {
  it('a VLR WKT outranks an EVLR WKT', async () => {
    const records = emptyProjectionRecords();
    records.wkt = WKT_B; // as if collected from a VLR first
    const file = concat(new Uint8Array(100), evlr('LASF_Projection', 2112, ascii(WKT_A)));
    await readEvlrProjectionRecords(bufferRangeReader(file), file.byteLength, 100, 1, records);
    expect(crsFromProjectionRecords(records)?.epsg).toBe(32613);
  });

  it('an EVLR WKT outranks VLR GeoKeys, as WKT does within the VLRs', async () => {
    // A writer's own 1.4 file: GeoKeys VLR (32613) and the WKT placed in an EVLR.
    const las = writeLas14(
      { count: 1, x: Float64Array.of(500000), y: Float64Array.of(4100000), z: Float64Array.of(1) },
      { epsg: 32613, isGeographic: false, linearUnitCode: 9001 },
    );
    const h = parseLasHeader(las.buffer as ArrayBuffer);
    const records = collectVlrProjectionRecords(las.buffer as ArrayBuffer, h.headerSize!, h.vlrCount!);
    expect(crsFromProjectionRecords(records)?.epsg).toBe(32613);
    const file = concat(new Uint8Array(100), evlr('LASF_Projection', 2112, ascii(WKT_A)));
    await readEvlrProjectionRecords(bufferRangeReader(file), file.byteLength, 100, 1, records);
    expect(crsFromProjectionRecords(records)?.epsg).toBe(6344);
  });
});

describe('export round trip: read, export, re-read gives the same CRS', () => {
  it('LAS 1.4 export carries the WKT as a VLR with the WKT bit set', async () => {
    const cloud = await loadLas(fixture('evlr-crs-utm15.las'), 'las', 'evlr.las');
    const { file } = convertCloud(cloud, { format: 'las14', crsMode: 'keep' });
    expect(file).not.toBeNull();
    const out = file!.bytes.buffer.slice(file!.bytes.byteOffset, file!.bytes.byteOffset + file!.bytes.byteLength) as ArrayBuffer;
    const h = parseLasHeader(out);
    expect(new DataView(out).getUint16(6, true) & 0x10).toBe(0x10);
    // The CRS now sits in the VLRs, readable without the EVLR walk.
    expectUtm15Navd88(h.crs);
    const again = await loadLas(out, 'las', 'again.las');
    expectUtm15Navd88(again.metadata?.crs);
  });

  it('LAS 1.2 export carries the horizontal EPSG and vertical datum as GeoKeys', async () => {
    const cloud = await loadLas(fixture('evlr-crs-utm15.las'), 'las', 'evlr.las');
    const { file } = convertCloud(cloud, { format: 'las', crsMode: 'keep' });
    expect(file).not.toBeNull();
    const out = file!.bytes.buffer.slice(file!.bytes.byteOffset, file!.bytes.byteOffset + file!.bytes.byteLength) as ArrayBuffer;
    const crs = parseLasHeader(out).crs;
    expect(crs?.epsg).toBe(6344);
    expect(crs?.linearUnit).toBe('metre');
    expect(crs?.verticalEpsg).toBe(5703);
  });
});

describe('the record kind that carried the CRS', () => {
  it('marks a CRS read from an EVLR and leaves a VLR CRS unmarked', async () => {
    const cloud = await loadLas(fixture('evlr-crs-utm15.las'), 'las', 'evlr.las');
    expect(cloud.metadata?.crs?.record).toBe('evlr');
    const las = writeLas14(
      { count: 1, x: Float64Array.of(500000), y: Float64Array.of(4100000), z: Float64Array.of(1) },
      { epsg: 32613, isGeographic: false, linearUnitCode: 9001 },
    );
    const h = parseLasHeader(las.buffer as ArrayBuffer);
    expect(h.crs?.epsg).toBe(32613);
    expect(h.crs?.record).toBeUndefined();
  });

  it('a VLR WKT that outranks an EVLR WKT stays a VLR CRS', async () => {
    const records = emptyProjectionRecords();
    records.wkt = WKT_B;
    const file = concat(new Uint8Array(100), evlr('LASF_Projection', 2112, ascii(WKT_A)));
    await readEvlrProjectionRecords(bufferRangeReader(file), file.byteLength, 100, 1, records);
    expect(crsFromProjectionRecords(records)?.record).toBeUndefined();
  });

  it('resolves an EVLR CRS to the las-evlr source; other sources are unchanged', async () => {
    const cloud = await loadLas(fixture('evlr-crs-utm15.las'), 'las', 'evlr.las');
    const info = cloud.metadata?.crs ?? undefined;
    expect(resolvedFromCrsInfo(info, 'las-vlr')?.source).toBe('las-evlr');
    expect(resolvedFromCrsInfo(info, 'copc-meta')?.source).toBe('copc-meta');
    expect(resolvedFromCrsInfo({ ...info!, record: undefined }, 'las-vlr')?.source).toBe('las-vlr');
  });
});

describe('CRS over a range source (out-of-core and COPC opens)', () => {
  it('resolves the EVLR CRS from a LAZ without reading the point data', async () => {
    const bytes = fixture('evlr-crs-utm15.laz');
    const h = parseLasHeader(bytes);
    const reads: Array<[number, number]> = [];
    const read = bufferRangeReader(bytes);
    const crs = await resolveLasCrsFromRange((o, l) => { reads.push([o, l]); return read(o, l); }, bytes.byteLength);
    expectUtm15Navd88(crs);
    expect(crs?.record).toBe('evlr');
    for (const [o, l] of reads) {
      const inPointData = o < h.evlrOffset! && o + l > h.offsetToPointData;
      expect(inPointData).toBe(false);
    }
  });

  it('returns null for bytes that are not LAS and for a failing reader', async () => {
    expect(readLasCrsLocation(new ArrayBuffer(400))).toBeNull();
    expect(await resolveLasCrsFromRange(bufferRangeReader(new ArrayBuffer(400)), 400)).toBeNull();
    expect(await resolveLasCrsFromRange(() => Promise.reject(new Error('io')), 400)).toBeNull();
  });

  it('a COPC file with its CRS in an EVLR after the hierarchy gets that CRS', async () => {
    const synth = buildSyntheticCopc();
    const base = new Uint8Array(synth.buffer);
    const extra = evlr('LASF_Projection', 2112, ascii(WKT_A));
    const out = new Uint8Array(base.length + extra.length);
    out.set(base);
    out.set(extra, base.length);
    const view = new DataView(out.buffer);
    view.setUint32(243, view.getUint32(243, true) + 1, true);
    const source = await CopcSource.open(new ArrayBufferRangeSource(out.buffer));
    expect(source.metadata.header.crs?.epsg).toBe(6344);
    expect(source.metadata.header.crs?.record).toBe('evlr');
  });
});
