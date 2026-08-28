/**
 * chunkedLazDecodePeak.test.ts — the LAZ window plan bounds the TOTAL simultaneous
 * decode, not just each allocation individually.
 *
 * The chunk-table cap, the per-chunk compressed/decoded caps, and the window-span
 * cap each bound ONE allocation. But a window decode holds several at once — the
 * compressed span, the raw decoded records, and the packed tile records — so the
 * summed peak can reach several hundred megabytes while every single piece stays
 * under its own cap. These cases pin the total-peak budget: a window whose summed
 * peak (span + decoded + packed) exceeds MAX_DECODE_PEAK_BYTES shrinks to fewer
 * chunks, and a single chunk whose own summed peak is over the total budget is
 * flagged even though its decoded bytes alone are within the per-chunk cap.
 */
import { describe, it, expect } from 'vitest';
import { planChunkWindow, MAX_LAZ_WINDOW_SPAN_BYTES } from '../src/io/heavy/chunkedLazSource';
import type { LazChunkRange } from '../src/io/heavy/lazChunkTable';
import {
  MAX_DECODE_PEAK_BYTES,
  MAX_DECODED_ALLOCATION_BYTES,
  withinDecodePeakBudget,
  withinDecodedByteBudget,
} from '../src/io/heavy/heavyByteBudget';

const MiB = 1024 * 1024;

describe('planChunkWindow — total simultaneous-decode peak budget', () => {
  it('shrinks a window whose span + decoded + packed exceeds the total peak, below what the individual caps allow', () => {
    // Two chunks. Each on its own is legal under every individual cap; together
    // their span (124 MiB < 128) and decoded (120 MiB < 128) both pass, but the
    // summed peak span+decoded+packed = 268 MiB is over the 256 MiB total.
    const recordLength = 1000;
    const packedRecordBytes = 200;
    const pointsPerChunk = 60_000; // decoded 60 MiB, packed 12 MiB per chunk
    const spanPerChunk = 62 * MiB;

    const chunks: LazChunkRange[] = [];
    let off = 0;
    for (let i = 0; i < 4; i++) {
      chunks.push({ byteOffset: off, byteLength: spanPerChunk, pointCount: pointsPerChunk, firstPointIndex: i * pointsPerChunk });
      off += spanPerChunk;
    }

    // Two chunks stay under the span and decoded caps individually.
    expect(2 * spanPerChunk).toBeLessThan(MAX_LAZ_WINDOW_SPAN_BYTES);
    expect(withinDecodedByteBudget(2 * pointsPerChunk, recordLength)).toBe(true);
    // With the packed records counted, the summed peak (~261 MiB) exceeds the
    // total, so the plan takes only one chunk.
    const plan = planChunkWindow(chunks, 0, 4, recordLength, packedRecordBytes);
    expect(plan.end).toBe(1);

    // Dropping only the packed term leaves span+decoded (~238 MiB) under the total,
    // so the span cap admits two — the packed allocation is exactly what tips the
    // joint peak over budget and forces the shrink to one.
    const withoutPacked = planChunkWindow(chunks, 0, 4, recordLength, 0);
    expect(withoutPacked.end).toBe(2);
  });

  it('flags a single chunk whose own summed peak is over the total budget though its decoded bytes pass the per-chunk cap', () => {
    const recordLength = 1000;
    const packedRecordBytes = 250;
    const points = 120_000; // decoded 120 MiB (< 128 cap), packed 30 MiB
    const span = 120 * MiB;

    // Decoded alone is within the per-chunk decoded cap.
    expect(withinDecodedByteBudget(points, recordLength, MAX_DECODED_ALLOCATION_BYTES)).toBe(true);
    // The simultaneous total (span + decoded + packed = 270 MiB) is over budget.
    expect(withinDecodePeakBudget(span, points, recordLength, packedRecordBytes)).toBe(false);
    expect(MAX_DECODE_PEAK_BYTES).toBe(256 * MiB);
  });

  it('admits an ordinary window well under the total peak', () => {
    const recordLength = 30;
    const packedRecordBytes = 26;
    const chunks: LazChunkRange[] = [];
    let off = 0;
    for (let i = 0; i < 8; i++) {
      chunks.push({ byteOffset: off, byteLength: 300_000, pointCount: 50_000, firstPointIndex: i * 50_000 });
      off += 300_000;
    }
    const plan = planChunkWindow(chunks, 0, 4, recordLength, packedRecordBytes);
    expect(plan.end).toBe(4); // the requested window; nowhere near any cap
  });
});
