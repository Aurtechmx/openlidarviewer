/**
 * lasGpsTimeType.test.ts — GPS time keeps the meaning its source declared.
 *
 * The LAS header declares, in Global Encoding bit 0, which of two quantities
 * the gpsTime field holds: Adjusted Standard GPS Time when the bit is set, GPS
 * Week Time when it is clear. They are not interchangeable, and one read as the
 * other is wrong by years.
 *
 * The reader never looked at that bit, and the writer declared Adjusted
 * Standard for everything it wrote, on the reasoning that every modern source
 * uses it. A genuine GPS Week Time file therefore came back out carrying its
 * original numbers under a declaration that changed what they meant.
 */

import { describe, it, expect } from 'vitest';
import { parseLasHeader } from '../src/io/lasHeader';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';

const GPS_STANDARD_BIT = 0x1;

/** A LAS header with the given version minor and Global Encoding value. */
function header(versionMinor: number, globalEncoding: number): ArrayBuffer {
  const buf = new ArrayBuffer(375);
  const v = new DataView(buf);
  for (const [i, ch] of [...'LASF'].entries()) v.setUint8(i, ch.charCodeAt(0));
  v.setUint16(6, globalEncoding, true);
  v.setUint8(24, 1);
  v.setUint8(25, versionMinor);
  v.setUint16(94, 227, true);
  v.setUint32(96, 227, true);
  v.setUint8(104, 1); // format 1 carries GPS time
  v.setUint16(105, 28, true);
  v.setUint32(107, 1, true);
  for (const off of [131, 139, 147]) v.setFloat64(off, 0.001, true);
  return buf;
}

describe('reading the declared GPS time type', () => {
  it('reports Adjusted Standard when the bit is set', () => {
    expect(parseLasHeader(header(2, GPS_STANDARD_BIT)).gpsTimeType).toBe('adjusted-standard');
    expect(parseLasHeader(header(4, GPS_STANDARD_BIT)).gpsTimeType).toBe('adjusted-standard');
  });

  it('reports GPS Week Time when the bit is clear', () => {
    expect(parseLasHeader(header(2, 0)).gpsTimeType).toBe('week');
    expect(parseLasHeader(header(4, 0)).gpsTimeType).toBe('week');
  });

  it('reads only bit 0, leaving the other Global Encoding bits alone', () => {
    // Bit 4 declares the CRS VLR is OGC WKT and says nothing about time.
    expect(parseLasHeader(header(4, 0x10)).gpsTimeType).toBe('week');
    expect(parseLasHeader(header(4, 0x10 | GPS_STANDARD_BIT)).gpsTimeType).toBe('adjusted-standard');
  });

  it('declines to answer for a version whose field is reserved', () => {
    // Global Encoding is a bit field from LAS 1.2. Before that the bytes are
    // reserved, so a set bit there declares nothing and must not be read as a
    // claim about time.
    expect(parseLasHeader(header(0, GPS_STANDARD_BIT)).gpsTimeType).toBeNull();
    expect(parseLasHeader(header(1, GPS_STANDARD_BIT)).gpsTimeType).toBeNull();
  });
});

/** Two points carrying a GPS time, so the written format has the field. */
function timed(): GlobalPoints {
  return {
    count: 2,
    x: new Float64Array([0, 1]),
    y: new Float64Array([0, 1]),
    z: new Float64Array([0, 1]),
    gpsTime: new Float64Array([123456.75, 123457.25]),
  };
}

describe('writing the declared GPS time type back out', () => {
  it('declares GPS Week Time when the source did', () => {
    const back = parseLasHeader(writeLas(timed(), { gpsStandardTime: false }).buffer as ArrayBuffer);
    expect(back.gpsTimeType).toBe('week');
  });

  it('declares Adjusted Standard when the source did', () => {
    const back = parseLasHeader(writeLas(timed(), { gpsStandardTime: true }).buffer as ArrayBuffer);
    expect(back.gpsTimeType).toBe('adjusted-standard');
  });

  it('carries the declaration through the extended writer too', () => {
    const week = parseLasHeader(writeLas14(timed(), { gpsStandardTime: false }).buffer as ArrayBuffer);
    const std = parseLasHeader(writeLas14(timed(), { gpsStandardTime: true }).buffer as ArrayBuffer);
    expect(week.gpsTimeType).toBe('week');
    expect(std.gpsTimeType).toBe('adjusted-standard');
  });

  it('keeps the modern default for a source that declared nothing', () => {
    // Not every source is a LAS file. Where nothing was declared the writer
    // keeps its own default rather than inventing a claim about the source.
    const back = parseLasHeader(writeLas(timed()).buffer as ArrayBuffer);
    expect(back.gpsTimeType).toBe('adjusted-standard');
  });
});
