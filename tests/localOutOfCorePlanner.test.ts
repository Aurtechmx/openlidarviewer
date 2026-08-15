import { describe, it, expect, beforeAll } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { planOutOfCore } from '../src/io/heavy/LocalOutOfCoreSource';
import type { GlobalPoints } from '../src/convert/globalPoints';

type WriteLas14 = typeof import('../src/convert/writeLas').writeLas14;
let writeLas14: WriteLas14;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  ({ writeLas14 } = await import('../src/convert/writeLas'));
});

function lasBytes(n = 20): Uint8Array {
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = i; y[i] = 2 * i; z[i] = 100 + i; }
  const g: GlobalPoints = { count: n, x, y, z };
  return writeLas14(g, { epsg: 32611, linearUnitCode: 9001 });
}

function source(bytes: Uint8Array): ArrayBufferRangeSource {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new ArrayBufferRangeSource(ab, 'test.las');
}

describe('planOutOfCore', () => {
  it('routes an uncompressed LAS to sliced record reads', async () => {
    const plan = await planOutOfCore(source(lasBytes(20)));
    expect(plan.mode).toBe('sliced-las');
    expect(plan.compressed).toBe(false);
    expect(plan.pointCount).toBe(20);
    expect(plan.recordLength).toBeGreaterThan(0);
    expect(plan.chunkCount).toBeNull();
  });

  it('falls back to whole-file when a compressed file has no usable chunk table', async () => {
    const bytes = lasBytes(20);
    bytes[104] |= 0x80; // set the LAZ compression bit; no laszip VLR is present
    const plan = await planOutOfCore(source(bytes));
    expect(plan.compressed).toBe(true);
    expect(plan.mode).toBe('whole-file');
    expect(plan.reason).toContain('whole-file');
  });
});
