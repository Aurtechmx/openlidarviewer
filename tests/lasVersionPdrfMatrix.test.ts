/**
 * lasVersionPdrfMatrix.test.ts — a record layout that cannot hold its format
 * is refused before a point is decoded.
 *
 * The decoder addresses every field by a fixed offset from the record start.
 * A record shorter than its format requires therefore does not lose a field at
 * the end: it puts the classification, the return bits and the point source id
 * inside the NEXT record, and they decode into plausible values that belong to
 * a different point. Nothing checked the declared length against the format.
 *
 * The minimums are the ASPRS LAS Specification 1.4 R15 figures, Tables 7 and
 * 10 to 21.
 */

import { describe, it, expect } from 'vitest';
import {
  MINIMUM_RECORD_LENGTH,
  minimumRecordLength,
  recordLengthFitsFormat,
  isValidPdrf,
} from '../src/lasSemantics';
import { parseLasHeader } from '../src/io/lasHeader';

describe('the specification minimums', () => {
  it.each([
    [0, 20], [1, 28], [2, 26], [3, 34], [4, 57], [5, 63],
    [6, 30], [7, 36], [8, 38], [9, 59], [10, 67],
  ])('format %i needs %i bytes', (pdrf, bytes) => {
    expect(MINIMUM_RECORD_LENGTH[pdrf as 0]).toBe(bytes);
    expect(minimumRecordLength(pdrf)).toBe(bytes);
  });

  it('has an entry for every format the specification defines and none beyond', () => {
    for (let p = 0; p <= 10; p++) expect(isValidPdrf(p)).toBe(true);
    expect(Object.keys(MINIMUM_RECORD_LENGTH)).toHaveLength(11);
    expect(minimumRecordLength(11)).toBeNull();
    expect(minimumRecordLength(-1)).toBeNull();
  });
});

describe('a declared record length against its format', () => {
  it('accepts the exact minimum', () => {
    expect(recordLengthFitsFormat(0, 20)).toBe(true);
    expect(recordLengthFitsFormat(6, 30)).toBe(true);
  });

  it('accepts a longer record, which carries Extra Bytes', () => {
    expect(recordLengthFitsFormat(0, 24)).toBe(true);
    expect(recordLengthFitsFormat(6, 61)).toBe(true);
  });

  it('refuses a record one byte short', () => {
    expect(recordLengthFitsFormat(0, 19)).toBe(false);
    expect(recordLengthFitsFormat(6, 29)).toBe(false);
  });

  it('refuses a format that is not one of the eleven', () => {
    expect(recordLengthFitsFormat(11, 100)).toBe(false);
  });
});

/** A minimal LAS 1.2 header declaring `pdrf` and `recordLength`. */
function header(pdrf: number, recordLength: number): ArrayBuffer {
  const buf = new ArrayBuffer(375);
  const v = new DataView(buf);
  for (const [i, ch] of [...'LASF'].entries()) v.setUint8(i, ch.charCodeAt(0));
  v.setUint8(24, 1); // version major
  v.setUint8(25, 2); // version minor
  v.setUint16(94, 227, true); // header size
  v.setUint32(96, 227, true); // offset to point data
  v.setUint8(104, pdrf);
  v.setUint16(105, recordLength, true);
  v.setUint32(107, 1, true); // point count
  for (const off of [131, 139, 147]) v.setFloat64(off, 0.001, true); // scale
  return buf;
}

describe('the header refuses a layout it cannot decode', () => {
  it('accepts a record that fits its format', () => {
    expect(() => parseLasHeader(header(0, 20))).not.toThrow();
    expect(() => parseLasHeader(header(3, 34))).not.toThrow();
  });

  it('refuses a record shorter than its format requires', () => {
    expect(() => parseLasHeader(header(0, 19))).toThrow(/shorter than the 20 bytes/);
    expect(() => parseLasHeader(header(3, 20))).toThrow(/shorter than the 34 bytes/);
  });

  it('names the format and both lengths, so the file can be identified', () => {
    expect(() => parseLasHeader(header(6, 29))).toThrow(/record length 29/);
    expect(() => parseLasHeader(header(6, 29))).toThrow(/format 6/);
  });

  it('refuses a point data record format the specification does not define', () => {
    expect(() => parseLasHeader(header(12, 100))).toThrow(/not one the specification defines/);
  });
});
