/**
 * e57LibE57FormatCorpus.test.ts
 *
 * The reader measured against files another implementation wrote.
 *
 * Fixtures come from the libE57Format test-data corpus
 * (asmaloney/libE57Format-test-data, CC0-1.0) and sit in
 * `tests/fixtures/e57-libe57format/`. Two of them are the same coloured cube
 * written at two float precisions, which is the cross-encoding case no other
 * E57 suite here covers; the rest are damaged or degenerate by construction,
 * each isolating one failure mode.
 *
 * The malformed cases assert the SPECIFIC message, not merely that something
 * threw. A structural guard that starts firing in place of a different one
 * still refuses the file, so a bare `toThrow()` would stay green while the
 * reader lost the ability to say what is wrong with it.
 *
 * PDAL 2.10.2 `readers.e57` refuses `bad-crc.e57` and `InvalidFileLength.e57`
 * too. On `ZeroPointsInvalid.e57` and `InvalidCVHeader.e57` this reader is
 * stricter than PDAL: both declare `recordCount="0"`, so libE57Format never
 * reads the CompressedVector section header and reports an empty scan, while
 * this reader validates the section header before consulting the record count
 * and refuses the file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57 } from '../src/io/e57/parseE57';
import type { E57ScanData } from '../src/io/e57/parseE57';
import { decodeCompressedVector } from '../src/io/e57/compressedVector';
import type { E57Field } from '../src/io/e57/schema';

const DIR = fileURLToPath(new URL('./fixtures/e57-libe57format/', import.meta.url));

function fixture(name: string): ArrayBuffer {
  const b = readFileSync(DIR + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/**
 * The single-precision cube stores each coordinate in IEEE binary32, whose
 * 24-bit significand carries about 7.2 decimal digits, so a coordinate inside
 * this cube's declared [-0.5, 0.5] range can sit at most one ulp at magnitude
 * 0.5 (2^-24, about 6e-8) away from the double-precision value of the same
 * point; 1e-7 is that spacing rounded up to the next decade.
 */
const FLOAT32_TOLERANCE = 1e-7;

const AXES = ['cartesianX', 'cartesianY', 'cartesianZ'] as const;
const COLOURS = ['colorRed', 'colorGreen', 'colorBlue'] as const;

describe('parseE57 — the same cube at two float precisions', () => {
  const float = parseE57(fixture('ColouredCubeFloat.e57'));
  const double = parseE57(fixture('ColouredCubeDouble.e57'));

  it('reads both files as one scan holding the same number of points', () => {
    expect(float.scans).toHaveLength(1);
    expect(double.scans).toHaveLength(1);
    expect(float.scans[0].recordCount).toBe(7680);
    expect(double.scans[0].recordCount).toBe(7680);
  });

  it('takes the declared precision from the prototype', () => {
    const widths = (scan: E57ScanData): number[] =>
      AXES.map((a) => scan.fields.find((f) => f.name === a)!.floatBytes ?? 8);
    expect(widths(float.scans[0])).toEqual([4, 4, 4]);
    expect(widths(double.scans[0])).toEqual([8, 8, 8]);
  });

  it('agrees point for point on geometry within the binary32 spacing', () => {
    const f = float.scans[0].columns;
    const d = double.scans[0].columns;
    // Per point, not per bounding box: identical bounds are also what a
    // decoder that permuted the records would report.
    for (const axis of AXES) {
      let worst = 0;
      let worstAt = -1;
      for (let i = 0; i < 7680; i++) {
        const delta = Math.abs(f[axis][i] - d[axis][i]);
        if (delta > worst) {
          worst = delta;
          worstAt = i;
        }
      }
      expect(
        worst,
        `${axis} diverges by ${worst} at point ${worstAt}`,
      ).toBeLessThanOrEqual(FLOAT32_TOLERANCE);
    }
  });

  it('agrees point for point on colour', () => {
    const f = float.scans[0].columns;
    const d = double.scans[0].columns;
    // Colour is an 8-bit Integer field in both files, so the float precision
    // of the coordinates cannot move it: exact equality or the decode is wrong.
    for (const colour of COLOURS) {
      let mismatches = 0;
      for (let i = 0; i < 7680; i++) {
        if (f[colour][i] !== d[colour][i]) mismatches++;
      }
      expect(mismatches, `${colour} mismatched at ${mismatches} point(s)`).toBe(0);
    }
    // A cube of all-black or all-white points would satisfy the loop above,
    // so pin that the colour actually varies across the corpus values.
    const distinct = new Set<number>();
    for (let i = 0; i < 7680; i++) distinct.add(f.colorRed[i]);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('decodes both cubes inside the declared prototype range', () => {
    for (const scan of [float.scans[0], double.scans[0]]) {
      for (const axis of AXES) {
        const column = scan.columns[axis];
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < column.length; i++) {
          if (column[i] < min) min = column[i];
          if (column[i] > max) max = column[i];
        }
        expect(min).toBeCloseTo(-0.5, 6);
        expect(max).toBeCloseTo(0.5, 6);
      }
    }
  });
});

describe('parseE57 — a CompressedVector holding zero records', () => {
  it('reads ZeroPoints.e57 as one scan with no points', () => {
    // The file is well formed: its section header at physical offset 48 carries
    // section type 1, and libE57Format closed the section with an 8-byte data
    // packet declaring no bytestreams. The standard sets no lower bound on
    // recordCount, so the scan decodes with every prototype column empty.
    const parsed = parseE57(fixture('ZeroPoints.e57'));
    expect(parsed.scans).toHaveLength(1);
    expect(parsed.scans[0].recordCount).toBe(0);
    expect(parsed.scans[0].fields.map((f) => f.name)).toEqual([...AXES]);
    for (const axis of AXES) {
      expect(parsed.scans[0].columns[axis]).toHaveLength(0);
    }
  });
});

/**
 * A de-paged buffer holding one CompressedVector section and one data packet,
 * shaped like the ZeroPoints section above: section header at logical 0, an
 * 8-byte packet at logical 32, section length 40. Page size 1024 keeps every
 * offset here inside page 0, so logical and physical offsets coincide.
 */
function sectionWithOnePacket(bytestreamCount: number): Uint8Array {
  const logical = new Uint8Array(64);
  const view = new DataView(logical.buffer);
  logical[0] = 1; // CompressedVector section
  view.setBigUint64(8, 40n, true); // section logical length
  view.setBigUint64(16, 32n, true); // data physical offset
  logical[32] = 1; // data packet
  view.setUint16(34, 7, true); // packet length minus 1
  view.setUint16(36, bytestreamCount, true);
  return logical;
}

const THREE_SINGLES: E57Field[] = AXES.map((name) => ({
  name,
  type: 'float',
  floatBytes: 4,
}));

describe('decodeCompressedVector — the zero-record relaxation stays narrow', () => {
  /** Decode `records` records out of a section whose packet declares `streams`. */
  const decode = (streams: number, records: number): Record<string, Float64Array> =>
    decodeCompressedVector(sectionWithOnePacket(streams), 0, records, THREE_SINGLES, 1024);

  it('accepts an empty packet when the record count is zero', () => {
    const columns = decode(0, 0);
    expect(Object.keys(columns)).toEqual([...AXES]);
    for (const axis of AXES) expect(columns[axis]).toHaveLength(0);
  });

  it('refuses an empty packet when the file declares records', () => {
    expect(() => decode(0, 1)).toThrow(
      'E57: packet bytestream count does not match the prototype.',
    );
  });

  it('refuses a packet that declares fewer bytestreams than the prototype has fields', () => {
    expect(() => decode(2, 0)).toThrow(
      'E57: packet bytestream count does not match the prototype.',
    );
  });
});

describe('parseE57 — malformed files are refused by name', () => {
  it('refuses a file whose page checksum does not match its bytes', () => {
    // The only corruption in this suite produced by an independent
    // implementation. `e57PageChecksums.test.ts` damages buffers it built
    // itself, which cannot show that the CRC-32C variant, byte order and page
    // layout agree with another writer's idea of the same contract.
    expect(() => parseE57(fixture('bad-crc.e57'))).toThrow(
      /page 0 of 1 failed its CRC-32C checksum/,
    );
  });

  it('refuses a file shorter than its header declares', () => {
    expect(() => parseE57(fixture('InvalidFileLength.e57'))).toThrow(
      'E57 file is truncated: the header declares 2048 bytes but only 120 are present.',
    );
  });

  it('refuses a file that declares no 3D scans', () => {
    expect(() => parseE57(fixture('empty.e57'))).toThrow(
      'E57: the file contains no 3D scans.',
    );
  });

  it('refuses a scan with no point prototype', () => {
    expect(() => parseE57(fixture('NoPrototype.e57'))).toThrow(
      'E57: a scan has no point prototype.',
    );
  });

  it('refuses a corrupted CompressedVector section header', () => {
    // Byte for byte the ZeroPoints file above, with the section type byte
    // changed from 1 to 0xb6. The zero record count does not excuse it: the
    // section header is read before the record count is consulted.
    expect(() => parseE57(fixture('InvalidCVHeader.e57'))).toThrow(
      'E57: expected a CompressedVector section.',
    );
  });

  it('refuses a scan whose fileOffset does not point at a section', () => {
    // ZeroPointsInvalid declares fileOffset="0", which addresses the file
    // header rather than a CompressedVector section.
    expect(() => parseE57(fixture('ZeroPointsInvalid.e57'))).toThrow(
      'E57: expected a CompressedVector section.',
    );
  });
});
