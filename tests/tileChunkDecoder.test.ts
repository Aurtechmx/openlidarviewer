/**
 * tileChunkDecoder.test.ts — the tile decode seam produces a valid DecodedChunk.
 *
 * Records are packed the way the indexer writes them, then run through the
 * ChunkDecoder the streaming scheduler would call. The decoded chunk must carry
 * every field back exactly, positions copied without any transform, and the two
 * optional fields (GPS time, RGB) must follow the schema: present and exact when
 * the tile has them, zero-filled / absent when it does not.
 */
import { describe, it, expect } from 'vitest';
import type { RawPoints } from '../src/io/lasDecodeShared';
import {
  packTileRecord,
  tileRecordBytes,
  type TileSchema,
} from '../src/io/heavy/tileRecord';
import { TileChunkDecoder } from '../src/io/heavy/tileChunkDecoder';
import type { ChunkDecodeMetadata } from '../src/io/copc/copcChunkDecode';

function rawCloud(n: number, schema: TileSchema): RawPoints {
  const positions = new Float32Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const pointSourceId = new Uint16Array(n);
  const gpsTime = schema.hasGps ? new Float64Array(n) : null;
  const colors = schema.hasRgb ? new Uint8Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    positions[i * 3] = 100 + i * 0.5;
    positions[i * 3 + 1] = -50 + i * 0.25;
    positions[i * 3 + 2] = i * 0.1;
    intensity[i] = (i * 7) & 0xffff;
    classification[i] = (i % 32) + 1;
    returnCount[i] = (i % 4) + 1;
    returnNumber[i] = (i % returnCount[i]) + 1;
    pointSourceId[i] = (i % 500) + 1;
    if (gpsTime) gpsTime[i] = 1000 + i * 0.001;
    if (colors) {
      colors[i * 3] = i & 0xff;
      colors[i * 3 + 1] = (i * 3) & 0xff;
      colors[i * 3 + 2] = (i * 5) & 0xff;
    }
  }
  return { positions, intensity, classification, returnNumber, returnCount, pointSourceId, gpsTime, colors, colors16: null };
}

function packTile(raw: RawPoints, n: number, schema: TileSchema): { bytes: Uint8Array; recordBytes: number } {
  const recordBytes = tileRecordBytes(schema);
  const bytes = new Uint8Array(n * recordBytes);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) packTileRecord(raw, i, schema, view, i * recordBytes);
  return { bytes, recordBytes };
}

function meta(pointCount: number, recordBytes: number): ChunkDecodeMetadata {
  // scale/offset/renderOrigin are ignored by the tile decoder (positions are
  // already source-local); present because the interface requires them.
  return {
    pointDataRecordFormat: 7,
    pointRecordLength: recordBytes,
    pointCount,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
  };
}

describe('TileChunkDecoder', () => {
  it('reinterprets an attribute-rich tile into a DecodedChunk', async () => {
    const n = 200;
    const schema: TileSchema = { hasGps: true, hasRgb: true };
    const raw = rawCloud(n, schema);
    const { bytes, recordBytes } = packTile(raw, n, schema);
    expect(recordBytes).toBe(30);

    const decoder = new TileChunkDecoder(schema, recordBytes);
    const dc = await decoder.decode(bytes.buffer as ArrayBuffer, meta(n, recordBytes));

    expect(dc.pointCount).toBe(n);
    expect(dc.positions).toEqual(raw.positions); // copied, no transform
    expect(dc.intensity).toEqual(raw.intensity);
    expect(dc.classification).toEqual(raw.classification);
    expect(dc.returnNumber).toEqual(raw.returnNumber);
    expect(dc.returnCount).toEqual(raw.returnCount);
    expect(dc.pointSourceId).toEqual(raw.pointSourceId);
    expect(dc.gpsTime).toEqual(raw.gpsTime);
    expect(dc.rgb).toEqual(raw.colors);
    expect(dc.rgbEightBit).toBe(true);
  });

  it('zero-fills gps and omits rgb for a bare tile', async () => {
    const n = 64;
    const schema: TileSchema = { hasGps: false, hasRgb: false };
    const raw = rawCloud(n, schema);
    const { bytes, recordBytes } = packTile(raw, n, schema);
    expect(recordBytes).toBe(19);

    const decoder = new TileChunkDecoder(schema, recordBytes);
    const dc = await decoder.decode(bytes.buffer as ArrayBuffer, meta(n, recordBytes));

    expect(dc.pointCount).toBe(n);
    expect(dc.positions).toEqual(raw.positions);
    expect(dc.gpsTime).toEqual(new Float64Array(n)); // required field, zero-filled
    expect(dc.rgb).toBeUndefined();
    expect(dc.rgbEightBit).toBeUndefined();
  });

  it('honours an aborted signal and refuses a truncated tile', async () => {
    const n = 10;
    const schema: TileSchema = { hasGps: true, hasRgb: false };
    const { bytes, recordBytes } = packTile(rawCloud(n, schema), n, schema);
    const decoder = new TileChunkDecoder(schema, recordBytes);

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(decoder.decode(bytes.buffer as ArrayBuffer, meta(n, recordBytes), ctrl.signal)).rejects.toThrow();

    // A tile with only half its records present is a corrupt store, not a smaller
    // valid one: the hierarchy declares n points, so a tile short of n × recordBytes
    // is refused as a fault rather than decoded as a sparse tile.
    const half = bytes.subarray(0, 5 * recordBytes);
    await expect(
      decoder.decode(half.slice().buffer as ArrayBuffer, meta(n, recordBytes)),
    ).rejects.toThrow(/truncated or corrupt/);
  });
});
