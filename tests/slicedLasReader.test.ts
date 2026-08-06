/**
 * The sliced reader against the whole-file loader, on the same bytes: every
 * batched value must equal what `loadLas` decodes for the same records, with
 * batch boundaries falling anywhere. The truncation case pins the clamp — a
 * file whose header promises more points than its bytes hold yields the
 * readable prefix, exactly as the whole-file path does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { openSlicedLas } from '../src/io/heavy/slicedLasReader';
import { loadLas } from '../src/io/loadLas';

function fixtureBuffer(): ArrayBuffer {
  const file = readFileSync(fileURLToPath(new URL('./fixtures/tiny.las', import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

describe('openSlicedLas — parity with the whole-file loader on tiny.las', () => {
  it('decodes identical positions, intensity, and classification across 5-point batches', async () => {
    const buf = fixtureBuffer();
    const whole = await loadLas(buf.slice(0), 'las', 'tiny.las');

    const sliced = await openSlicedLas(new ArrayBufferRangeSource(buf, 'tiny.las'), {
      batchPoints: 5, // 12 points → batches of 5, 5, 2: boundaries mid-file
    });
    expect(sliced.readablePointCount).toBe(whole.pointCount);
    expect(sliced.origin).toEqual(whole.origin);

    const n = sliced.readablePointCount;
    const xyz = new Float32Array(n * 3);
    const intensity = new Uint16Array(n);
    const classification = new Uint8Array(n);
    const batchSizes: number[] = [];
    for await (const batch of sliced.batches()) {
      batchSizes.push(batch.count);
      const { raw } = batch;
      xyz.set(raw.positions.subarray(0, batch.count * 3), batch.firstPointIndex * 3);
      intensity.set(raw.intensity.subarray(0, batch.count), batch.firstPointIndex);
      classification.set(raw.classification.subarray(0, batch.count), batch.firstPointIndex);
    }
    expect(batchSizes).toEqual([5, 5, 2]);
    expect(Array.from(xyz)).toEqual(Array.from(whole.positions.subarray(0, n * 3)));
    expect(Array.from(intensity)).toEqual(Array.from(whole.intensity!));
    expect(Array.from(classification)).toEqual(Array.from(whole.classification!));
  });

  it('reads an arbitrary interior batch without touching the rest', async () => {
    const buf = fixtureBuffer();
    const whole = await loadLas(buf.slice(0), 'las', 'tiny.las');
    const sliced = await openSlicedLas(new ArrayBufferRangeSource(buf, 'tiny.las'));
    const batch = await sliced.readBatch(7, 3);
    expect(batch.firstPointIndex).toBe(7);
    for (let i = 0; i < 3; i++) {
      for (let axis = 0; axis < 3; axis++) {
        expect(batch.raw.positions[i * 3 + axis]).toBe(whole.positions[(7 + i) * 3 + axis]);
      }
    }
  });

  it('rejects a batch outside the readable range', async () => {
    const sliced = await openSlicedLas(new ArrayBufferRangeSource(fixtureBuffer(), 'tiny.las'));
    await expect(sliced.readBatch(10, 5)).rejects.toThrow(RangeError);
    await expect(sliced.readBatch(-1, 2)).rejects.toThrow(RangeError);
  });
});

describe('openSlicedLas — truncated file clamp', () => {
  it('a file cut mid-records yields the readable prefix, like the whole-file path', async () => {
    const buf = fixtureBuffer();
    const whole = await loadLas(buf.slice(0), 'las', 'tiny.las');
    // Keep the header + 7 full records + a torn 8th record.
    const header = await openSlicedLas(new ArrayBufferRangeSource(buf, 'tiny.las'));
    const recordLength = header.header.pointDataRecordLength;
    const cut = buf.slice(0, header.header.offsetToPointData + 7 * recordLength + 5);

    const sliced = await openSlicedLas(new ArrayBufferRangeSource(cut, 'cut.las'), {
      batchPoints: 3,
    });
    expect(sliced.readablePointCount).toBe(7);
    let seen = 0;
    for await (const batch of sliced.batches()) {
      for (let i = 0; i < batch.count; i++) {
        const p = batch.firstPointIndex + i;
        for (let axis = 0; axis < 3; axis++) {
          expect(batch.raw.positions[i * 3 + axis]).toBe(whole.positions[p * 3 + axis]);
        }
      }
      seen += batch.count;
    }
    expect(seen).toBe(7);
  });
});
