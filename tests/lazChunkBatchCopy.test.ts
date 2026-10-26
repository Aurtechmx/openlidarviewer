/**
 * lazChunkBatchCopy.test.ts
 *
 * decompressChunk decodes a block of records into one WASM heap buffer and
 * copies the block out at once, instead of copying each record as it lands.
 * The raw records must be the ones the per-record copy gave: every chunk of
 * the committed chunked LAZ fixtures (PDRF 3 and the PDAL-written file), and
 * leading slices whose lengths straddle the block size.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { parseLasHeader } from '../src/io/lasHeader';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { getLazPerf } from '../src/io/lazDecode';
import { decompressChunk, decodeBlockRecords, estimateCopcPeakBytes, type LazPerfModule } from '../src/io/copc/copcChunkDecompress';
import type { ChunkDecodeMetadata } from '../src/io/copc/copcChunkDecode';

/** The per-record copy as it stood. */
function perRecord(lazPerf: LazPerfModule, chunk: Uint8Array, meta: ChunkDecodeMetadata): Uint8Array {
  const recordLength = meta.pointRecordLength;
  const chunkPtr = lazPerf._malloc(chunk.byteLength);
  const pointPtr = lazPerf._malloc(recordLength);
  const decoder = new lazPerf.ChunkDecoder();
  try {
    lazPerf.HEAPU8.set(chunk, chunkPtr);
    decoder.open(meta.pointDataRecordFormat, recordLength, chunkPtr);
    const out = new Uint8Array(meta.pointCount * recordLength);
    for (let i = 0; i < meta.pointCount; i++) {
      decoder.getPoint(pointPtr);
      out.set(lazPerf.HEAPU8.subarray(pointPtr, pointPtr + recordLength), i * recordLength);
    }
    return out;
  } finally {
    decoder.delete();
    lazPerf._free(pointPtr);
    lazPerf._free(chunkPtr);
  }
}

const bytes = (name: string): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('decompressChunk block copy', () => {
  for (const name of ['multichunk.laz', 'multichunk-pdrf3.laz']) {
    it(`${name}: every chunk and straddling slices decode to the same records`, async () => {
      const buffer = bytes(name);
      const header = parseLasHeader(buffer);
      const table = await readLazChunkTable(new ArrayBufferRangeSource(buffer), undefined, header.offsetToPointData);
      expect(table.supported).toBe(true);
      if (!table.supported) return;
      const lazPerf = await getLazPerf();
      const meta = (pointCount: number): ChunkDecodeMetadata => ({
        pointDataRecordFormat: header.pointFormat,
        pointRecordLength: header.pointDataRecordLength,
        pointCount,
        scale: header.scale,
        offset: header.offset,
        renderOrigin: [0, 0, 0],
      });
      let compared = 0;
      for (const c of table.chunks) {
        const chunk = new Uint8Array(buffer, c.byteOffset, c.byteLength).slice();
        const got = decompressChunk(lazPerf, chunk, meta(c.pointCount));
        expect(Buffer.compare(Buffer.from(got), Buffer.from(perRecord(lazPerf, chunk, meta(c.pointCount))))).toBe(0);
        compared += c.pointCount;
      }
      expect(compared).toBe(table.chunks.reduce((t, c) => t + c.pointCount, 0));
      const first = table.chunks[0]!;
      const chunk = new Uint8Array(buffer, first.byteOffset, first.byteLength).slice();
      for (const n of [1, 1023, 1024, 1025, 2049, 3000]) {
        if (n > first.pointCount) continue;
        const got = decompressChunk(lazPerf, chunk, meta(n));
        expect(got.byteLength).toBe(n * header.pointDataRecordLength);
        expect(Buffer.compare(Buffer.from(got), Buffer.from(perRecord(lazPerf, chunk, meta(n)))), `${n} records`).toBe(0);
      }
    });
  }

  it('the peak estimate charges the decode block in the decompression phase', () => {
    expect(decodeBlockRecords(5_000, 30)).toBe(1024);
    expect(decodeBlockRecords(10, 30)).toBe(10);
    expect(decodeBlockRecords(5_000, 65_535)).toBe(16); // 1 MiB of 64 KiB records
    expect(decodeBlockRecords(5_000, 2_000_000)).toBe(1);
    const meta: ChunkDecodeMetadata = {
      pointDataRecordFormat: 6, pointRecordLength: 30, pointCount: 5_000,
      scale: [1, 1, 1], offset: [0, 0, 0], renderOrigin: [0, 0, 0],
    };
    // A large compressed chunk makes phase 1 the peak: 2·Bc + raw + block.
    const bc = 10 * 1024 * 1024;
    expect(estimateCopcPeakBytes(meta, bc, 5_000)).toBe(2 * bc + 5_000 * 30 + 1024 * 30);
  });
});
