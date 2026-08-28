/**
 * decodePeakMemoryModel.test.ts — the decode-memory guards must bound the TRUE
 * coexisting peak, not just the first decode phase or a single allocation.
 *
 * A release audit found three admissible-but-oversized paths the existing guards
 * let through, plus one error-shape bug:
 *
 *   1. COPC — the guard charged only laz-perf phase 1 (2·Bc + B_raw). The second
 *      phase (decodeRecords) coexists Bc + B_raw + B_channels, where B_channels
 *      is a second B_raw-sized copy, and was unbounded.
 *   2. EPT binary — the tile-body cap bounds the raw body but not the decoded
 *      channel arrays that fill while the body is still resident.
 *   3a. PNTS — the mobile decoded ceiling counted only the decoded channels, not
 *      the raw tile body that coexists with them.
 *   3b. Unknown-length bodies concatenate chunks and peak at ~2x during the join,
 *      so a 256 MiB unknown-length body could need ~512 MiB to assemble.
 *
 * Every case pins an input the OLD guard admits and the NEW guard refuses.
 */

import { describe, test, expect } from 'vitest';
import {
  decompressChunk,
  estimateCopcPeakBytes,
} from '../src/io/copc/copcChunkDecompress';
import { copcDecodedChannelBytes } from '../src/io/copc/copcChunkDecode';
import type { ChunkDecodeMetadata } from '../src/io/copc/copcChunkDecode';
import {
  MAX_DECODE_PEAK_BYTES,
  withinDecodePeakBudget,
} from '../src/io/heavy/heavyByteBudget';
import {
  decodeEptBinaryTile,
  eptBinaryPeakBytes,
} from '../src/io/ept/eptBinaryDecode';
import type { EptSchemaField } from '../src/io/ept/eptTypes';
import { parsePnts } from '../src/io/tiles3d/pnts';
import { readAtMostBounded, MAX_UNKNOWN_LENGTH_BODY_BYTES } from '../src/io/range/boundedRead';
import { BoundedReadError } from '../src/io/range/boundedRead';
import { LoadError } from '../src/io/loadErrors';

const MiB = 1024 * 1024;

// ── BLOCKER 1 — COPC second decode phase ─────────────────────────────────────

describe('COPC estimateCopcPeakBytes — the second decode phase is bounded', () => {
  const META = (over: Partial<ChunkDecodeMetadata> = {}): ChunkDecodeMetadata => ({
    pointDataRecordFormat: 7,
    pointRecordLength: 36,
    pointCount: 3_000_000,
    scale: [0.01, 0.01, 0.01],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
    ...over,
  });

  // PDRF 7, 3,000,000 points, 36-byte records, 70 MiB compressed chunk.
  const COMPRESSED = 70 * MiB;
  const POINTS = 3_000_000;

  test('the concrete case passes the OLD phase-1-only guard', () => {
    // OLD guard = 2·Bc + B_raw (JS compressed + WASM compressed + raw records).
    // 2·70 + ~103 = ~243 MiB, under the 256 MiB budget.
    const phase1Only = withinDecodePeakBudget(
      COMPRESSED,
      POINTS,
      36,
      0,
      COMPRESSED,
      MAX_DECODE_PEAK_BYTES,
    );
    expect(phase1Only).toBe(true);
  });

  test('the NEW two-phase estimate refuses it on phase 2', () => {
    // NEW = max(phase1, phase2). Phase 2 = Bc + B_raw + B_channels =
    // 70 + ~103 + ~103 = ~276 MiB, over the 256 MiB budget.
    const peak = estimateCopcPeakBytes(META(), COMPRESSED, POINTS);
    expect(peak).toBeGreaterThan(MAX_DECODE_PEAK_BYTES);
    // And the excess is the decoded channel arrays, not a mistaken double-count
    // of the compressed bytes.
    const phase2 = COMPRESSED + POINTS * 36 + copcDecodedChannelBytes(7, POINTS);
    expect(peak).toBe(phase2);
  });

  test('PDRF 7 channel bytes are 36/point (27 base + 9 for staged+narrowed RGB)', () => {
    expect(copcDecodedChannelBytes(7, 1)).toBe(36);
    expect(copcDecodedChannelBytes(6, 1)).toBe(27);
    expect(copcDecodedChannelBytes(8, 1)).toBe(36);
  });

  test('decompressChunk refuses the node BEFORE any _malloc or decode', () => {
    // A lazPerf stub whose every entry point throws: reaching it would prove the
    // guard ran too late. The guard must throw the budget LoadError first.
    const trap = () => {
      throw new Error('laz-perf was touched — guard ran too late');
    };
    const lazPerfTrap = {
      _malloc: trap,
      _free: trap,
      HEAPU8: new Uint8Array(0),
      ChunkDecoder: function ChunkDecoder() {
        trap();
      },
    } as unknown as Parameters<typeof decompressChunk>[0];

    // A real 70 MiB compressed buffer backs the 3M declared points (floor
    // 36/50 = 0.72 B/pt admits ~101M, so the count is plausible for the bytes).
    const chunk = new Uint8Array(COMPRESSED);
    let thrown: unknown;
    try {
      decompressChunk(lazPerfTrap, chunk, META());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LoadError);
    expect((thrown as LoadError).message).toMatch(/decode budget/i);
    expect((thrown as LoadError).message).not.toMatch(/laz-perf was touched/);
  });

  test('a node that fits both phases is admitted by the estimate', () => {
    // 500k PDRF-7 points, 12 MiB compressed: phase1 = 24 + 17.2 = 41.2 MiB,
    // phase2 = 12 + 17.2 + 17.2 = 46.4 MiB — both well under budget.
    const peak = estimateCopcPeakBytes(META({ pointCount: 500_000 }), 12 * MiB, 500_000);
    expect(peak).toBeLessThan(MAX_DECODE_PEAK_BYTES);
  });
});

// ── BLOCKER 2 — EPT binary decoded-peak ──────────────────────────────────────

describe('EPT binary decode — the decoded arrays are bounded with the body', () => {
  // A wide schema at ~31 raw bytes a point: XYZ int32 (12), Intensity u16 (2),
  // Classification/ReturnNumber/NumberOfReturns u8 (3), GpsTime f64 (8),
  // RGB u16 (6). Stride 31.
  const WIDE: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Y', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Z', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Intensity', size: 2, type: 'unsigned' },
    { name: 'Classification', size: 1, type: 'unsigned' },
    { name: 'ReturnNumber', size: 1, type: 'unsigned' },
    { name: 'NumberOfReturns', size: 1, type: 'unsigned' },
    { name: 'GpsTime', size: 8, type: 'float' },
    { name: 'Red', size: 2, type: 'unsigned' },
    { name: 'Green', size: 2, type: 'unsigned' },
    { name: 'Blue', size: 2, type: 'unsigned' },
  ];
  const STRIDE = 31;

  test('the peak charges body + every decoded channel + rgb16 staging', () => {
    // Per point decoded: positions 12 + intensity 2 + class 1 + retNum 1 +
    // retCnt 1 + gps 8 + rgb 3 = 28, plus 6 for the uniform-16-bit rgb16 staging.
    const bodyBytes = 100 * STRIDE;
    const peak = eptBinaryPeakBytes(bodyBytes, 100, {
      intensity: true,
      classification: true,
      returnNumber: true,
      returnCount: true,
      gpsTime: true,
      rgb: true,
      rgb16Staging: true,
    });
    expect(peak).toBe(bodyBytes + 100 * (28 + 6));
  });

  test('a wide-schema tile over the budget is refused before typed-array allocation', () => {
    // 4,200,000 points × 31 raw = ~124 MiB body. Peak = body + decoded(28) +
    // rgb16(6) = 65 B/point = ~273 MiB, over the 256 MiB budget. The body alone
    // is well under the transport tile cap, so only the decoded-peak guard stops
    // it. We pass the shared budget explicitly and confirm the throw.
    const points = 4_200_000;
    expect(points * 65).toBeGreaterThan(MAX_DECODE_PEAK_BYTES);
    expect(points * STRIDE).toBeLessThan(MAX_DECODE_PEAK_BYTES);

    // The guard runs before allocation, so a tile buffer that is too SHORT for
    // the schema would normally throw the truncation error first; the peak guard
    // must fire ahead of both the length check's allocation and the arrays. Give
    // it an exact-size body so the only refusal available is the peak one.
    const body = new ArrayBuffer(points * STRIDE);
    let thrown: unknown;
    try {
      decodeEptBinaryTile(body, points, WIDE, [0, 0, 0]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LoadError);
    expect((thrown as LoadError).category).toBe('memory-constraint');
    expect((thrown as LoadError).message).toMatch(/decode budget/i);
  });

  test('a small tile of the same schema still decodes', () => {
    const points = 4;
    const body = new ArrayBuffer(points * STRIDE);
    const decoded = decodeEptBinaryTile(body, points, WIDE, [0, 0, 0]);
    expect(decoded.pointCount).toBe(points);
    expect(decoded.positions.length).toBe(points * 3);
  });
});

// ── BLOCKER 3a — PNTS total peak (body + decoded) ────────────────────────────

describe('PNTS decode — the admission is a total peak, not decoded bytes alone', () => {
  /** A valid position-only PNTS tile carrying its float32 POSITION binary. */
  function positionOnlyPnts(points: number): ArrayBuffer {
    const HEADER = 28;
    const featureTable = JSON.stringify({ POINTS_LENGTH: points, POSITION: { byteOffset: 0 } });
    const padded = featureTable.padEnd(Math.ceil(featureTable.length / 4) * 4, ' ');
    const ftJson = new TextEncoder().encode(padded);
    const ftBinLen = points * 12; // Float32 · 3
    const buffer = new ArrayBuffer(HEADER + ftJson.length + ftBinLen);
    const view = new DataView(buffer);
    view.setUint32(0, 0x73746e70, true); // "pnts"
    view.setUint32(4, 1, true);
    view.setUint32(8, buffer.byteLength, true);
    view.setUint32(12, ftJson.length, true);
    view.setUint32(16, ftBinLen, true);
    view.setUint32(20, 0, true);
    view.setUint32(24, 0, true);
    new Uint8Array(buffer, HEADER, ftJson.length).set(ftJson);
    // Binary stays zero-filled: valid float32 zeros, a legitimate tile.
    return buffer;
  }

  const POINTS = 100_000;

  test('decoded-only would admit, but body + decoded exceeds the budget', () => {
    const tile = positionOnlyPnts(POINTS);
    const decodedBytes = POINTS * 12; // positions only
    const bodyBytes = tile.byteLength; // ~= decodedBytes + header/json
    // A budget above decoded alone but below the true peak — the exact gap the
    // old decoded-only check ignored.
    const budget = decodedBytes + Math.floor(bodyBytes / 2);
    expect(decodedBytes).toBeLessThan(budget); // OLD (decoded-only) admits
    expect(bodyBytes + decodedBytes).toBeGreaterThan(budget); // NEW (peak) refuses

    expect(() => parsePnts(tile, { maxDecodedBytes: budget })).toThrow(/decoded byte/i);
  });

  test('a budget above the whole peak still decodes the tile', () => {
    const tile = positionOnlyPnts(POINTS);
    const peak = tile.byteLength + POINTS * 12;
    const decoded = parsePnts(tile, { maxDecodedBytes: peak + 1024 });
    expect(decoded.pointsLength).toBe(POINTS);
  });
});

// ── BLOCKER 3b — unknown-length assembly ceiling ─────────────────────────────

describe('readAtMostBounded — unknown-length bodies held below the peak policy', () => {
  /** A streaming Response with no Content-Length, emitting `chunks` in order. */
  function unknownLengthResponse(chunks: Uint8Array[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return new Response(body, { headers: {} });
  }

  test('an unknown-length body above 64 MiB is refused even when maxBytes is 256 MiB', async () => {
    // Two 40 MiB chunks: 80 MiB total, under the caller's 256 MiB ceiling but
    // over the 64 MiB unknown-length ceiling that keeps the ~2x join in policy.
    const chunk = new Uint8Array(40 * MiB);
    const response = unknownLengthResponse([chunk, new Uint8Array(40 * MiB)]);
    let thrown: unknown;
    try {
      await readAtMostBounded(response, 256 * MiB, 'EPT tile', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BoundedReadError);
    expect((thrown as BoundedReadError).message).toMatch(/unknown-length limit/i);
    expect(MAX_UNKNOWN_LENGTH_BODY_BYTES).toBe(64 * MiB);
  });

  test('an unknown-length body under the ceiling still reads', async () => {
    const response = unknownLengthResponse([new Uint8Array(8 * MiB), new Uint8Array(8 * MiB)]);
    const bytes = await readAtMostBounded(response, 256 * MiB, 'EPT tile', {});
    expect(bytes.byteLength).toBe(16 * MiB);
  });

  test('an honest identity Content-Length keeps the large streaming fast path', async () => {
    // 80 MiB declared honestly: the declared-length branch streams into one
    // exact target and never touches the unknown-length ceiling.
    const size = 80 * MiB;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    });
    const response = new Response(body, { headers: { 'content-length': String(size) } });
    const bytes = await readAtMostBounded(response, 256 * MiB, 'EPT tile', {});
    expect(bytes.byteLength).toBe(size);
  });
});

// ── SMALL BUG — Content-Length 0 with a stray body byte ──────────────────────

describe('readAtMostBounded — Content-Length 0 with a stray byte', () => {
  test('surfaces the bounded-read error, not a raw RangeError from .set()', async () => {
    // declared === 0 takes the declared-length branch and allocates
    // Uint8Array(0). The `filled + value.byteLength > declared` check must fire
    // before ensureCapacity/out.set, so a stray byte is the typed
    // "sent more than its declared" refusal, not a generic RangeError.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x42]));
        controller.close();
      },
    });
    const response = new Response(body, { headers: { 'content-length': '0' } });
    let thrown: unknown;
    try {
      await readAtMostBounded(response, 16 * MiB, 'EPT manifest', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BoundedReadError);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect((thrown as BoundedReadError).message).toMatch(/declared/i);
  });
});
