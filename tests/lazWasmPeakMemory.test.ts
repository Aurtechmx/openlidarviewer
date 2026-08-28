/**
 * lazWasmPeakMemory.test.ts — the decode peak model charges laz-perf's WASM copy
 * of the compressed input.
 *
 * Every laz-perf decode path (EPT laszip tile, COPC node, local windowed LAZ
 * chunk) stages `_malloc(compressed.byteLength)` + `HEAPU8.set(compressed, ptr)`
 * before it reads the first point, so the JS-side compressed buffer AND its WASM
 * duplicate are live at once — two compressed copies, not one. The old peak
 * formula (P = span + decoded + packed) charged the compressed bytes a single
 * time and understated the real peak by a whole compressed copy, admitting
 * payloads whose true 2·Bc + Bd working set blows the 256 MiB ceiling.
 *
 * These cases pin the corrected model:
 *   1. the formula itself now includes the WASM copy (red-green vs the old form);
 *   2. a COPC node whose decoded bytes pass the per-node cap but whose 2·Bc + Bd
 *      peak is over budget is refused BEFORE any WASM allocation;
 *   3. the local windowed path feeds the decoder a VIEW into its span (no third
 *      compressed copy) and the bytes handed to laz-perf are byte-identical to the
 *      old `span.slice(...)`.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_DECODE_PEAK_BYTES,
  MAX_DECODED_ALLOCATION_BYTES,
  decodePeakBytesFor,
  withinDecodePeakBudget,
  withinDecodedByteBudget,
} from '../src/io/heavy/heavyByteBudget';
import { decompressChunk, type LazPerfModule } from '../src/io/copc/copcChunkDecompress';
import type { ChunkDecodeMetadata } from '../src/io/copc/copcChunkDecode';

const MiB = 1024 * 1024;

describe('decode peak model — laz-perf WASM compressed copy', () => {
  it('charges the WASM compressed copy on top of the span (formula red-green)', () => {
    // A tile that the OLD single-copy formula admits under the 256 MiB ceiling but
    // whose real 2·Bc + Bd working set is over it. Bc compressed, Bd decoded.
    const Bc = 130 * MiB;
    const Bd = 120 * MiB;
    const recordLength = 30;
    const pointCount = Bd / recordLength;

    // Decoded alone is within the per-allocation cap — this is not a decoded-cap
    // refusal, it is a peak refusal.
    expect(withinDecodedByteBudget(pointCount, recordLength, MAX_DECODED_ALLOCATION_BYTES)).toBe(true);

    // OLD model (no WASM term): span + decoded = 250 MiB ≤ 256 → admitted.
    expect(decodePeakBytesFor(Bc, pointCount, recordLength, 0, 0)).toBe(Bc + Bd);
    expect(withinDecodePeakBudget(Bc, pointCount, recordLength, 0, 0)).toBe(true);

    // WASM-aware model: span + WASM copy + decoded = 380 MiB > 256 → refused.
    expect(decodePeakBytesFor(Bc, pointCount, recordLength, 0, Bc)).toBe(2 * Bc + Bd);
    expect(withinDecodePeakBudget(Bc, pointCount, recordLength, 0, Bc)).toBe(false);
  });

  it('a nonsense WASM copy size reads as over-budget, never as zero', () => {
    expect(withinDecodePeakBudget(1000, 10, 4, 0, Number.NaN)).toBe(false);
    expect(withinDecodePeakBudget(1000, 10, 4, 0, -1)).toBe(false);
    expect(decodePeakBytesFor(1000, 10, 4, 0, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

// --- COPC node peak refusal, through the real decompressChunk ----------------

/** A laz-perf stand-in that records every `_malloc`, so a refusal can be proven
 *  to happen before any WASM allocation. */
function watchedLazPerf(): { module: LazPerfModule; mallocs: number[] } {
  const mallocs: number[] = [];
  const module = {
    _malloc: (n: number) => {
      mallocs.push(n);
      return 1;
    },
    _free: () => {},
    HEAPU8: new Uint8Array(16),
    ChunkDecoder: class {
      open(): void {}
      getPoint(): void {}
      delete(): void {}
    },
  } as unknown as LazPerfModule;
  return { module, mallocs };
}

const copcMeta = (recordLength: number, pointCount: number): ChunkDecodeMetadata => ({
  pointDataRecordFormat: 7,
  pointRecordLength: recordLength,
  pointCount,
  scale: [1, 1, 1],
  offset: [0, 0, 0],
  renderOrigin: [0, 0, 0],
});

describe('decompressChunk — COPC node peak refusal', () => {
  it('refuses a node whose decoded bytes pass the per-node cap but whose 2·Bc + Bd peak is over budget', () => {
    const { module, mallocs } = watchedLazPerf();
    const recordLength = 65535;
    const pointCount = 2000; // decoded ≈ 125 MiB, under the 128 MiB per-node cap
    const Bd = pointCount * recordLength;
    expect(withinDecodedByteBudget(pointCount, recordLength, MAX_DECODED_ALLOCATION_BYTES)).toBe(true);

    // A 66 MiB compressed chunk: on its own the decoded guard admits this node,
    // but 2·Bc + Bd ≈ 257 MiB exceeds the 256 MiB peak.
    const compressedBytes = 66 * MiB;
    expect(2 * compressedBytes + Bd).toBeGreaterThan(MAX_DECODE_PEAK_BYTES);
    const chunk = new ArrayBuffer(compressedBytes);

    expect(() => decompressChunk(module, chunk, copcMeta(recordLength, pointCount))).toThrow(
      /peak|compressed copies/,
    );
    // The refusal fired before either the compressed or the point malloc.
    expect(mallocs).toHaveLength(0);
  });

  it('still admits a healthy node whose 2·Bc + Bd stays under the peak', () => {
    // A real COPC node: ~0.2 MB compressed, 50k points at 34 bytes (~1.6 MB
    // decoded). Its WASM-aware peak sits far under the 256 MiB ceiling, so the
    // corrected guard does not refuse ordinary nodes.
    const recordLength = 34;
    const pointCount = 50_000;
    const compressedBytes = 200_000;
    expect(
      withinDecodePeakBudget(compressedBytes, pointCount, recordLength, 0, compressedBytes),
    ).toBe(true);
    expect(2 * compressedBytes + pointCount * recordLength).toBeLessThan(MAX_DECODE_PEAK_BYTES);
  });
});

// --- local windowed path: view instead of slice, byte-identical bytes --------

/** A laz-perf stand-in whose `getPoint` echoes the first `recordLength` bytes of
 *  the compressed input the caller staged into the heap, so the decoded output is
 *  a deterministic function of the exact compressed bytes handed to laz-perf.
 *  Records the size passed to the compressed `_malloc`. */
function echoLazPerf(): { module: LazPerfModule; firstMalloc: () => number } {
  const heap = new Uint8Array(8 * MiB);
  let next = 8;
  const mallocs: number[] = [];
  let chunkPtr = 0;
  let recordLength = 0;
  const module = {
    _malloc: (n: number) => {
      mallocs.push(n);
      const p = next;
      next += n;
      return p;
    },
    _free: () => {},
    HEAPU8: heap,
    ChunkDecoder: class {
      open(_pdrf: number, rl: number, ptr: number): void {
        recordLength = rl;
        chunkPtr = ptr;
      }
      getPoint(ptr: number): void {
        // Echo the staged compressed bytes so output tracks the input exactly.
        heap.copyWithin(ptr, chunkPtr, chunkPtr + recordLength);
      }
      delete(): void {}
    },
  } as unknown as LazPerfModule;
  return { module, firstMalloc: () => mallocs[0] };
}

describe('decompressChunk — window view carries only the chunk, byte-identically', () => {
  it('a Uint8Array view into a span decodes identically to the old span.slice, staging only the chunk', () => {
    // A window span with a chunk in the middle. rel/len select the chunk.
    const span = new ArrayBuffer(300);
    const u8 = new Uint8Array(span);
    for (let i = 0; i < u8.length; i++) u8[i] = (i * 7 + 3) & 0xff;
    const rel = 100;
    const len = 50;
    const recordLength = 10;
    const pointCount = 2;
    const meta = copcMeta(recordLength, pointCount);

    // New path: a VIEW into the resident span (no copy out of the span).
    const viewChunk = new Uint8Array(span, rel, len);
    const viewPerf = echoLazPerf();
    const viaView = decompressChunk(viewPerf.module, viewChunk, meta);

    // Old path: a standalone ArrayBuffer slice of the same bytes.
    const sliceChunk = span.slice(rel, rel + len);
    const slicePerf = echoLazPerf();
    const viaSlice = decompressChunk(slicePerf.module, sliceChunk, meta);

    // Byte-identical decode: the view and the slice hand laz-perf the same bytes.
    expect(Array.from(viaView)).toEqual(Array.from(viaSlice));
    // And the compressed allocation staged only the chunk's bytes, not the whole
    // 300-byte span the view points into.
    expect(viewPerf.firstMalloc()).toBe(len);
    expect(slicePerf.firstMalloc()).toBe(len);
  });
});
