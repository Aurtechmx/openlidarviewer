/**
 * lasVersionConformance.test.ts — what the LAS reader does with a version it
 * was not written against.
 *
 * ASPRS published LAS 1.4 R16 on 2025-08-25 and LAS 1.5 R00 on 2025-08-26.
 * 1.5 removes point data record formats 0-5, removes GeoTIFF CRS encoding in
 * favour of WKT, and adds Max/Min GPS Time to the public header block. The
 * reader here predates 1.5 and branches on `versionMinor >= 4`, so a 1.5 file
 * takes the 1.4 path.
 *
 * That is safe only if the reader locates the variable-length records from the
 * header's own `headerSize` field rather than from a constant, because the
 * added GPS-time fields make a 1.5 public header longer than a 1.4 one. These
 * tests establish which it does, using a file the project's own writer
 * produced and then reshaping its header the way 1.5 lengthens it.
 *
 * Nothing here claims conformance with 1.5. It records how a 1.5-declared file
 * is currently read, so a change in that behaviour is visible.
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

function headerSizeOf(buf: ArrayBuffer): number {
  return new DataView(buf).getUint16(OFFSET_HEADER_SIZE, true);
}

function bufferOf(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * The same file with a 1.5-shaped public header: version minor 5, the header
 * block grown by the two GPS-time fields, and everything after it moved along.
 * Every 1.4 field keeps its offset, which is how the LAS header has always been
 * extended, so a reader that trusts `headerSize` sees no difference.
 */
function reshapeAs15(las: Uint8Array): ArrayBuffer {
  const src = new DataView(las.buffer, las.byteOffset, las.byteLength);
  const headerSize = src.getUint16(OFFSET_HEADER_SIZE, true);
  const pointOffset = src.getUint32(OFFSET_TO_POINT_DATA, true);

  const out = new Uint8Array(las.byteLength + LAS_1_5_HEADER_GROWTH);
  out.set(las.subarray(0, headerSize), 0);
  // The appended fields read as zero, which is what an unset Max/Min GPS Time
  // looks like. Everything from the first VLR onward follows them unchanged.
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

  it('writes 1.4, and the writer is the baseline for the comparison', () => {
    expect(base.versionMinor).toBe(4);
    expect(base.pointCount).toBe(3);
    // `headerSize` is read from the file rather than the parse result, which
    // does not surface it.
    expect(headerSizeOf(bufferOf(las14))).toBe(375);
  });

  it('reads a 1.5-declared header through the 1.4 path', () => {
    const h = parseLasHeader(reshapeAs15(las14));
    expect(h.versionMinor).toBe(5);
    // The uint64 point count sits at the same offset in both, so the 1.4 branch
    // reads it correctly rather than falling back to the legacy uint32.
    expect(h.pointCount).toBe(base.pointCount);
  });

  it('carries every geometric field across unchanged', () => {
    const h = parseLasHeader(reshapeAs15(las14));
    expect(h.scale).toEqual(base.scale);
    expect(h.offset).toEqual(base.offset);
    expect(h.min).toEqual(base.min);
    expect(h.max).toEqual(base.max);
  });

  it('finds the VLRs after the longer header, so the CRS still resolves', () => {
    const h = parseLasHeader(reshapeAs15(las14));
    // The CRS lives in a VLR that moved 16 bytes along. A reader using a fixed
    // 375-byte header would read the wrong bytes here and lose the CRS.
    expect(h.crs).not.toBeNull();
    expect(h.crs).toEqual(base.crs);
    expect(headerSizeOf(reshapeAs15(las14))).toBe(
      headerSizeOf(bufferOf(las14)) + LAS_1_5_HEADER_GROWTH,
    );
    expect(h.offsetToPointData).toBe(base.offsetToPointData + LAS_1_5_HEADER_GROWTH);
  });

  it('would lose the CRS if the header block grew and the reader ignored it', () => {
    // Negative control for the test above. Growing the header without updating
    // `headerSize` is what a fixed-layout reader effectively does, and it must
    // not still produce the right answer, otherwise the previous test proves
    // nothing about where the VLRs were found.
    const grown = reshapeAs15(las14);
    new DataView(grown).setUint16(OFFSET_HEADER_SIZE, headerSizeOf(bufferOf(las14)), true);
    const h = parseLasHeader(grown);
    expect(h.crs).not.toEqual(base.crs);
  });
});
