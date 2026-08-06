/**
 * The native chunk-table reader against synthetic LAZ files it can verify to
 * the byte: each fixture is a real LAS header + laszip VLR + fake chunk bytes
 * + a table encoded with the mirror encoder, so every decoded range has one
 * correct answer. The corrupt cases pin the fail-closed contract — a table
 * that lies about its chunks must yield `supported: false`, never a range.
 */
import { describe, it, expect } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { ArithmeticEncoder, IntegerCompressorEnc } from '../src/io/heavy/arithmeticCoder';

const HEADER_SIZE = 227; // LAS 1.2
const VLR_HEADER = 54;
const LASZIP_PAYLOAD = 34;

interface FixtureSpec {
  compressor: number;
  chunkSize: number;
  pointCount: number;
  chunkByteSizes: number[];
  /** Per-chunk point counts — only encoded for variable-size tables. */
  chunkPointCounts?: number[];
  tableOffsetOverride?: bigint;
  tableVersion?: number;
  declaredChunks?: number;
}

function buildLazFixture(spec: FixtureSpec): ArrayBuffer {
  const offsetToPointData = HEADER_SIZE + VLR_HEADER + LASZIP_PAYLOAD;
  const chunksStart = offsetToPointData + 8;
  const chunkBytesTotal = spec.chunkByteSizes.reduce((a, b) => a + b, 0);
  const tableOffset = chunksStart + chunkBytesTotal;

  // Encode the table with the mirror encoder, in the exact stream order the
  // reader decodes: per chunk, count delta (ctx 0, variable only) then byte
  // delta (ctx 1), each predicted from the previous delta.
  const enc = new ArithmeticEncoder();
  const ic = new IntegerCompressorEnc(enc, 2);
  let prevCount = 0;
  let prevStart = 0;
  for (let i = 0; i < spec.chunkByteSizes.length; i++) {
    if (spec.chunkPointCounts) {
      ic.compress(prevCount | 0, spec.chunkPointCounts[i] | 0, 0);
      prevCount = spec.chunkPointCounts[i];
    }
    ic.compress(prevStart | 0, spec.chunkByteSizes[i] | 0, 1);
    prevStart = spec.chunkByteSizes[i];
  }
  const tableBody = enc.done();

  const total = tableOffset + 8 + tableBody.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // LAS 1.2 public header.
  u8.set([0x4c, 0x41, 0x53, 0x46], 0); // 'LASF'
  view.setUint8(24, 1); // version major
  view.setUint8(25, 2); // version minor
  view.setUint16(94, HEADER_SIZE, true);
  view.setUint32(96, offsetToPointData, true);
  view.setUint32(100, 1, true); // one VLR
  view.setUint8(104, 0x80 | 0); // PDRF 0 with the LAZ compression bit
  view.setUint16(105, 20, true); // record length
  view.setUint32(107, spec.pointCount, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(131 + axis * 8, 0.001, true); // scale
    view.setFloat64(155 + axis * 8, 0, true); // offset
  }
  // max/min interleaved: x max, x min, y max, y min, z max, z min.
  for (let i = 0; i < 6; i++) view.setFloat64(179 + i * 8, i % 2 === 0 ? 100 : 0, true);

  // laszip VLR.
  let c = HEADER_SIZE;
  view.setUint16(c, 0, true);
  const userId = 'laszip encoded';
  for (let i = 0; i < userId.length; i++) view.setUint8(c + 2 + i, userId.charCodeAt(i));
  view.setUint16(c + 18, 22204, true);
  view.setUint16(c + 20, LASZIP_PAYLOAD, true);
  c += VLR_HEADER;
  view.setUint16(c, spec.compressor, true);
  view.setUint16(c + 2, 0, true); // coder
  view.setUint8(c + 4, 2); // version 2.4.0
  view.setUint8(c + 5, 4);
  view.setUint16(c + 6, 0, true);
  view.setUint32(c + 8, 0, true); // options
  view.setUint32(c + 12, spec.chunkSize, true);
  // special-EVLR count/offset (i64 each) and num_items stay zero.

  view.setBigInt64(offsetToPointData, spec.tableOffsetOverride ?? BigInt(tableOffset), true);
  // Fake compressed chunk bytes: deterministic filler.
  for (let i = chunksStart; i < tableOffset; i++) u8[i] = i & 0xff;

  view.setUint32(tableOffset, spec.tableVersion ?? 0, true);
  view.setUint32(tableOffset + 4, spec.declaredChunks ?? spec.chunkByteSizes.length, true);
  u8.set(tableBody, tableOffset + 8);
  return buf;
}

const src = (buf: ArrayBuffer) => new ArrayBufferRangeSource(buf, 'fixture.laz');

describe('readLazChunkTable — fixed-size chunks (compressor 2)', () => {
  const spec: FixtureSpec = {
    compressor: 2,
    chunkSize: 250,
    pointCount: 700,
    chunkByteSizes: [5000, 5200, 4100],
  };

  it('recovers every chunk range, count, and first-point index', async () => {
    const t = await readLazChunkTable(src(buildLazFixture(spec)));
    expect(t.supported).toBe(true);
    if (!t.supported) return;
    expect(t.compressor).toBe(2);
    expect(t.chunkSize).toBe(250);
    const chunksStart = HEADER_SIZE + VLR_HEADER + LASZIP_PAYLOAD + 8;
    expect(t.chunks.map((ch) => ch.byteOffset)).toEqual([
      chunksStart, chunksStart + 5000, chunksStart + 10200,
    ]);
    expect(t.chunks.map((ch) => ch.byteLength)).toEqual([5000, 5200, 4100]);
    expect(t.chunks.map((ch) => ch.pointCount)).toEqual([250, 250, 200]);
    expect(t.chunks.map((ch) => ch.firstPointIndex)).toEqual([0, 250, 500]);
  });

  it('an exact-multiple point count gives every chunk the full size', async () => {
    const t = await readLazChunkTable(
      src(buildLazFixture({ ...spec, pointCount: 750, chunkByteSizes: [5000, 5200, 4100] })),
    );
    expect(t.supported).toBe(true);
    if (t.supported) expect(t.chunks.map((ch) => ch.pointCount)).toEqual([250, 250, 250]);
  });
});

describe('readLazChunkTable — variable-size chunks (compressor 3)', () => {
  it('decodes per-chunk point counts and validates their sum', async () => {
    const t = await readLazChunkTable(
      src(
        buildLazFixture({
          compressor: 3,
          chunkSize: 0xffffffff,
          pointCount: 900,
          chunkByteSizes: [7000, 2500, 6100],
          chunkPointCounts: [400, 100, 400],
        }),
      ),
    );
    expect(t.supported).toBe(true);
    if (!t.supported) return;
    expect(t.chunkSize).toBe('variable');
    expect(t.chunks.map((ch) => ch.pointCount)).toEqual([400, 100, 400]);
    expect(t.chunks.map((ch) => ch.firstPointIndex)).toEqual([0, 400, 500]);
  });
});

describe('readLazChunkTable — fail-closed', () => {
  const good: FixtureSpec = {
    compressor: 2,
    chunkSize: 250,
    pointCount: 700,
    chunkByteSizes: [5000, 5200, 4100],
  };

  const expectUnsupported = async (spec: FixtureSpec, reasonPart: string) => {
    const t = await readLazChunkTable(src(buildLazFixture(spec)));
    expect(t.supported).toBe(false);
    if (!t.supported) expect(t.reason).toContain(reasonPart);
  };

  it('pointwise compressor has no table', () =>
    expectUnsupported({ ...good, compressor: 1 }, 'pointwise'));

  it('the -1 offset sentinel falls back', () =>
    expectUnsupported({ ...good, tableOffsetOverride: -1n }, 'sentinel'));

  it('an out-of-file table offset falls back', () =>
    expectUnsupported({ ...good, tableOffsetOverride: 10_000_000n }, 'outside the file'));

  it('a non-zero table version falls back', () =>
    expectUnsupported({ ...good, tableVersion: 7 }, 'version'));

  it('a chunk count that contradicts the header falls back', () =>
    expectUnsupported({ ...good, declaredChunks: 5 }, 'follow from the header'));

  it('a tampered table body cannot produce ranges', async () => {
    const buf = buildLazFixture(good);
    // Flip bytes in the encoded table body: the decoded deltas then break an
    // invariant (non-monotonic, past-the-table, or a bad sum).
    const u8 = new Uint8Array(buf);
    for (let i = buf.byteLength - 6; i < buf.byteLength; i++) u8[i] ^= 0xa5;
    const t = await readLazChunkTable(src(buf));
    expect(t.supported).toBe(false);
  });

  it('zero chunks with a non-empty header falls back', async () => {
    const buf = buildLazFixture({ ...good, chunkByteSizes: [], declaredChunks: 0 });
    const t = await readLazChunkTable(src(buf));
    expect(t.supported).toBe(false);
    if (!t.supported) expect(t.reason).toContain('zero chunks');
  });
});
