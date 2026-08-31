/**
 * lasVersionConformance.test.ts — what the LAS reader does with a version it
 * was not written against.
 *
 * ASPRS published LAS 1.4 R16 on 2025-08-25 and LAS 1.5 R00 on 2025-08-26.
 * 1.5 removes point data record formats 0-5, removes GeoTIFF CRS encoding in
 * favour of WKT, adds Max/Min GPS Time to the public header block, and grows
 * the minimum header to 393 bytes. Decoding a 1.5 file through the 1.4 path
 * would silently misinterpret those fields, so the reader recognises a 1.5
 * declaration and refuses it rather than producing a wrong-but-confident
 * decode.
 *
 * These tests pin that fail-closed behaviour: a 1.5-declared header is refused
 * with an accurate message, while LAS 1.4 continues to parse. They use a file
 * the project's own writer produced, reshaped the way 1.5 lengthens the header.
 */

import { describe, it, expect } from 'vitest';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { writeLas14 } from '../src/convert/writeLas';
import { parseLasHeader } from '../src/io/lasHeader';

/** Public-header field offsets this test reshapes. */
const OFFSET_VERSION_MINOR = 25;
const OFFSET_HEADER_SIZE = 94;
const OFFSET_TO_POINT_DATA = 96;

/** Two float64 fields: the Max/Min GPS Time 1.5 appends to the header block. */
const LAS_1_5_HEADER_GROWTH = 16;

function sample(): GlobalPoints {
  return {
    count: 3,
    x: Float64Array.from([500000.123, 500001.5, 500002.0]),
    y: Float64Array.from([4100000.0, 4100000.25, 4100001.0]),
    z: Float64Array.from([12.34, 13.0, 14.5]),
  };
}

function bufferOf(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * The same file with a 1.5-shaped public header: version minor 5, the header
 * block grown by the two GPS-time fields, and everything after it moved along.
 * Every 1.4 field keeps its offset, which is how the LAS header has always been
 * extended, so only the version byte marks it as 1.5.
 */
function reshapeAs15(las: Uint8Array): ArrayBuffer {
  const src = new DataView(las.buffer, las.byteOffset, las.byteLength);
  const headerSize = src.getUint16(OFFSET_HEADER_SIZE, true);
  const pointOffset = src.getUint32(OFFSET_TO_POINT_DATA, true);

  const out = new Uint8Array(las.byteLength + LAS_1_5_HEADER_GROWTH);
  out.set(las.subarray(0, headerSize), 0);
  out.set(las.subarray(headerSize), headerSize + LAS_1_5_HEADER_GROWTH);

  const dst = new DataView(out.buffer);
  dst.setUint8(OFFSET_VERSION_MINOR, 5);
  dst.setUint16(OFFSET_HEADER_SIZE, headerSize + LAS_1_5_HEADER_GROWTH, true);
  dst.setUint32(OFFSET_TO_POINT_DATA, pointOffset + LAS_1_5_HEADER_GROWTH, true);
  return out.buffer;
}

describe('LAS version conformance', () => {
  const las14 = writeLas14(sample(), { epsg: 32611, isGeographic: false });
  const base = parseLasHeader(bufferOf(las14));

  it('writes and parses LAS 1.4 (the supported version) unchanged', () => {
    expect(base.versionMinor).toBe(4);
    expect(base.pointCount).toBe(3);
    expect(base.crs).not.toBeNull();
  });

  it('refuses a 1.5-declared header rather than decoding it as 1.4', () => {
    expect(() => parseLasHeader(reshapeAs15(las14))).toThrow(/LAS 1\.5/);
    expect(() => parseLasHeader(reshapeAs15(las14))).toThrow(/not supported/i);
  });

  it('refuses before reading any 1.4-path point-count or CRS field', () => {
    // The refusal must fire on the version alone — not depend on the reshaped
    // header being otherwise well-formed — so a malformed 1.5 file is still
    // refused for being 1.5, not for a downstream parse error.
    let message = '';
    try {
      parseLasHeader(reshapeAs15(las14));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/1\.4 path/);
    expect(message).toMatch(/convert/i);
  });

  it('still refuses when the header was not lengthened (version byte alone)', () => {
    // A file that only sets the version byte to 5 without the 1.5 header growth
    // must also be refused: recognition keys on the declared version, not on
    // the header size.
    const onlyVersion = bufferOf(las14).slice(0);
    new DataView(onlyVersion).setUint8(OFFSET_VERSION_MINOR, 5);
    expect(() => parseLasHeader(onlyVersion)).toThrow(/LAS 1\.5/);
  });
});
