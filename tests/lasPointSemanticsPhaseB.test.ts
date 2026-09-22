/**
 * lasPointSemanticsPhaseB.test.ts
 *
 * Scan angle, user data, scanner channel, scan direction and edge-of-flight-
 * line, decoded the same way `classificationFlags` was: one shared helper in
 * `lasDecodeShared.ts` for the bit/unit logic, called by the static LAS/LAZ
 * decoder, COPC, EPT laszip and (where the schema carries the attribute) EPT
 * binary, and merged into the resident snapshot under the same all-or-nothing
 * rule as every other per-point channel.
 *
 * Scan angle needs a unit conversion the other four don't: legacy records
 * (PDRF 0-5) hold a signed int8 "scan angle rank" at byte 16, already whole
 * degrees; extended records (PDRF 6-10) hold a signed int16 "scan angle" at
 * byte 18, in units of 0.006°. Both land in one Float32Array of degrees.
 * Scan direction and edge-of-flight-line share bit 6 / bit 7 in both layouts,
 * but the SOURCE byte differs: the legacy return-bits byte at 14, or the
 * extended flags byte at 15. Scanner channel (bits 4-5 of the extended flags
 * byte) has no legacy equivalent at all, so it is `undefined` for a
 * legacy-format file rather than a zero-filled array.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  decodeContext,
  decodeRecord,
  allocRawPoints,
  scanAngleToDegrees,
  extractBitFlag,
  extractScannerChannel,
} from '../src/io/lasDecodeShared';
import type { LasHeader } from '../src/io/lasHeader';
import { decodeRecords } from '../src/io/copc/copcChunkDecode';
import type { ChunkDecodeMetadata, DecodedChunk } from '../src/io/copc/copcChunkDecode';
import { decodeEptLaszipTile } from '../src/io/ept/eptLaszipDecode';
import { decodeEptBinaryTile } from '../src/io/ept/eptBinaryDecode';
import type { EptSchemaField } from '../src/io/ept/eptTypes';
import { buildResidentSnapshot } from '../src/render/streaming/residentSnapshot';
import { parseLasHeader } from '../src/io/lasHeader';
import { parseBuffer } from '../src/io/parseBuffer';
import { loadLas } from '../src/io/loadLas';
import { PointCloud } from '../src/model/PointCloud';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_BYTES = readFileSync(join(FIXTURES, 'withheld-flags.las'));
const FIXTURE_BUF = FIXTURE_BYTES.buffer.slice(
  FIXTURE_BYTES.byteOffset,
  FIXTURE_BYTES.byteOffset + FIXTURE_BYTES.byteLength,
);

const header = (pointFormat: number): LasHeader =>
  ({
    pointFormat,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    pointDataRecordLength: pointFormat >= 6 ? 30 : 20,
  }) as unknown as LasHeader;

/** One record wide enough for either layout, with a byte set at `at`. */
function record(at: number, value: number): DataView {
  const buf = new ArrayBuffer(64);
  new DataView(buf).setUint8(at, value);
  return new DataView(buf);
}

/** One record with a signed int16 written at `at`, little-endian. */
function recordInt16(at: number, value: number): DataView {
  const buf = new ArrayBuffer(64);
  new DataView(buf).setInt16(at, value, true);
  return new DataView(buf);
}

describe('scanAngleToDegrees', () => {
  it('passes legacy int8 rank values through unchanged (already whole degrees)', () => {
    expect(scanAngleToDegrees(-90, false)).toBe(-90);
    expect(scanAngleToDegrees(90, false)).toBe(90);
    expect(scanAngleToDegrees(0, false)).toBe(0);
  });

  it('scales extended int16 values by the 0.006° LSB', () => {
    // -15000 * 0.006 = -90 exactly.
    expect(scanAngleToDegrees(-15000, true)).toBeCloseTo(-90, 10);
    expect(scanAngleToDegrees(15000, true)).toBeCloseTo(90, 10);
    expect(scanAngleToDegrees(0, true)).toBe(0);
  });
});

describe('extractBitFlag / extractScannerChannel', () => {
  it('reads an isolated bit at any position', () => {
    expect(extractBitFlag(0b0100_0000, 6)).toBe(1);
    expect(extractBitFlag(0b1000_0000, 7)).toBe(1);
    expect(extractBitFlag(0b0011_1111, 6)).toBe(0);
    expect(extractBitFlag(0b0111_1111, 7)).toBe(0);
  });

  it('reads scanner channel from bits 4-5', () => {
    expect(extractScannerChannel(0b0000_0000)).toBe(0);
    expect(extractScannerChannel(0b0001_0000)).toBe(1);
    expect(extractScannerChannel(0b0010_0000)).toBe(2);
    expect(extractScannerChannel(0b0011_0000)).toBe(3);
    // Bits outside 4-5 (classification flags, direction, edge) don't leak in.
    expect(extractScannerChannel(0b1100_1111)).toBe(0);
  });
});

describe('allocRawPoints: pointSemantics default off', () => {
  it('leaves all five gated channels null when pointSemantics is not requested', () => {
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended);
    expect(out.scanAngle).toBeNull();
    expect(out.userData).toBeNull();
    expect(out.scannerChannel).toBeNull();
    expect(out.scanDirection).toBeNull();
    expect(out.edgeOfFlightLine).toBeNull();
  });

  it('decodeRecord leaves classificationFlags filled either way — that channel is not gated', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended);
    decodeRecord(record(15, 0x80), 0, 0, ctx, out);
    expect(out.classificationFlags[0]).toBe(0x4); // Withheld, legacy bit 7
  });
});

describe('decodeRecord: legacy layout (PDRF 0-5)', () => {
  it('reads the scan angle rank at byte 16 as whole degrees, negative included', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    const buf = new ArrayBuffer(64);
    new DataView(buf).setInt8(16, -90);
    decodeRecord(new DataView(buf), 0, 0, ctx, out);
    expect((out.scanAngle as Float32Array)[0]).toBe(-90);
  });

  it('reads user data at byte 17', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    decodeRecord(record(17, 200), 0, 0, ctx, out);
    expect((out.userData as Uint8Array)[0]).toBe(200);
  });

  it('reads scan direction from bit 6 and edge-of-flight-line from bit 7 of the return-bits byte', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    decodeRecord(record(14, 0b1100_0000), 0, 0, ctx, out);
    expect((out.scanDirection as Uint8Array)[0]).toBe(1);
    expect((out.edgeOfFlightLine as Uint8Array)[0]).toBe(1);
  });

  it('reports no scan direction / edge flag when both bits are clear', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    decodeRecord(record(14, 0b0011_1111), 0, 0, ctx, out);
    expect((out.scanDirection as Uint8Array)[0]).toBe(0);
    expect((out.edgeOfFlightLine as Uint8Array)[0]).toBe(0);
  });

  it('has no scanner channel — legacy carries none, even with pointSemantics on', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    expect(out.scannerChannel).toBeNull();
  });
});

describe('decodeRecord: extended layout (PDRF 6-10)', () => {
  it('reads the scan angle at byte 18 as an int16 in 0.006° units, negative included', () => {
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    decodeRecord(recordInt16(18, -15000), 0, 0, ctx, out);
    expect((out.scanAngle as Float32Array)[0]).toBeCloseTo(-90, 10);
  });

  it('reads user data at byte 17', () => {
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    decodeRecord(record(17, 200), 0, 0, ctx, out);
    expect((out.userData as Uint8Array)[0]).toBe(200);
  });

  it('reads scan direction from bit 6 and edge-of-flight-line from bit 7 of the flags byte', () => {
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    decodeRecord(record(15, 0b1100_0000), 0, 0, ctx, out);
    expect((out.scanDirection as Uint8Array)[0]).toBe(1);
    expect((out.edgeOfFlightLine as Uint8Array)[0]).toBe(1);
  });

  it('reads scanner channel from bits 4-5 of the flags byte, independent of the classification-flag nibble', () => {
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false, false, ctx.extended, { pointSemantics: true });
    // Channel 2 (bit 5) plus every classification flag (bits 0-3) set.
    decodeRecord(record(15, 0b0010_1111), 0, 0, ctx, out);
    expect(out.scannerChannel).not.toBeNull();
    expect((out.scannerChannel as Uint8Array)[0]).toBe(2);
    expect(out.classificationFlags[0]).toBe(0xf);
  });
});

describe('real fixture round trip: withheld-flags.las (PDRF 6), compared per index', () => {
  async function staticAttrs(): Promise<{
    scanAngle: Float32Array;
    userData: Uint8Array;
    scannerChannel: Uint8Array | undefined;
    scanDirection: Uint8Array;
    edgeOfFlightLine: Uint8Array;
  }> {
    // pointSemantics: true — the 6th positional parameter of loadLas. Going
    // through loadLas directly (not parseBuffer's plan-less generic-loader
    // path, which does not thread pointSemantics — only its LAS/LAZ
    // preflight-plan fast path does).
    const cloud = await loadLas(FIXTURE_BUF.slice(0), 'las', 'withheld-flags.las', 1, undefined, true);
    expect(cloud.scanAngle).toBeTruthy();
    expect(cloud.userData).toBeTruthy();
    expect(cloud.scanDirection).toBeTruthy();
    expect(cloud.edgeOfFlightLine).toBeTruthy();
    return {
      scanAngle: cloud.scanAngle as Float32Array,
      userData: cloud.userData as Uint8Array,
      scannerChannel: cloud.scannerChannel,
      scanDirection: cloud.scanDirection as Uint8Array,
      edgeOfFlightLine: cloud.edgeOfFlightLine as Uint8Array,
    };
  }

  it('COPC decodeRecords matches the static decode index-for-index', async () => {
    const header0 = parseLasHeader(FIXTURE_BUF);
    const raw = new Uint8Array(
      FIXTURE_BUF,
      header0.offsetToPointData,
      header0.pointCount * header0.pointDataRecordLength,
    );
    const meta: ChunkDecodeMetadata = {
      pointDataRecordFormat: header0.pointFormat,
      pointRecordLength: header0.pointDataRecordLength,
      pointCount: header0.pointCount,
      scale: header0.scale,
      offset: header0.offset,
      renderOrigin: [0, 0, 0],
      pointSemantics: true,
    };
    const decoded = decodeRecords(raw, meta);
    const expected = await staticAttrs();

    expect(decoded.scanAngle).toBeTruthy();
    expect(decoded.userData).toBeTruthy();
    expect(decoded.scannerChannel).toBeTruthy();
    expect(decoded.scanDirection).toBeTruthy();
    expect(decoded.edgeOfFlightLine).toBeTruthy();

    expect([...(decoded.scanAngle as Float32Array)]).toEqual([...expected.scanAngle]);
    expect([...(decoded.userData as Uint8Array)]).toEqual([...expected.userData]);
    expect([...(decoded.scannerChannel as Uint8Array)]).toEqual([...(expected.scannerChannel as Uint8Array)]);
    expect([...(decoded.scanDirection as Uint8Array)]).toEqual([...expected.scanDirection]);
    expect([...(decoded.edgeOfFlightLine as Uint8Array)]).toEqual([...expected.edgeOfFlightLine]);
  });

  it('COPC decodeRecords leaves all five undefined when pointSemantics is off (default)', () => {
    const header0 = parseLasHeader(FIXTURE_BUF);
    const raw = new Uint8Array(
      FIXTURE_BUF,
      header0.offsetToPointData,
      header0.pointCount * header0.pointDataRecordLength,
    );
    const meta: ChunkDecodeMetadata = {
      pointDataRecordFormat: header0.pointFormat,
      pointRecordLength: header0.pointDataRecordLength,
      pointCount: header0.pointCount,
      scale: header0.scale,
      offset: header0.offset,
      renderOrigin: [0, 0, 0],
    };
    const decoded = decodeRecords(raw, meta);
    expect(decoded.scanAngle).toBeUndefined();
    expect(decoded.userData).toBeUndefined();
    expect(decoded.scannerChannel).toBeUndefined();
    expect(decoded.scanDirection).toBeUndefined();
    expect(decoded.edgeOfFlightLine).toBeUndefined();
    // classificationFlags is unaffected — always decoded.
    expect(decoded.classificationFlags).toBeTruthy();
  });

  it('EPT laszip decode matches the static decode index-for-index', async () => {
    const decoded = await decodeEptLaszipTile(FIXTURE_BUF, [0, 0, 0], undefined, true);
    const expected = await staticAttrs();

    expect([...(decoded.scanAngle as Float32Array)]).toEqual([...expected.scanAngle]);
    expect([...(decoded.userData as Uint8Array)]).toEqual([...expected.userData]);
    expect([...(decoded.scannerChannel as Uint8Array)]).toEqual([...(expected.scannerChannel as Uint8Array)]);
    expect([...(decoded.scanDirection as Uint8Array)]).toEqual([...expected.scanDirection]);
    expect([...(decoded.edgeOfFlightLine as Uint8Array)]).toEqual([...expected.edgeOfFlightLine]);
  });

  it('EPT laszip decode leaves all five undefined when pointSemantics is off (default)', async () => {
    const decoded = await decodeEptLaszipTile(FIXTURE_BUF, [0, 0, 0]);
    expect(decoded.scanAngle).toBeUndefined();
    expect(decoded.userData).toBeUndefined();
    expect(decoded.scannerChannel).toBeUndefined();
    expect(decoded.scanDirection).toBeUndefined();
    expect(decoded.edgeOfFlightLine).toBeUndefined();
  });
});

describe('EPT laszip: scanner channel is undefined for a legacy-format tile', () => {
  it('decodes a PDRF 1 tile with no scanner channel (pointSemantics on)', async () => {
    const legacyBytes = readFileSync(join(FIXTURES, 'tiny-pdrf1.laz'));
    // tiny-pdrf1.laz is compressed; the laszip decoder handles LAZ tiles the
    // same as LAS ones (it detects compression from the header), so feed it
    // the raw bytes directly.
    const buf = legacyBytes.buffer.slice(
      legacyBytes.byteOffset,
      legacyBytes.byteOffset + legacyBytes.byteLength,
    );
    const decoded = await decodeEptLaszipTile(buf, [0, 0, 0], undefined, true);
    expect(decoded.scannerChannel).toBeUndefined();
    // The other four channels are structural in every supported format.
    expect(decoded.scanAngle).toBeTruthy();
    expect(decoded.userData).toBeTruthy();
    expect(decoded.scanDirection).toBeTruthy();
    expect(decoded.edgeOfFlightLine).toBeTruthy();
  });
});

describe('EPT binary: each new channel is undefined when the schema omits it', () => {
  const SCHEMA_FULL: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Y', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Z', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'ScanAngleRank', size: 4, type: 'float' },
    { name: 'UserData', size: 1, type: 'unsigned' },
    { name: 'ScanChannel', size: 1, type: 'unsigned' },
    { name: 'ScanDirectionFlag', size: 1, type: 'unsigned' },
    { name: 'EdgeOfFlightLine', size: 1, type: 'unsigned' },
  ];
  const SCHEMA_XYZ_ONLY: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Y', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Z', size: 4, type: 'signed', scale: 0.01, offset: 0 },
  ];

  function packFull(rows: { scanAngle: number; userData: number; channel: number; dir: number; edge: number }[]): ArrayBuffer {
    const stride = 12 + 4 + 1 + 1 + 1 + 1;
    const buffer = new ArrayBuffer(stride * rows.length);
    const view = new DataView(buffer);
    rows.forEach((r, i) => {
      const base = i * stride;
      view.setInt32(base, 0, true);
      view.setInt32(base + 4, 0, true);
      view.setInt32(base + 8, 0, true);
      view.setFloat32(base + 12, r.scanAngle, true);
      view.setUint8(base + 16, r.userData);
      view.setUint8(base + 17, r.channel);
      view.setUint8(base + 18, r.dir);
      view.setUint8(base + 19, r.edge);
    });
    return buffer;
  }

  it('reads every channel the schema declares, when pointSemantics is on', () => {
    const rows = [
      { scanAngle: -12.5, userData: 7, channel: 2, dir: 1, edge: 0 },
      { scanAngle: 30, userData: 9, channel: 0, dir: 0, edge: 1 },
    ];
    const buf = packFull(rows);
    // pointSemantics is the 7th positional parameter (after maxPeakBytes).
    const decoded = decodeEptBinaryTile(buf, rows.length, SCHEMA_FULL, [0, 0, 0], undefined, undefined, true);
    expect([...(decoded.scanAngle as Float32Array)]).toEqual(rows.map((r) => r.scanAngle));
    expect([...(decoded.userData as Uint8Array)]).toEqual(rows.map((r) => r.userData));
    expect([...(decoded.scannerChannel as Uint8Array)]).toEqual(rows.map((r) => r.channel));
    expect([...(decoded.scanDirection as Uint8Array)]).toEqual(rows.map((r) => r.dir));
    expect([...(decoded.edgeOfFlightLine as Uint8Array)]).toEqual(rows.map((r) => r.edge));
  });

  it('leaves every new channel undefined when the schema declares only X/Y/Z', () => {
    const buf = new ArrayBuffer(12 * 2);
    const decoded = decodeEptBinaryTile(buf, 2, SCHEMA_XYZ_ONLY, [0, 0, 0], undefined, undefined, true);
    expect(decoded.scanAngle).toBeUndefined();
    expect(decoded.userData).toBeUndefined();
    expect(decoded.scannerChannel).toBeUndefined();
    expect(decoded.scanDirection).toBeUndefined();
    expect(decoded.edgeOfFlightLine).toBeUndefined();
  });

  it('leaves every new channel undefined when pointSemantics is off, even though the schema declares them all', () => {
    const rows = [{ scanAngle: -12.5, userData: 7, channel: 2, dir: 1, edge: 0 }];
    const buf = packFull(rows);
    // pointSemantics omitted — default off, despite SCHEMA_FULL declaring
    // every attribute. The source having the data and the caller asking for
    // it are two different facts.
    const decoded = decodeEptBinaryTile(buf, rows.length, SCHEMA_FULL, [0, 0, 0]);
    expect(decoded.scanAngle).toBeUndefined();
    expect(decoded.userData).toBeUndefined();
    expect(decoded.scannerChannel).toBeUndefined();
    expect(decoded.scanDirection).toBeUndefined();
    expect(decoded.edgeOfFlightLine).toBeUndefined();
  });
});

describe('resident snapshot: the new channels merge under the all-or-nothing rule', () => {
  function chunkOf(n: number, fill: Partial<DecodedChunk>): DecodedChunk {
    return { pointCount: n, positions: new Float32Array(n * 3), ...fill };
  }

  const OPTS = { origin: [0, 0, 0] as [number, number, number], name: 'scan.copc', sourceFormat: 'laz' as const };

  it('merges scanAngle / userData / scannerChannel / scanDirection / edgeOfFlightLine across resident chunks', () => {
    const a = chunkOf(2, {
      scanAngle: Float32Array.from([-10, 5]),
      userData: Uint8Array.from([1, 2]),
      scannerChannel: Uint8Array.from([0, 1]),
      scanDirection: Uint8Array.from([0, 1]),
      edgeOfFlightLine: Uint8Array.from([1, 0]),
    });
    const b = chunkOf(1, {
      scanAngle: Float32Array.from([20]),
      userData: Uint8Array.from([3]),
      scannerChannel: Uint8Array.from([2]),
      scanDirection: Uint8Array.from([1]),
      edgeOfFlightLine: Uint8Array.from([0]),
    });
    const cloud = buildResidentSnapshot([a, b], OPTS);
    expect(cloud).not.toBeNull();
    expect([...(cloud!.scanAngle as Float32Array)]).toEqual([-10, 5, 20]);
    expect([...(cloud!.userData as Uint8Array)]).toEqual([1, 2, 3]);
    expect([...(cloud!.scannerChannel as Uint8Array)]).toEqual([0, 1, 2]);
    expect([...(cloud!.scanDirection as Uint8Array)]).toEqual([0, 1, 1]);
    expect([...(cloud!.edgeOfFlightLine as Uint8Array)]).toEqual([1, 0, 0]);
  });

  it('omits scannerChannel when only SOME resident chunks carry it (e.g. a legacy EPT tile mixed with an extended one)', () => {
    const withChannel = chunkOf(1, { scannerChannel: Uint8Array.from([1]) });
    const withoutChannel = chunkOf(1, {});
    const cloud = buildResidentSnapshot([withChannel, withoutChannel], OPTS);
    expect(cloud).not.toBeNull();
    expect(cloud!.scannerChannel).toBeUndefined();
  });
});

describe('worker payload: the five gated channels being undefined is fine end-to-end', () => {
  it('parseBuffer with pointSemantics off produces a cloud with all five undefined', async () => {
    // pointSemantics omitted (8th positional parameter) — default off.
    const { cloud } = await parseBuffer(FIXTURE_BUF.slice(0), 'las', 'withheld-flags.las');
    expect(cloud.scanAngle).toBeUndefined();
    expect(cloud.userData).toBeUndefined();
    expect(cloud.scannerChannel).toBeUndefined();
    expect(cloud.scanDirection).toBeUndefined();
    expect(cloud.edgeOfFlightLine).toBeUndefined();
    // classificationFlags is unaffected by the switch — still decoded.
    expect(cloud.classificationFlags).toBeTruthy();
  });

  it('the worker payload/transfer-list fields (workerPayloadParity.test.ts) round-trip undefined cleanly', () => {
    // `new PointCloud(payload)` — the same call the worker reply resolves
    // through — must accept every one of the five fields as undefined
    // without throwing, exactly like every other optional PointCloudOptions
    // channel. This is the runtime half of what
    // tests/workerPayloadParity.test.ts checks statically (that the field
    // NAMES survive the worker boundary); this checks the VALUES survive a
    // reconstruction when they are absent.
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'x.las',
      scanAngle: undefined,
      userData: undefined,
      scannerChannel: undefined,
      scanDirection: undefined,
      edgeOfFlightLine: undefined,
    });
    expect(cloud.scanAngle).toBeUndefined();
    expect(cloud.userData).toBeUndefined();
    expect(cloud.scannerChannel).toBeUndefined();
    expect(cloud.scanDirection).toBeUndefined();
    expect(cloud.edgeOfFlightLine).toBeUndefined();
  });
});
