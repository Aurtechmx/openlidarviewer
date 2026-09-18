/**
 * lasDecodeFlags.test.ts — the decoder must keep the classification flags.
 *
 * Before this, nothing in the application read them: the legacy class byte was
 * masked with 0x1f, which drops Synthetic, Key-Point and Withheld, and the
 * extended flags byte was not read at all. A file that marked points Withheld,
 * which ASPRS says a producer generally does for overlap points culled during
 * flight-line merging, arrived indistinguishable from ordinary returns.
 *
 * Both layouts are normalised to the extended bit values so one representation
 * reaches the rest of the application.
 */

import { describe, it, expect } from 'vitest';
import { decodeContext, decodeRecord, allocRawPoints } from '../src/io/lasDecodeShared';
import type { LasHeader } from '../src/io/lasHeader';

const header = (pointFormat: number): LasHeader =>
  ({
    pointFormat,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    pointDataRecordLength: pointFormat >= 6 ? 30 : 20,
  }) as unknown as LasHeader;

/** One record wide enough for either layout, with a byte set at `at`. */
function record(at: number, value: number): DataView {
  const buf = new ArrayBuffer(64);
  new DataView(buf).setUint8(at, value);
  return new DataView(buf);
}

const SYNTHETIC = 1;
const KEY_POINT = 2;
const WITHHELD = 4;
const OVERLAP = 8;

describe('legacy formats carry the flags in the class byte', () => {
  it.each([
    ['synthetic', 0x20, SYNTHETIC],
    ['key-point', 0x40, KEY_POINT],
    ['withheld', 0x80, WITHHELD],
  ])('reads %s and keeps the class intact', (_name, bit, expected) => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false);
    decodeRecord(record(15, 2 | bit), 0, 0, ctx, out);
    expect(out.classification[0]).toBe(2);
    expect(out.classificationFlags[0]).toBe(expected);
  });

  it('reads all three at once', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false);
    decodeRecord(record(15, 6 | 0x20 | 0x40 | 0x80), 0, 0, ctx, out);
    expect(out.classification[0]).toBe(6);
    expect(out.classificationFlags[0]).toBe(SYNTHETIC | KEY_POINT | WITHHELD);
  });

  it('reports no flags for a plain class', () => {
    const ctx = decodeContext(header(1), [0, 0, 0]);
    const out = allocRawPoints(1, false);
    decodeRecord(record(15, 2), 0, 0, ctx, out);
    expect(out.classificationFlags[0]).toBe(0);
  });
});

describe('extended formats carry the flags in their own byte', () => {
  it.each([
    ['synthetic', 0x1, SYNTHETIC],
    ['key-point', 0x2, KEY_POINT],
    ['withheld', 0x4, WITHHELD],
    ['overlap', 0x8, OVERLAP],
  ])('reads %s from the flags byte', (_name, bit, expected) => {
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false);
    decodeRecord(record(15, bit), 0, 0, ctx, out);
    expect(out.classificationFlags[0]).toBe(expected);
  });

  it('does not mistake the scanner channel for a flag', () => {
    // Bits 4 and 5 of the same byte are the scanner channel, not flags.
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false);
    decodeRecord(record(15, 0x30), 0, 0, ctx, out);
    expect(out.classificationFlags[0]).toBe(0);
  });

  it('keeps a full 8-bit class beside its flags', () => {
    const ctx = decodeContext(header(6), [0, 0, 0]);
    const out = allocRawPoints(1, false);
    const view = record(15, OVERLAP);
    view.setUint8(16, 200);
    decodeRecord(view, 0, 0, ctx, out);
    expect(out.classification[0]).toBe(200);
    expect(out.classificationFlags[0]).toBe(OVERLAP);
  });
});
