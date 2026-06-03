/**
 * e57IntegerTruncation.test.ts
 *
 * Pins the E57 integer-bytestream truncation contract. The previous
 * behaviour silently filled missing bits with 0, producing `count`
 * values clamped to `minimum` — a dataset-corrupting class of bug
 * for coordinates (every truncated point collapsed to the bbox
 * corner) and for classification codes (every truncated point read
 * as the minimum class). The fix throws an explicit error, matching
 * the float-bytestream branch's behaviour.
 */

import { describe, it, expect } from 'vitest';
import { _testOnly_decodeField } from '../src/io/e57/compressedVector';

describe('decodeField — integer / scaledInteger truncation', () => {
  it('throws when the buffer is too small for the requested count', () => {
    // 1 byte = 8 bits; we ask for 4 values at 8 bits each = 32 bits.
    const buf = new Uint8Array([0x42]);
    expect(() =>
      _testOnly_decodeField(
        buf,
        { name: 't', type: 'integer', bitWidth: 8, minimum: 0 },
        4,
      ),
    ).toThrow(/truncated/i);
  });

  it('throws for a scaledInteger field too — same truncation guard', () => {
    const buf = new Uint8Array([0xff, 0x00]);
    expect(() =>
      _testOnly_decodeField(
        buf,
        { name: 't', type: 'scaledInteger', bitWidth: 16, minimum: 0, scale: 0.001 },
        8,
      ),
    ).toThrow(/truncated/i);
  });

  it('decodes a complete buffer without throwing', () => {
    // 4 values × 8 bits = 32 bits = 4 bytes; provide exactly that.
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const out = _testOnly_decodeField(
      buf,
      { name: 't', type: 'integer', bitWidth: 8, minimum: 0 },
      4,
    );
    expect(out.length).toBe(4);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(2);
    expect(out[2]).toBe(3);
    expect(out[3]).toBe(4);
  });

  it('applies minimum offset to a non-truncated integer stream', () => {
    const buf = new Uint8Array([0x00, 0x05]);
    const out = _testOnly_decodeField(
      buf,
      { name: 't', type: 'integer', bitWidth: 8, minimum: 100 },
      2,
    );
    expect(out[0]).toBe(100);
    expect(out[1]).toBe(105);
  });
});
