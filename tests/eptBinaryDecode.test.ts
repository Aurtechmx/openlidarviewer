/**
 * eptBinaryDecode.test.ts — size-8 attribute decoding (the scientific-audit
 * A1 fix). The decoder used to read EVERY 8-byte attribute as Float64; an
 * int64/uint64 attribute (a layout Entwine permits, including for X/Y/Z)
 * had its two's-complement bits reinterpreted as IEEE-754 and decoded to
 * garbage. Now size-8 branches on the schema's declared type, converts
 * integers to Number only when exactly representable, and throws a typed
 * malformed-file error beyond ±(2^53 − 1).
 *
 * All expectations are hand-computed from the written byte values.
 */

import { test, expect } from 'vitest';
import { decodeEptBinaryTile } from '../src/io/ept/eptBinaryDecode';
import { LoadError } from '../src/io/loadErrors';
import type { EptSchemaField } from '../src/io/ept/eptTypes';

/** Build a one-point tile for a schema, writing each attribute from `write`. */
function tileFor(
  schema: readonly EptSchemaField[],
  write: (view: DataView, offsetOf: (name: string) => number) => void,
): ArrayBuffer {
  let stride = 0;
  const offsets = new Map<string, number>();
  for (const f of schema) {
    offsets.set(f.name, stride);
    stride += f.size;
  }
  const buffer = new ArrayBuffer(stride);
  write(new DataView(buffer), (name) => {
    const off = offsets.get(name);
    if (off === undefined) throw new Error(`no attribute ${name}`);
    return off;
  });
  return buffer;
}

const XYZ_INT64: EptSchemaField[] = [
  { name: 'X', size: 8, type: 'signed', scale: 0.001, offset: 0 },
  { name: 'Y', size: 8, type: 'signed', scale: 0.001, offset: 0 },
  { name: 'Z', size: 8, type: 'signed', scale: 0.001, offset: 0 },
];

test('X/Y/Z stored as int64 decode exactly, including a negative coordinate', () => {
  // Hand-computed: raw −70000 × 0.001 = −70 m; 123456789 × 0.001 =
  // 123456.789 m; 42 × 0.001 = 0.042 m. Under the old Float64
  // reinterpretation, the int64 bit pattern 0xFFFFFFFFFFFEEE90 (−70000)
  // reads as a NaN-adjacent garbage double — nowhere near −70.
  const tile = tileFor(XYZ_INT64, (view, off) => {
    view.setBigInt64(off('X'), -70000n, true);
    view.setBigInt64(off('Y'), 123456789n, true);
    view.setBigInt64(off('Z'), 42n, true);
  });
  const decoded = decodeEptBinaryTile(tile, 1, XYZ_INT64, [0, 0, 0]);
  expect(decoded.positions[0]).toBeCloseTo(-70, 6);
  expect(decoded.positions[1]).toBeCloseTo(123456.789, 3);
  expect(decoded.positions[2]).toBeCloseTo(0.042, 6);
});

test('an int64 value beyond 2^53 − 1 throws a typed malformed-file error', () => {
  // 2^60 is not exactly representable as a Number; converting would round
  // silently, so the decoder must refuse rather than fabricate a coordinate.
  const tile = tileFor(XYZ_INT64, (view, off) => {
    view.setBigInt64(off('X'), 1n << 60n, true);
    view.setBigInt64(off('Y'), 0n, true);
    view.setBigInt64(off('Z'), 0n, true);
  });
  let thrown: unknown;
  try {
    decodeEptBinaryTile(tile, 1, XYZ_INT64, [0, 0, 0]);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LoadError);
  expect((thrown as LoadError).category).toBe('malformed-file');
  expect((thrown as LoadError).message).toMatch(/malformed/);
  expect((thrown as LoadError).message).toMatch(/"X"/);
});

test('a uint64 value beyond 2^53 − 1 throws; one within range converts exactly', () => {
  const schema: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 1 },
    { name: 'Y', size: 4, type: 'signed', scale: 1 },
    { name: 'Z', size: 4, type: 'signed', scale: 1 },
    { name: 'GpsTime', size: 8, type: 'unsigned' },
  ];
  // 2^53 + 1 is the first unsigned integer Number cannot hold exactly.
  const bad = tileFor(schema, (view, off) => {
    view.setBigUint64(off('GpsTime'), (1n << 53n) + 1n, true);
  });
  expect(() => decodeEptBinaryTile(bad, 1, schema, [0, 0, 0])).toThrow(/malformed/);

  // 9007199254740991 = 2^53 − 1 — the largest safe integer — must survive.
  const ok = tileFor(schema, (view, off) => {
    view.setBigUint64(off('GpsTime'), (1n << 53n) - 1n, true);
  });
  const decoded = decodeEptBinaryTile(ok, 1, schema, [0, 0, 0]);
  expect(decoded.gpsTime[0]).toBe(9007199254740991);
});

// ─────────────────────────────────────────────────────────────────────────────
// RGB bit-depth: ONE dataset-level decision (the scientific-audit A2 fix).
// LAS-heritage 16-bit RGB is ambiguous — some writers stuff 8-bit values into
// the low byte; the old unconditional >> 8 rendered those clouds black.
// ─────────────────────────────────────────────────────────────────────────────

const XYZ_RGB16: EptSchemaField[] = [
  { name: 'X', size: 4, type: 'signed', scale: 1 },
  { name: 'Y', size: 4, type: 'signed', scale: 1 },
  { name: 'Z', size: 4, type: 'signed', scale: 1 },
  { name: 'Red', size: 2, type: 'unsigned' },
  { name: 'Green', size: 2, type: 'unsigned' },
  { name: 'Blue', size: 2, type: 'unsigned' },
];

function rgbTile(r: number, g: number, b: number): ArrayBuffer {
  return tileFor(XYZ_RGB16, (view, off) => {
    view.setUint16(off('Red'), r, true);
    view.setUint16(off('Green'), g, true);
    view.setUint16(off('Blue'), b, true);
  });
}

test('8-bit-stuffed 16-bit RGB (max ≤ 255) copies verbatim, and reports the decision', () => {
  // Hand-computed: (200, 100, 50) with tile max 200 ≤ 255 ⇒ 8-bit-in-low-byte.
  // The old >> 8 produced (0, 0, 0) — a black cloud.
  const decoded = decodeEptBinaryTile(rgbTile(200, 100, 50), 1, XYZ_RGB16, [0, 0, 0]);
  expect([...decoded.rgb!]).toEqual([200, 100, 50]);
  expect(decoded.rgbEightBit).toBe(true);
});

test('true 16-bit RGB (max > 255) narrows with >> 8', () => {
  // Hand-computed: 51400 >> 8 = 200, 25700 >> 8 = 100, 12850 >> 8 = 50
  // (the ×257 encoding this app writes).
  const decoded = decodeEptBinaryTile(rgbTile(51400, 25700, 12850), 1, XYZ_RGB16, [0, 0, 0]);
  expect([...decoded.rgb!]).toEqual([200, 100, 50]);
  expect(decoded.rgbEightBit).toBe(false);
});

test('a pinned dataset decision overrides a later tile\'s own max (cross-tile consistency)', () => {
  // Tile 1 is true 16-bit (max > 255) → decision false. Tile 2 is all-dark
  // (its own max 180 ≤ 255 would read 8-bit) — but the pinned decision keeps
  // it on the SAME >> 8 narrowing: 180 >> 8 = 0. Without the pin the two
  // tiles of one cloud would render in different colour depths.
  const first = decodeEptBinaryTile(rgbTile(51400, 25700, 12850), 1, XYZ_RGB16, [0, 0, 0]);
  expect(first.rgbEightBit).toBe(false);
  const second = decodeEptBinaryTile(
    rgbTile(180, 90, 45), 1, XYZ_RGB16, [0, 0, 0], first.rgbEightBit,
  );
  expect([...second.rgb!]).toEqual([0, 0, 0]);
  expect(second.rgbEightBit).toBe(false);
});

test('a tile without RGB reports no bit-depth decision (nothing to pin)', () => {
  const schema: EptSchemaField[] = XYZ_INT64;
  const tile = tileFor(schema, (view, off) => {
    view.setBigInt64(off('X'), 0n, true);
    view.setBigInt64(off('Y'), 0n, true);
    view.setBigInt64(off('Z'), 0n, true);
  });
  const decoded = decodeEptBinaryTile(tile, 1, schema, [0, 0, 0]);
  expect(decoded.rgb).toBeUndefined();
  expect(decoded.rgbEightBit).toBeUndefined();
});

test('a declared float64 attribute still reads as Float64 (unchanged path)', () => {
  const schema: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 1 },
    { name: 'Y', size: 4, type: 'signed', scale: 1 },
    { name: 'Z', size: 4, type: 'signed', scale: 1 },
    { name: 'GpsTime', size: 8, type: 'float' },
  ];
  const tile = tileFor(schema, (view, off) => {
    view.setInt32(off('X'), 7, true);
    view.setFloat64(off('GpsTime'), 123456.75, true);
  });
  const decoded = decodeEptBinaryTile(tile, 1, schema, [0, 0, 0]);
  expect(decoded.positions[0]).toBe(7);
  expect(decoded.gpsTime[0]).toBe(123456.75);
});
