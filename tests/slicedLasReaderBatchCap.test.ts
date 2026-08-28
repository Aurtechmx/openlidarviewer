/**
 * slicedLasReaderBatchCap.test.ts — the public `readBatch` never issues a single
 * range read above the source-byte cap.
 *
 * `batches()` sizes its batches with `batchPointsForRecordLength`, but before the
 * fix the public `readBatch(firstPointIndex, count)` read `count * recordLength`
 * bytes in one range read with no cap on `count`. The preview sampler calls
 * `readBatch` directly with strata-sized counts, so a LAS with large Extra Bytes
 * (record length up to 65535) made one preview stratum read roughly a gigabyte.
 *
 * These cases build a LAS with a huge record length and read a large count, then
 * assert (via a range source that records its largest single read) that no read
 * ever exceeds MAX_BATCH_SOURCE_BYTES, that the returned point count is intact,
 * and that the decoded geometry matches a reference decode of the same records.
 */
import { describe, it, expect } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource, RangeSourceKind } from '../src/io/range/RangeSource';
import { openSlicedLas } from '../src/io/heavy/slicedLasReader';
import { buildPreviewSample } from '../src/io/heavy/previewSampler';
import { MAX_BATCH_SOURCE_BYTES } from '../src/io/heavy/heavyByteBudget';

const LAS_HEADER_SIZE = 227;

/** A minimal valid uncompressed LAS with a controllable (large) record length. */
function buildLasFixture(opts: {
  pointFormat: number;
  recordLength: number;
  pointCount: number;
}): ArrayBuffer {
  const offsetToPointData = LAS_HEADER_SIZE;
  const total = offsetToPointData + opts.pointCount * opts.recordLength;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x4c, 0x41, 0x53, 0x46], 0); // 'LASF'
  view.setUint8(24, 1);
  view.setUint8(25, 2); // version 1.2 → legacy uint32 count
  view.setUint16(94, LAS_HEADER_SIZE, true);
  view.setUint32(96, offsetToPointData, true);
  view.setUint32(100, 0, true); // no VLRs
  view.setUint8(104, opts.pointFormat);
  view.setUint16(105, opts.recordLength, true);
  view.setUint32(107, opts.pointCount, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(131 + axis * 8, 0.001, true); // scale > 0
    view.setFloat64(155 + axis * 8, 0, true); // offset
  }
  view.setFloat64(179, 100, true); view.setFloat64(187, 0, true);
  view.setFloat64(195, 100, true); view.setFloat64(203, 0, true);
  view.setFloat64(211, 100, true); view.setFloat64(219, 0, true);
  return buf;
}

/** A RangeSource that records the largest single read requested against it. */
class WatchedRangeSource implements RangeSource {
  maxRead = 0;
  reads = 0;
  private readonly inner: RangeSource;
  constructor(inner: RangeSource) {
    this.inner = inner;
  }
  id(): string {
    return this.inner.id();
  }
  kind(): RangeSourceKind {
    return this.inner.kind();
  }
  size(): Promise<number> {
    return this.inner.size();
  }
  readRange(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    this.reads++;
    if (length > this.maxRead) this.maxRead = length;
    return this.inner.readRange(offset, length, signal);
  }
}

describe('openSlicedLas.readBatch — source-byte cap cannot be bypassed', () => {
  it('reads a huge-record, large-count batch in bounded sub-ranges under the cap', async () => {
    // 300 records of 65535 bytes = ~19.66 MiB; a single uncapped read would blow
    // past the 16 MiB source ceiling.
    const recordLength = 65535;
    const count = 300;
    expect(count * recordLength).toBeGreaterThan(MAX_BATCH_SOURCE_BYTES);

    const watched = new WatchedRangeSource(
      new ArrayBufferRangeSource(buildLasFixture({ pointFormat: 0, recordLength, pointCount: count }), 'big.las'),
    );
    const opened = await openSlicedLas(watched);
    expect(opened.readablePointCount).toBe(count);

    const before = watched.reads;
    const batch = await opened.readBatch(0, count);

    // No single range read ever exceeded the source-byte cap.
    expect(watched.maxRead).toBeLessThanOrEqual(MAX_BATCH_SOURCE_BYTES);
    expect(watched.maxRead).toBeGreaterThan(0);
    // The huge batch was split into more than one sub-range read.
    expect(watched.reads - before).toBeGreaterThan(1);

    // Geometry is intact: every requested point returned, decoded (all-zero
    // records at offset 0 → local origin), matching a reference decode.
    expect(batch.count).toBe(count);
    expect(batch.raw.positions.length).toBe(count * 3);
    for (let i = 0; i < count * 3; i++) expect(batch.raw.positions[i]).toBe(0);
  });

  it('the preview sampler cannot trigger a >cap read on a large-record LAS', async () => {
    // A single stratum of 60 000 points at 300 bytes/record is ~18 MiB — over the
    // cap in one read. The sampler calls readBatch directly, so the cap must live
    // inside readBatch for the preview to stay bounded.
    const recordLength = 300;
    const count = 60_000;
    const watched = new WatchedRangeSource(
      new ArrayBufferRangeSource(buildLasFixture({ pointFormat: 0, recordLength, pointCount: count }), 'preview.las'),
    );

    const sample = await buildPreviewSample(
      watched,
      { format: 'las', offsetToPointData: LAS_HEADER_SIZE },
      { strata: 1, targetPoints: count },
    );

    expect(sample).not.toBeNull();
    expect(watched.maxRead).toBeLessThanOrEqual(MAX_BATCH_SOURCE_BYTES);
    expect(watched.maxRead).toBeGreaterThan(0);
  });
});
