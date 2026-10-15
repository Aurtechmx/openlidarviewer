import { describe, it, expect } from 'vitest';
import { lazRecord0 } from '../src/io/heavy/lazRecord0';
import { MAX_HEAD_BYTES } from '../src/io/heavy/lazChunkTable';
import type { RangeSource } from '../src/io/range/RangeSource';
import type { LasHeader } from '../src/io/lasHeader';

/**
 * Record 0 is read from the VLR region and the start of chunk 0. A header whose
 * point-data offset lies far past the heavy path's head cap must not pull that
 * whole region into memory; record 0 is skipped and the header origin kept.
 */
describe('lazRecord0 head cap', () => {
  it('skips record 0 without reading when the point data starts past the head cap', async () => {
    const reads: number[] = [];
    const size = 3 * 1024 * 1024 * 1024;
    const range = {
      size: async () => size,
      readRange: async (_offset: number, length: number) => {
        reads.push(length);
        return new ArrayBuffer(Math.min(length, 16));
      },
    } as unknown as RangeSource;
    const header = {
      pointCount: 10,
      offsetToPointData: 2 * 1024 * 1024 * 1024,
      pointDataRecordLength: 30,
      pointFormat: 6,
    } as unknown as LasHeader;
    const head = new ArrayBuffer(375);

    expect(await lazRecord0(range, header, head)).toBeNull();
    expect(reads.every((n) => n <= MAX_HEAD_BYTES)).toBe(true);
    expect(reads).toEqual([]);
  });
});
