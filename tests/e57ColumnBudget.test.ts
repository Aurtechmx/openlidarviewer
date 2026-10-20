/**
 * A CompressedVector's record count is bounded by its section bytes at the
 * prototype's minimal record size. Integer fields declared with a zero bit
 * width add nothing to that size yet each still decode to 8 bytes per record,
 * so a crafted prototype could ask for tens of gigabytes from a small file.
 * The decoder refuses an oversized prototype, a record of zero stored bits,
 * and columns over its byte budget, before allocating any of them.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeCompressedVector,
  MAX_E57_COLUMN_BYTES,
  MAX_E57_PROTOTYPE_FIELDS,
} from '../src/io/e57/compressedVector';
import type { E57Field } from '../src/io/e57/schema';
import { LoadError } from '../src/io/loadErrors';

/** A logical buffer holding one CompressedVector section header at offset 0, `bytes` long. */
function section(bytes: number): Uint8Array {
  const buf = new Uint8Array(bytes);
  const v = new DataView(buf.buffer);
  buf[0] = 1; // CompressedVector section id
  v.setBigUint64(8, BigInt(bytes), true); // section logical length
  v.setBigUint64(16, 32n, true); // data offset (no packets follow)
  return buf;
}

const PAGE = 1 << 30; // one page: physical and logical offsets coincide
const int = (name: string, bitWidth: number): E57Field => ({ name, type: 'integer', minimum: 0, maximum: 2 ** bitWidth - 1, bitWidth }) as E57Field;

function refusal(fn: () => unknown): LoadError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LoadError);
    return e as LoadError;
  }
  throw new Error('expected a refusal');
}

describe('E57 CompressedVector column budget', () => {
  it('refuses a prototype with more fields than the reader accepts', () => {
    const proto = Array.from({ length: MAX_E57_PROTOTYPE_FIELDS + 1 }, (_, i) => int(`f${i}`, 8));
    const e = refusal(() => decodeCompressedVector(section(4096), 0, 10, proto, PAGE));
    expect(e.category).toBe('malformed-file');
    expect(e.message).toContain(`${MAX_E57_PROTOTYPE_FIELDS + 1} fields`);
  });

  it('refuses records whose every field is zero bits wide', () => {
    const proto = [int('a', 0), int('b', 0)];
    const e = refusal(() => decodeCompressedVector(section(4096), 0, 100, proto, PAGE));
    expect(e.category).toBe('malformed-file');
    expect(e.message).toContain('no stored bits');
  });

  it('refuses columns over the byte budget before allocating them', () => {
    // One 8-bit field keeps the record floor at 1 byte; 63 zero-width fields
    // each still cost 8 bytes per record.
    const proto = [int('x', 8), ...Array.from({ length: 63 }, (_, i) => int(`z${i}`, 0))];
    const records = Math.ceil(MAX_E57_COLUMN_BYTES / (64 * 8)) + 1;
    const e = refusal(() => decodeCompressedVector(section(records + 64), 0, records, proto, PAGE));
    expect(e.category).toBe('memory-constraint');
    // Only the kept fields count: decoding one column of the same records is under budget.
    expect(() =>
      decodeCompressedVector(section(records + 64), 0, records, proto, PAGE, { keepField: (n) => n === 'x' }),
    ).not.toThrow(/would need/);
  });
});
