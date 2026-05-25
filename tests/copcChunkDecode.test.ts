import { decodeRecords, chunkTransferables } from '../src/io/copc/copcChunkDecode';
import type { ChunkDecodeMetadata } from '../src/io/copc/copcChunkDecode';

interface RawRec {
  x: number;
  y: number;
  z: number;
  intensity: number;
  returnNum: number;
  returnCount: number;
  classification: number;
  gps: number;
  pointSourceId?: number;
  rgb?: [number, number, number];
}

/** Hand-build raw (decompressed) LAS PDRF 6/7 records. */
function buildRecords(recordLength: number, recs: RawRec[]): Uint8Array {
  const buf = new Uint8Array(recs.length * recordLength);
  const view = new DataView(buf.buffer);
  recs.forEach((r, i) => {
    const p = i * recordLength;
    view.setInt32(p, r.x, true);
    view.setInt32(p + 4, r.y, true);
    view.setInt32(p + 8, r.z, true);
    view.setUint16(p + 12, r.intensity, true);
    view.setUint8(p + 14, (r.returnNum & 0x0f) | ((r.returnCount & 0x0f) << 4));
    view.setUint8(p + 16, r.classification);
    view.setUint16(p + 20, r.pointSourceId ?? 0, true);
    view.setFloat64(p + 22, r.gps, true);
    if (r.rgb) {
      view.setUint16(p + 30, r.rgb[0], true);
      view.setUint16(p + 32, r.rgb[1], true);
      view.setUint16(p + 34, r.rgb[2], true);
    }
  });
  return buf;
}

test('decodeRecords applies the coordinate bridge and extracts PDRF 6 fields', () => {
  const raw = buildRecords(30, [
    { x: 1000, y: 2000, z: 3000, intensity: 555, returnNum: 1, returnCount: 2, classification: 5, gps: 12345.5, pointSourceId: 4242 },
    { x: -500, y: 0, z: 100, intensity: 10, returnNum: 2, returnCount: 2, classification: 2, gps: 7.25, pointSourceId: 7 },
  ]);
  const meta: ChunkDecodeMetadata = {
    pointDataRecordFormat: 6,
    pointRecordLength: 30,
    pointCount: 2,
    scale: [0.01, 0.01, 0.01],
    offset: [100, 200, 0],
    renderOrigin: [10, 20, 0],
  };
  const d = decodeRecords(raw, meta);
  expect(d.pointCount).toBe(2);
  // x = 1000·0.01 + 100 − 10 = 100; y = 2000·0.01 + 200 − 20 = 200; z = 30
  expect(d.positions[0]).toBeCloseTo(100);
  expect(d.positions[1]).toBeCloseTo(200);
  expect(d.positions[2]).toBeCloseTo(30);
  expect(d.intensity[0]).toBe(555);
  expect(d.returnNumber[0]).toBe(1);
  expect(d.returnCount[0]).toBe(2);
  expect(d.classification[0]).toBe(5);
  expect(d.gpsTime[0]).toBeCloseTo(12345.5);
  expect(d.gpsTime[1]).toBeCloseTo(7.25);
  expect(d.pointSourceId?.[0]).toBe(4242);
  expect(d.pointSourceId?.[1]).toBe(7);
  expect(d.rgb).toBeUndefined();
});

test('decodeRecords scales 16-bit PDRF 7 RGB down to 8-bit', () => {
  const raw = buildRecords(36, [
    { x: 0, y: 0, z: 0, intensity: 0, returnNum: 1, returnCount: 1, classification: 0, gps: 0, rgb: [65535, 32768, 256] },
  ]);
  const d = decodeRecords(raw, {
    pointDataRecordFormat: 7,
    pointRecordLength: 36,
    pointCount: 1,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
  });
  expect(d.rgb).toBeDefined();
  expect([...(d.rgb as Uint8Array)]).toEqual([255, 128, 1]);
});

test('decodeRecords treats an all-low-byte RGB chunk as 8-bit', () => {
  const raw = buildRecords(36, [
    { x: 0, y: 0, z: 0, intensity: 0, returnNum: 1, returnCount: 1, classification: 0, gps: 0, rgb: [200, 100, 50] },
  ]);
  const d = decodeRecords(raw, {
    pointDataRecordFormat: 7,
    pointRecordLength: 36,
    pointCount: 1,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
  });
  expect([...(d.rgb as Uint8Array)]).toEqual([200, 100, 50]);
});

test('decodeRecords clamps the point count when the buffer is short', () => {
  const raw = buildRecords(30, [
    { x: 0, y: 0, z: 0, intensity: 0, returnNum: 1, returnCount: 1, classification: 0, gps: 0 },
    { x: 0, y: 0, z: 0, intensity: 0, returnNum: 1, returnCount: 1, classification: 0, gps: 0 },
  ]);
  const d = decodeRecords(raw, {
    pointDataRecordFormat: 6,
    pointRecordLength: 30,
    pointCount: 50, // claims 50, buffer only holds 2
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
  });
  expect(d.pointCount).toBe(2);
  expect(d.positions).toHaveLength(6);
});

test('chunkTransferables lists every backing buffer (and RGB only when present)', () => {
  const raw6 = buildRecords(30, [
    { x: 0, y: 0, z: 0, intensity: 0, returnNum: 1, returnCount: 1, classification: 0, gps: 0 },
  ]);
  const d6 = decodeRecords(raw6, {
    pointDataRecordFormat: 6,
    pointRecordLength: 30,
    pointCount: 1,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
  });
  // positions, intensity, classification, returnNumber, returnCount, gpsTime,
  // pointSourceId — seven buffers, no RGB for PDRF 6.
  expect(chunkTransferables(d6)).toHaveLength(7);

  const raw7 = buildRecords(36, [
    { x: 0, y: 0, z: 0, intensity: 0, returnNum: 1, returnCount: 1, classification: 0, gps: 0, rgb: [1, 2, 3] },
  ]);
  const d7 = decodeRecords(raw7, {
    pointDataRecordFormat: 7,
    pointRecordLength: 36,
    pointCount: 1,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
  });
  // The seven PDRF-6 buffers plus RGB.
  expect(chunkTransferables(d7)).toHaveLength(8);
});
