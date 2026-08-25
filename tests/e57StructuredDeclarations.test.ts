/**
 * e57StructuredDeclarations.test.ts — what a structured E57 DECLARES about its
 * acquisition grid, read without decoding a structured column.
 *
 * An E57 scan written by a terrestrial scanner carries two facts this reader
 * previously discarded: the `indexBounds` structure, which states the row,
 * column and return ranges the writer used, and the prototype's own
 * `rowIndex` / `columnIndex` / `returnIndex` / `returnCount` / `sphericalRange`
 * declarations. Both are needed before an acquisition grid can be preserved,
 * and both are cheap: they are XML, not point data.
 *
 * Nothing here decodes a structured column, builds a frame or widens the set of
 * fields the loader materialises. The point of this file is that the DECISION
 * about whether a scan could carry a grid rests on facts read from the file.
 *
 * `pumpARowColumnIndexNoInvalidPoints.e57` is a genuine libE57-written
 * structured scan (rowIndex + columnIndex + indexBounds); `bunnyFloat.e57` is
 * an unstructured one from the same corpus. Both are from the libE57 Example /
 * Test Data corpus (validation/datasets/dataset-register.yaml, OLV-DS-041).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57Header } from '../src/io/e57/header';
import { depage, physicalToLogical } from '../src/io/e57/depage';
import { parseXml } from '../src/io/e57/xml';
import { crc32c } from '../src/io/e57/crc32c';
import {
  readE57Document,
  e57ScanSupportsStructuredRange,
} from '../src/io/e57/schema';
import type { E57Scan } from '../src/io/e57/schema';
import { parseE57 } from '../src/io/e57/parseE57';
import {
  e57FieldIsConsumed,
  e57FieldIsConsumedForScan,
  e57ConsumedFieldsForScan,
  e57LocalFieldName,
  summariseE57Scans,
} from '../src/io/e57/preflight';

function bufferOf(name: string): ArrayBuffer {
  const b = readFileSync(fileURLToPath(new URL(name, import.meta.url)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** The interpreted document of a real fixture, XML section included. */
function documentOf(buffer: ArrayBuffer): ReturnType<typeof readE57Document> {
  const header = parseE57Header(buffer);
  const { logical } = depage(buffer, header.pageSize, header.filePhysicalLength);
  const start = physicalToLogical(header.xmlPhysicalOffset, header.pageSize);
  const xml = new TextDecoder().decode(
    logical.subarray(start, start + header.xmlLogicalLength),
  );
  return readE57Document(parseXml(xml));
}

const PUMP = bufferOf('./pumpARowColumnIndexNoInvalidPoints.e57');
const BUNNY = bufferOf('./bunnyFloat.e57');
const NORMALS = bufferOf('./fixtures/synthetic-normals.e57');

const pumpScan = (): E57Scan => documentOf(PUMP).scans[0];
const bunnyScan = (): E57Scan => documentOf(BUNNY).scans[0];

/** The smallest scan XML the reader accepts, with the caller's extra elements. */
function scanXml(extra: string, prototype: string): string {
  return `<e57Root>
    <data3D>
      <vectorChild type="Structure">
        <name>Scan</name>
        ${extra}
        <points type="CompressedVector" recordCount="10" fileOffset="0">
          <prototype type="Structure">
            ${prototype}
          </prototype>
        </points>
      </vectorChild>
    </data3D>
  </e57Root>`;
}

const ROW_COL_PROTOTYPE =
  '<cartesianX type="Float"/><cartesianY type="Float"/><cartesianZ type="Float"/>' +
  '<rowIndex type="Integer" minimum="0" maximum="2047"/>' +
  '<columnIndex type="Integer" minimum="0" maximum="511"/>';

const INDEX_BOUNDS_XML =
  '<indexBounds type="Structure">' +
  '<rowMinimum type="Integer">0</rowMinimum><rowMaximum type="Integer">9</rowMaximum>' +
  '<columnMinimum type="Integer">0</columnMinimum><columnMaximum type="Integer">4</columnMaximum>' +
  '</indexBounds>';

function scanOf(extra: string, prototype: string): E57Scan {
  return readE57Document(parseXml(scanXml(extra, prototype))).scans[0];
}

// ────────────────────────────────────────────────────────────────────────────
// A. What the file declares
// ────────────────────────────────────────────────────────────────────────────

describe('E57 indexBounds', () => {
  it('reads the row, column and return ranges a structured scan declares', () => {
    const bounds = pumpScan().indexBounds;
    // Verbatim from the fixture's XML: rowMaximum 1073, columnMaximum 344, and
    // three EMPTY minima plus two empty return elements, which the E57 spec
    // reads as the type's default value (0) rather than as absent.
    expect(bounds).not.toBeNull();
    expect(bounds?.row).toEqual({ minimum: 0, maximum: 1073 });
    expect(bounds?.column).toEqual({ minimum: 0, maximum: 344 });
    expect(bounds?.return).toEqual({ minimum: 0, maximum: 0 });
  });

  it('is null for a scan that declares no indexBounds', () => {
    expect(bunnyScan().indexBounds).toBeNull();
  });

  it('drops an axis whose declared bound is unusable, without throwing', () => {
    const scan = scanOf(
      '<indexBounds type="Structure">' +
        '<rowMinimum type="Integer">0</rowMinimum>' +
        '<rowMaximum type="Integer">garbage</rowMaximum>' +
        '<columnMinimum type="Integer">0</columnMinimum>' +
        '<columnMaximum type="Integer">4</columnMaximum>' +
        '</indexBounds>',
      ROW_COL_PROTOTYPE,
    );
    expect(scan.indexBounds?.row).toBeNull();
    expect(scan.indexBounds?.column).toEqual({ minimum: 0, maximum: 4 });
  });
});

describe('E57 structured prototype declarations', () => {
  it('records which structured fields a structured scan declares', () => {
    const declared = pumpScan().structuredFields;
    expect(declared.rowIndex).toBe(true);
    expect(declared.columnIndex).toBe(true);
    expect(declared.returnIndex).toBe(false);
    expect(declared.returnCount).toBe(false);
    expect(declared.sphericalRange).toBe(false);
  });

  it('records none of them for an unstructured scan', () => {
    expect(bunnyScan().structuredFields).toEqual({
      rowIndex: false,
      columnIndex: false,
      returnIndex: false,
      returnCount: false,
      sphericalRange: false,
    });
  });

  it('resolves a structured field declared under an extension prefix', () => {
    const scan = scanOf('', '<x:rowIndex type="Integer" minimum="0" maximum="7"/>');
    expect(scan.structuredFields.rowIndex).toBe(true);
  });
});

describe('E57 prototype field bounds', () => {
  it('retains the declared maximum alongside the derived bit width', () => {
    const proto = pumpScan().prototype;
    const row = proto.find((f) => f.name === 'rowIndex');
    expect(row?.minimum).toBe(0);
    expect(row?.maximum).toBe(2047);
    expect(row?.bitWidth).toBe(11);
    const x = proto.find((f) => f.name === 'cartesianX');
    expect(x?.maximum).toBe(8388607);
  });

  it('leaves a float field without one', () => {
    expect(bunnyScan().prototype.find((f) => f.name === 'cartesianX')?.maximum).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// B. Eligibility — stated, not acted on
// ────────────────────────────────────────────────────────────────────────────

describe('structured-range eligibility', () => {
  it('accepts a scan that declares both indices and both index bounds', () => {
    expect(e57ScanSupportsStructuredRange(pumpScan())).toBe(true);
  });

  it('rejects a scan that declares no structured fields at all', () => {
    expect(e57ScanSupportsStructuredRange(bunnyScan())).toBe(false);
  });

  it('rejects indices declared without index bounds', () => {
    expect(e57ScanSupportsStructuredRange(scanOf('', ROW_COL_PROTOTYPE))).toBe(false);
  });

  it('rejects index bounds declared without the prototype indices', () => {
    const scan = scanOf(INDEX_BOUNDS_XML, '<cartesianX type="Float"/>');
    expect(e57ScanSupportsStructuredRange(scan)).toBe(false);
  });

  it('rejects a column axis the writer left out of otherwise-present bounds', () => {
    const scan = scanOf(
      '<indexBounds type="Structure">' +
        '<rowMinimum type="Integer">0</rowMinimum><rowMaximum type="Integer">9</rowMaximum>' +
        '</indexBounds>',
      ROW_COL_PROTOTYPE,
    );
    expect(e57ScanSupportsStructuredRange(scan)).toBe(false);
  });

  it('rejects an inverted range, which describes no grid', () => {
    const scan = scanOf(
      '<indexBounds type="Structure">' +
        '<rowMinimum type="Integer">9</rowMinimum><rowMaximum type="Integer">0</rowMaximum>' +
        '<columnMinimum type="Integer">0</columnMinimum><columnMaximum type="Integer">4</columnMaximum>' +
        '</indexBounds>',
      ROW_COL_PROTOTYPE,
    );
    expect(e57ScanSupportsStructuredRange(scan)).toBe(false);
  });

  it('is stated but not acted on: an eligible scan still decodes no index column', () => {
    const parsed = parseE57(PUMP, { keepField: e57FieldIsConsumedForScan });
    expect(Object.keys(parsed.scans[0].columns)).not.toContain('rowIndex');
    expect(Object.keys(parsed.scans[0].columns)).not.toContain('columnIndex');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// C. The decode predicate is now per scan, and decodes exactly what it did
// ────────────────────────────────────────────────────────────────────────────

/** Column names a buffer decodes under a given predicate, per scan, sorted. */
function columnsUnder(
  buffer: ArrayBuffer,
  keepField: (name: string, scan: E57Scan) => boolean,
): string[][] {
  return parseE57(buffer, { keepField }).scans.map((s) => Object.keys(s.columns).sort());
}

describe('the per-scan decode predicate', () => {
  it('decodes exactly the columns the global predicate decoded, on every fixture', () => {
    for (const buffer of [PUMP, BUNNY, NORMALS]) {
      expect(columnsUnder(buffer, e57FieldIsConsumedForScan)).toEqual(
        columnsUnder(buffer, (name) => e57FieldIsConsumed(name)),
      );
    }
  });

  it('materialises only the consumed columns of the structured fixture', () => {
    const [columns] = columnsUnder(PUMP, e57FieldIsConsumedForScan);
    expect(columns).toEqual([
      'cartesianInvalidState',
      'cartesianX',
      'cartesianY',
      'cartesianZ',
      'colorBlue',
      'colorGreen',
      'colorRed',
      'intensity',
    ]);
  });

  it('gives the predicate the scan whose columns it is deciding', () => {
    const seen: string[] = [];
    parseE57(TWO_SCANS, {
      keepField: (name, scan) => {
        if (name === 'cartesianX') seen.push(scan.name);
        return true;
      },
    });
    expect(seen).toEqual(['scan-a', 'scan-b']);
  });

  it('lets one scan keep a column another scan drops', () => {
    const columns = columnsUnder(TWO_SCANS, (name, scan) =>
      scan.name === 'scan-a' ? name !== 'colorRed' : true,
    );
    expect(columns[0]).not.toContain('colorRed');
    expect(columns[1]).toContain('colorRed');
  });

  it('still decodes every column when no predicate is given', () => {
    const columns = parseE57(TWO_SCANS).scans.map((s) => Object.keys(s.columns).sort());
    expect(columns[0]).toEqual(columns[1]);
    expect(columns[0]).toContain('colorRed');
  });
});

describe('the preflight estimate and the decode agree per scan', () => {
  it('counts the columns the decode actually materialises', () => {
    const document = documentOf(PUMP);
    const pre = summariseE57Scans(document.scans);
    const decoded = Object.keys(parseE57(PUMP, { keepField: e57FieldIsConsumedForScan }).scans[0].columns);
    expect(pre.columnsPerRecord).toBe(decoded.length);
  });

  it('derives both from one per-scan consumed set', () => {
    const scan = pumpScan();
    const consumed = e57ConsumedFieldsForScan(scan);
    for (const field of scan.prototype) {
      expect(e57FieldIsConsumedForScan(field.name, scan)).toBe(
        consumed.has(e57LocalFieldName(field.name)),
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A synthetic TWO-scan E57, so "per scan" can be observed at all
//
// Every committed E57 fixture declares exactly one scan, and a single-scan file
// cannot tell a predicate bound to the right scan apart from one bound to the
// first. Two scans with the same prototype and different names can.
// ────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1024;
const PAGE_PAYLOAD = PAGE_SIZE - 4;
const RECORDS = 8;
/** Fixed-width so the XML length does not move when the offsets are filled in. */
const OFFSET_DIGITS = 9;

function logicalToPhysical(logical: number): number {
  return Math.floor(logical / PAGE_PAYLOAD) * PAGE_SIZE + (logical % PAGE_PAYLOAD);
}

function twoScanXml(offsetA: number, offsetB: number): string {
  const scan = (name: string, offset: number): string =>
    '    <vectorChild type="Structure">\n' +
    `      <guid type="String">two-scan-${name}</guid>\n` +
    `      <name type="String">${name}</name>\n` +
    `      <points type="CompressedVector" fileOffset="${String(offset).padStart(OFFSET_DIGITS, '0')}" recordCount="${RECORDS}">\n` +
    '        <prototype type="Structure">\n' +
    '          <cartesianX type="Float" precision="single"/>\n' +
    '          <cartesianY type="Float" precision="single"/>\n' +
    '          <cartesianZ type="Float" precision="single"/>\n' +
    '          <colorRed type="Integer" minimum="0" maximum="255"/>\n' +
    '        </prototype>\n' +
    '        <codecs type="Vector" allowHeterogeneousChildren="1"/>\n' +
    '      </points>\n' +
    '    </vectorChild>\n';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<e57Root type="Structure">\n' +
    '  <formatName type="String">ASTM E57 3D Imaging Data File</formatName>\n' +
    '  <guid type="String">two-scan-fixture</guid>\n' +
    '  <data3D type="Vector" allowHeterogeneousChildren="1">\n' +
    scan('scan-a', offsetA) +
    scan('scan-b', offsetB) +
    '  </data3D>\n' +
    '</e57Root>\n'
  );
}

/** One scan's CompressedVector section, starting at `sectionLogicalStart`. */
function buildSection(sectionLogicalStart: number): Uint8Array {
  const axes = [0, 1, 2].map(() => new Uint8Array(RECORDS * 4));
  const views = axes.map((a) => new DataView(a.buffer));
  const red = new Uint8Array(RECORDS);
  for (let i = 0; i < RECORDS; i++) {
    views[0].setFloat32(i * 4, i, true);
    views[1].setFloat32(i * 4, 2 * i, true);
    views[2].setFloat32(i * 4, 3 * i, true);
    red[i] = i;
  }
  const streams = [...axes, red];
  const count = streams.length;
  const headerLen = 6 + count * 2;
  const packetLength = headerLen + streams.reduce((a, s) => a + s.length, 0);
  const sectionLength = 32 + packetLength;
  const section = new Uint8Array(sectionLength);
  const dv = new DataView(section.buffer);
  section[0] = 1; // COMPRESSED_VECTOR_SECTION
  dv.setBigUint64(8, BigInt(sectionLength), true);
  dv.setBigUint64(16, BigInt(logicalToPhysical(sectionLogicalStart + 32)), true);
  section[32] = 1; // DATA_PACKET
  dv.setUint16(34, packetLength - 1, true);
  dv.setUint16(36, count, true);
  streams.forEach((s, f) => dv.setUint16(38 + f * 2, s.length, true));
  let at = 32 + headerLen;
  for (const s of streams) {
    section.set(s, at);
    at += s.length;
  }
  return section;
}

function buildTwoScanE57(): ArrayBuffer {
  const HEADER_LEN = 48;
  const xmlLogicalStart = HEADER_LEN;
  const xmlLength = Buffer.byteLength(twoScanXml(0, 0), 'utf8');
  const startA = xmlLogicalStart + xmlLength;
  const sectionA = buildSection(startA);
  const startB = startA + sectionA.length;
  const sectionB = buildSection(startB);
  const xmlBytes = Buffer.from(
    twoScanXml(logicalToPhysical(startA), logicalToPhysical(startB)),
    'utf8',
  );
  if (xmlBytes.length !== xmlLength) {
    throw new Error('two-scan XML length moved when the offsets were filled in');
  }

  const logicalLength = startB + sectionB.length;
  const logical = new Uint8Array(logicalLength);
  const hv = new DataView(logical.buffer);
  const SIGNATURE = 'ASTM-E57';
  for (let i = 0; i < SIGNATURE.length; i++) logical[i] = SIGNATURE.charCodeAt(i);
  hv.setUint32(8, 1, true);
  hv.setUint32(12, 0, true);
  hv.setBigUint64(24, BigInt(logicalToPhysical(xmlLogicalStart)), true);
  hv.setBigUint64(32, BigInt(xmlBytes.length), true);
  hv.setBigUint64(40, BigInt(PAGE_SIZE), true);
  logical.set(xmlBytes, xmlLogicalStart);
  logical.set(sectionA, startA);
  logical.set(sectionB, startB);

  const pageCount = Math.ceil(logicalLength / PAGE_PAYLOAD);
  hv.setBigUint64(16, BigInt(pageCount * PAGE_SIZE), true);
  const physical = new Uint8Array(pageCount * PAGE_SIZE);
  for (let p = 0; p < pageCount; p++) {
    const dst = physical.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    dst.set(logical.subarray(p * PAGE_PAYLOAD, (p + 1) * PAGE_PAYLOAD), 0);
    new DataView(dst.buffer, dst.byteOffset + PAGE_PAYLOAD, 4).setUint32(
      0,
      crc32c(dst, 0, PAGE_PAYLOAD),
      false,
    );
  }
  return physical.buffer;
}

const TWO_SCANS = buildTwoScanE57();
