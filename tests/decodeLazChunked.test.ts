/**
 * decodeLazChunked.test.ts — the chunk-parallel decode's correctness floor.
 *
 * The chunked path must produce EXACTLY what the legacy whole-file decoder
 * produces; the only thing that changes is that the work is split across the
 * chunk table so a worker pool can spread it over cores. This reads a committed
 * multi-chunk LAZ (written by the real LAS writer, compressed by PDAL, so its
 * chunk table is a real laszip one) and asserts the two decoders agree
 * bit-for-bit on positions, GPS time and colour.
 *
 * The fixture is committed so this runs in CI without PDAL; the benchmark that
 * needs many sizes generates its own fixtures under LAZ_DECODE_BENCH.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLasHeader } from '../src/io/lasHeader';
import { computeOrigin } from '../src/io/coordinateBridge';
import { decodeLaz } from '../src/io/lazDecode';
import { decodeLazChunkedSequential } from '../src/io/heavy/decodeLazChunked';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';

function loadFixture(name: string): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe('chunked LAZ decode', () => {
  it('is bit-identical to the legacy whole-file decoder, and multi-chunk', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);

    // The fixture must genuinely span more than one chunk, or this proves nothing.
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    expect(table.supported, 'fixture is a chunked LAZ').toBe(true);
    if (table.supported) expect(table.chunks.length, 'fixture spans several chunks').toBeGreaterThan(1);

    const seq = await decodeLaz(buf, header, origin, 1);
    const chunked = await decodeLazChunkedSequential(buf, header, origin);
    expect(chunked, 'chunked path supports this file').not.toBeNull();

    expect(chunked!.positions.length).toBe(seq.positions.length);
    expect(chunked!.positions).toEqual(seq.positions);
    if (seq.gpsTime) expect(chunked!.gpsTime).toEqual(seq.gpsTime);
    if (seq.colors) expect(chunked!.colors).toEqual(seq.colors);
  });

  it('fails closed (returns null) on a non-chunked input rather than guessing', async () => {
    // An uncompressed LAS has no laszip VLR, so the chunk-table reader reports
    // unsupported and the decoder returns null for the caller to fall back.
    const tiny = loadFixture('tiny.las');
    const header = parseLasHeader(tiny);
    const out = await decodeLazChunkedSequential(tiny, header, computeOrigin([0, 0, 0]));
    expect(out).toBeNull();
  });
});
