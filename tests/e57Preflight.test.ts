/**
 * e57Preflight.test.ts
 *
 * The E57 preflight: what a file declares about itself, read without decoding
 * a point.
 *
 * LAS/LAZ get a budget plan because their public header is in the head slice.
 * E57's equivalent facts — a `recordCount` and a prototype per scan — live in
 * the XML section instead, which the 48-byte header locates exactly. Reading
 * them costs the head slice plus the pages the XML occupies: tens of KB on a
 * 600 MB file. That is the whole basis for planning an E57 decode before it
 * allocates, so this file pins both halves — the two-slice read path a caller
 * holding a `File` uses, and the summary the plan is built from.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  preflightE57,
  preflightE57FromXmlPages,
  e57XmlPageRun,
  e57XmlPageRunFromHead,
  summariseE57Scans,
  e57FieldIsConsumed,
  e57LocalFieldName,
  E57_CONSUMED_FIELDS,
} from '../src/io/e57/preflight';
import { parseE57Header } from '../src/io/e57/header';
import type { E57Scan, E57Field } from '../src/io/e57/schema';

const HEAD_SLICE_BYTES = 16384;

function read(path: string): ArrayBuffer {
  const b = readFileSync(new URL(path, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/**
 * The two-slice read a caller holding a `File` performs: a head slice for the
 * header, then exactly the pages the XML lives on. Returns the bytes read
 * alongside the result so the test can assert the cost, not just the answer.
 */
function preflightByTwoSlices(file: ArrayBuffer): {
  result: ReturnType<typeof preflightE57>;
  bytesRead: number;
} {
  const head = file.slice(0, Math.min(HEAD_SLICE_BYTES, file.byteLength));
  const run = e57XmlPageRunFromHead(head, file.byteLength);
  const pages = new Uint8Array(file, run.physicalStart, run.physicalEnd - run.physicalStart);
  return {
    result: preflightE57FromXmlPages(pages, run),
    bytesRead: head.byteLength + pages.length,
  };
}

describe('E57 preflight — committed fixtures', () => {
  it('recovers the record count and attributes of a colour + intensity scan', () => {
    const pre = preflightE57(read('./pumpARowColumnIndexNoInvalidPoints.e57'));
    expect(pre.scanCount).toBe(1);
    expect(pre.mergeableScanCount).toBe(1);
    expect(pre.recordCount).toBe(155_201);
    expect(pre.skippedRecordCount).toBe(0);
    expect(pre.attributes).toEqual({
      hasColor: true,
      hasIntensity: true,
      hasClassification: false,
      hasNormals: false,
    });
  });

  it('counts only the columns the loader consumes', () => {
    // Eight Float64 point columns — cartesian x/y/z + invalid state + colour
    // x3 + intensity — at eight bytes each, plus the two Uint16 index columns
    // this scan's grid declaration earns it.
    const pre = preflightE57(read('./pumpARowColumnIndexNoInvalidPoints.e57'));
    expect(pre.decodeBytesPerRecord).toBe(8 * 8 + 2 + 2);
  });

  it('recovers a bare Float scan with no attributes', () => {
    const pre = preflightE57(read('./bunnyFloat.e57'));
    expect(pre.recordCount).toBe(30_571);
    expect(pre.attributes.hasColor).toBe(false);
    expect(pre.attributes.hasIntensity).toBe(false);
  });

  it('resolves namespaced normals by their local name', () => {
    // Normals ride the `nor:` surface-normals extension, so the prototype keys
    // are `nor:normalX` and friends. `loadE57` resolves them by local name and
    // the preflight has to agree, or the estimate misses 12 bytes a point.
    const pre = preflightE57(read('./fixtures/synthetic-normals.e57'));
    expect(pre.attributes.hasNormals).toBe(true);
  });

  it('the two-slice read agrees with the whole-buffer read', () => {
    for (const path of [
      './pumpARowColumnIndexNoInvalidPoints.e57',
      './bunnyFloat.e57',
      './fixtures/synthetic.e57',
      './fixtures/e57-libe57format/ColouredCubeFloat.e57',
    ]) {
      const file = read(path);
      expect(preflightByTwoSlices(file).result).toEqual(preflightE57(file));
    }
  });

  it('reads a small fraction of the file, not the file', () => {
    // The claim the whole preflight rests on. On the 2.6 MB fixture the XML is
    // a few KB; the ratio only improves as files grow, because the XML section
    // describes scans rather than points.
    const file = read('./pumpARowColumnIndexNoInvalidPoints.e57');
    const { bytesRead } = preflightByTwoSlices(file);
    expect(bytesRead).toBeLessThan(file.byteLength / 10);
  });
});

describe('E57 preflight — refusals', () => {
  it('refuses a corrupt XML page rather than planning from damaged bytes', () => {
    const file = read('./pumpARowColumnIndexNoInvalidPoints.e57');
    const head = file.slice(0, HEAD_SLICE_BYTES);
    const run = e57XmlPageRunFromHead(head, file.byteLength);
    const pages = new Uint8Array(
      file.slice(run.physicalStart, run.physicalEnd),
    );
    pages[run.logicalOffset + 8] ^= 0xff;
    expect(() => preflightE57FromXmlPages(pages, run)).toThrow(/CRC-32C/);
  });

  it('refuses a header whose XML section runs past the file', () => {
    const file = read('./bunnyFloat.e57');
    const header = parseE57Header(file);
    expect(() =>
      e57XmlPageRun({ ...header, xmlLogicalLength: header.filePhysicalLength * 2 }),
    ).toThrow(/past the file/);
  });

  it('refuses an XML offset that points into a page checksum', () => {
    const file = read('./bunnyFloat.e57');
    const header = parseE57Header(file);
    // The last four bytes of a 1024-byte page are the CRC trailer, not payload.
    expect(() => e57XmlPageRun({ ...header, xmlPhysicalOffset: 1021 })).toThrow(
      /page checksum/,
    );
  });

  it('reads the header out of a head slice without calling the file truncated', () => {
    // `parseE57Header` compares the declared length against the buffer it was
    // handed. A head slice is shorter than the file by design, so the preflight
    // has to pass the real length or every large file reads as truncated.
    const file = read('./bunnyFloat.e57');
    const head = file.slice(0, 128);
    expect(() => parseE57Header(head)).toThrow(/truncated/);
    expect(parseE57Header(head, file.byteLength).pageSize).toBe(1024);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// summariseE57Scans — the attribute rules, mirrored from loadE57
// ────────────────────────────────────────────────────────────────────────────

function field(name: string): E57Field {
  return { name, type: 'float', floatBytes: 8 };
}

function scan(name: string, recordCount: number, fields: string[]): E57Scan {
  return {
    name,
    guid: `guid-${name}`,
    recordCount,
    fileOffset: 0,
    prototype: fields.map(field),
    pose: null,
    colorMax: null,
    intensityMax: null,
    indexBounds: null,
    structuredFields: {
      rowIndex: fields.includes('rowIndex'),
      columnIndex: fields.includes('columnIndex'),
      returnIndex: fields.includes('returnIndex'),
      returnCount: fields.includes('returnCount'),
      sphericalRange: fields.includes('sphericalRange'),
    },
  };
}

const XYZ = ['cartesianX', 'cartesianY', 'cartesianZ'];
const RGB = ['colorRed', 'colorGreen', 'colorBlue'];

describe('summariseE57Scans', () => {
  it('an attribute counts only when every mergeable scan carries it', () => {
    const pre = summariseE57Scans([
      scan('a', 100, [...XYZ, ...RGB]),
      scan('b', 100, XYZ),
    ]);
    expect(pre.attributes.hasColor).toBe(false);
  });

  it('a skipped scan cannot veto an attribute the merged scans all carry', () => {
    // The scan with no Cartesian x/y/z contributes no points, so it must
    // contribute nothing to the attribute decision either — the same rule
    // `loadE57` applies when it partitions before deciding.
    const pre = summariseE57Scans([
      scan('cartesian', 100, [...XYZ, ...RGB]),
      scan('spherical', 40, ['sphericalRange', 'sphericalAzimuth']),
    ]);
    expect(pre.attributes.hasColor).toBe(true);
    expect(pre.mergeableScanCount).toBe(1);
    expect(pre.recordCount).toBe(100);
    expect(pre.skippedRecordCount).toBe(40);
  });

  it('a file with no mergeable scan declares no attributes and no records', () => {
    const pre = summariseE57Scans([scan('spherical', 40, ['sphericalRange'])]);
    expect(pre.recordCount).toBe(0);
    expect(pre.decodeBytesPerRecord).toBe(0);
    expect(pre.attributes).toEqual({
      hasColor: false,
      hasIntensity: false,
      hasClassification: false,
      hasNormals: false,
    });
  });

  it('carries the column cost of a skipped scan rather than losing it', () => {
    // The parse decodes every scan's consumed columns, including a scan the
    // merge later drops. Attributing that cost to the records that DO become
    // points keeps the estimate above the real allocation instead of below it.
    const withSkipped = summariseE57Scans([
      scan('cartesian', 100, XYZ),
      scan('extra', 100, [...XYZ, 'intensity']),
    ]);
    const alone = summariseE57Scans([scan('cartesian', 100, XYZ)]);
    expect(withSkipped.decodeBytesPerRecord).toBeGreaterThan(alone.decodeBytesPerRecord);
  });

  it('averages a fractional column count over scans with different prototypes', () => {
    const pre = summariseE57Scans([
      scan('a', 100, XYZ), // 3 consumed
      scan('b', 100, [...XYZ, 'intensity']), // 4 consumed
    ]);
    expect(pre.decodeBytesPerRecord).toBeCloseTo(3.5 * 8, 10);
  });
});

describe('the consumed-field predicate', () => {
  it('strips an extension prefix before matching', () => {
    expect(e57LocalFieldName('nor:normalX')).toBe('normalX');
    expect(e57LocalFieldName('cartesianX')).toBe('cartesianX');
    expect(e57FieldIsConsumed('nor:normalX')).toBe(true);
  });

  it('rejects the columns the loader never reads', () => {
    expect(e57FieldIsConsumed('rowIndex')).toBe(false);
    expect(e57FieldIsConsumed('columnIndex')).toBe(false);
    expect(e57FieldIsConsumed('sphericalRange')).toBe(false);
    expect(e57FieldIsConsumed('rlms:amplitude')).toBe(false);
  });

  it('accepts exactly the twelve fields the merge consumes', () => {
    expect(E57_CONSUMED_FIELDS.size).toBe(12);
    for (const name of E57_CONSUMED_FIELDS) expect(e57FieldIsConsumed(name)).toBe(true);
  });
});
