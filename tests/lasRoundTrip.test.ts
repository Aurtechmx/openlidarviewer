/**
 * lasRoundTrip.test.ts — a semantic point record must survive a write.
 *
 * The classification flags were decoded nowhere and written nowhere, so a file
 * marking points Withheld came back as ordinary returns. ASPRS says a producer
 * generally sets Withheld on overlap points culled during flight-line merging,
 * which makes those points ones a consumer is meant to exclude.
 *
 * These tests write a record, read it back through the shared decoder, and
 * require the flags to be the ones that went in. Both layouts are covered,
 * because they store the flags in different places.
 */

import { describe, it, expect } from 'vitest';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import { decodeContext, decodeRecord, allocRawPoints } from '../src/io/lasDecodeShared';
import { parseLasHeader } from '../src/io/lasHeader';
import type { GlobalPoints } from '../src/convert/globalPoints';

const SYNTHETIC = 1;
const KEY_POINT = 2;
const WITHHELD = 4;
const OVERLAP = 8;

function points(classification: Uint8Array, classificationFlags: Uint8Array): GlobalPoints {
  const n = classification.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = i;
    y[i] = i * 2;
    z[i] = i * 3;
  }
  return { count: n, x, y, z, classification, classificationFlags };
}

/** Read every point back out of a written LAS file. */
function readBack(bytes: Uint8Array): { classification: number[]; flags: number[] } {
  const header = parseLasHeader(bytes.buffer as ArrayBuffer);
  const ctx = decodeContext(header, [0, 0, 0]);
  const out = allocRawPoints(header.pointCount, false);
  const view = new DataView(bytes.buffer as ArrayBuffer);
  for (let i = 0; i < header.pointCount; i++) {
    decodeRecord(view, header.offsetToPointData + i * header.pointDataRecordLength, i, ctx, out);
  }
  return {
    classification: [...out.classification],
    flags: [...out.classificationFlags],
  };
}

describe('LAS 1.2 round trip', () => {
  it('returns the classes and the three legacy flags unchanged', () => {
    const cls = new Uint8Array([2, 6, 9, 2]);
    const flags = new Uint8Array([SYNTHETIC, KEY_POINT, WITHHELD, SYNTHETIC | KEY_POINT | WITHHELD]);
    const back = readBack(writeLas(points(cls, flags)));
    expect(back.classification).toEqual([2, 6, 9, 2]);
    expect(back.flags).toEqual([...flags]);
  });

  it('keeps a withheld point distinguishable from an ordinary one', () => {
    const cls = new Uint8Array([2, 2]);
    const flags = new Uint8Array([0, WITHHELD]);
    const back = readBack(writeLas(points(cls, flags)));
    expect(back.flags[0]).toBe(0);
    expect(back.flags[1]).toBe(WITHHELD);
  });

  it('carries class 12 through as the class it is', () => {
    const back = readBack(writeLas(points(new Uint8Array([12]), new Uint8Array([0]))));
    expect(back.classification).toEqual([12]);
  });

  it('writes no flags when the source carried none', () => {
    const back = readBack(writeLas(points(new Uint8Array([2, 6]), new Uint8Array([0, 0]))));
    expect(back.flags).toEqual([0, 0]);
  });
});

describe('LAS 1.4 round trip', () => {
  it('returns all four flags and a full 8-bit class', () => {
    const cls = new Uint8Array([2, 20, 200, 6]);
    const flags = new Uint8Array([SYNTHETIC, WITHHELD, OVERLAP, KEY_POINT | OVERLAP]);
    const back = readBack(writeLas14(points(cls, flags)));
    expect(back.classification).toEqual([2, 20, 200, 6]);
    expect(back.flags).toEqual([...flags]);
  });

  it('keeps overlap as a flag beside the base class', () => {
    const back = readBack(writeLas14(points(new Uint8Array([2]), new Uint8Array([OVERLAP]))));
    expect(back.classification).toEqual([2]);
    expect(back.flags).toEqual([OVERLAP]);
  });

  it('round-trips every flag combination', () => {
    const cls = new Uint8Array(16).fill(2);
    const flags = new Uint8Array(16);
    for (let n = 0; n < 16; n++) flags[n] = n;
    const back = readBack(writeLas14(points(cls, flags)));
    expect(back.flags).toEqual([...flags]);
  });
});
