/**
 * e57StructuredRange.test.ts — the acquisition grid a structured E57 carries.
 *
 * The failures pinned here are the ones that look right. A grid sized from the
 * prototype is a grid: it has cells, it has states, and it is 2.7 times the one
 * the file describes. A cell-to-record link built without the invalid-state
 * drop resolves to a record, and from the first casualty onward that record is
 * another point. So every identity assertion below reads the COORDINATES at the
 * resolved index rather than the index itself.
 *
 * `pumpARowColumnIndexNoInvalidPoints.e57` is a real libE57-written structured
 * scan, and its name is the reason it cannot carry this file alone: the invalid
 * records were removed before it was written, so it never exercises the drop.
 * The synthetic files below do.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57Header } from '../src/io/e57/header';
import { depage, physicalToLogical } from '../src/io/e57/depage';
import { parseXml } from '../src/io/e57/xml';
import { crc32c } from '../src/io/e57/crc32c';
import { readE57Document } from '../src/io/e57/schema';
import type { E57Scan } from '../src/io/e57/schema';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import {
  e57FieldIsConsumedForScan,
  summariseE57Scans,
} from '../src/io/e57/preflight';
import {
  e57IntegerWidthFor,
  e57StructuredGridCells,
  e57StructuredRequestsForScan,
} from '../src/io/e57/structuredSink';
import { planE57Decode } from '../src/io/loadPlan';
import type { E57DecodePlan } from '../src/io/loadPlan';
import { CellState, recordForCell, returnsForCell } from '../src/model/OrganizedRange';

function bufferOf(name: string): ArrayBuffer {
  const b = readFileSync(fileURLToPath(new URL(name, import.meta.url)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const PUMP = bufferOf('./pumpARowColumnIndexNoInvalidPoints.e57');
const BUNNY = bufferOf('./bunnyFloat.e57');
const NORMALS = bufferOf('./fixtures/synthetic-normals.e57');

function documentOf(buffer: ArrayBuffer): ReturnType<typeof readE57Document> {
  const header = parseE57Header(buffer);
  const { logical } = depage(buffer, header.pageSize, header.filePhysicalLength);
  const start = physicalToLogical(header.xmlPhysicalOffset, header.pageSize);
  const xml = new TextDecoder().decode(logical.subarray(start, start + header.xmlLogicalLength));
  return readE57Document(parseXml(xml));
}

// ────────────────────────────────────────────────────────────────────────────
// A synthetic structured E57, with invalid records the pump fixture lacks
// ────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1024;
const PAGE_PAYLOAD = PAGE_SIZE - 4;
const OFFSET_DIGITS = 9;

function logicalToPhysical(logical: number): number {
  return Math.floor(logical / PAGE_PAYLOAD) * PAGE_SIZE + (logical % PAGE_PAYLOAD);
}

interface SyntheticRecord {
  x: number;
  y: number;
  z: number;
  row: number;
  column: number;
  /** Non-zero is the file saying the record is unusable. */
  invalid?: number;
  returnIndex?: number;
  returnCount?: number;
  range?: number;
}

interface SyntheticOptions {
  records: SyntheticRecord[];
  /** Declared indexBounds, which is what the grid extent must come from. */
  bounds: { row: [number, number]; column: [number, number] };
  /** Prototype maxima, deliberately wider than the bounds. */
  proto?: { row: number; column: number };
  withReturns?: boolean;
  withRange?: boolean;
}

function bitWidthFor(min: number, max: number): number {
  const range = max - min;
  if (range <= 0) return 0;
  let bits = 0;
  while (2 ** bits <= range) bits++;
  return bits;
}

/** LSB-first bit-packed integers, the layout the decoder reads. */
function packIntegers(values: number[], min: number, bitWidth: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((values.length * bitWidth) / 8) + 1);
  let bit = 0;
  for (const v of values) {
    const packed = v - min;
    for (let k = 0; k < bitWidth; k++) {
      if ((packed >> k) & 1) out[bit >> 3] |= 1 << (bit & 7);
      bit++;
    }
  }
  return out;
}

function floatStream(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out;
}

interface FieldSpec {
  xml: string;
  stream: Uint8Array;
}

function fieldsOf(opts: SyntheticOptions): FieldSpec[] {
  const r = opts.records;
  const proto = opts.proto ?? { row: 2047, column: 511 };
  const specs: FieldSpec[] = [
    { xml: '<cartesianX type="Float" precision="single"/>', stream: floatStream(r.map((p) => p.x)) },
    { xml: '<cartesianY type="Float" precision="single"/>', stream: floatStream(r.map((p) => p.y)) },
    { xml: '<cartesianZ type="Float" precision="single"/>', stream: floatStream(r.map((p) => p.z)) },
    {
      xml: `<rowIndex type="Integer" minimum="0" maximum="${proto.row}"/>`,
      stream: packIntegers(r.map((p) => p.row), 0, bitWidthFor(0, proto.row)),
    },
    {
      xml: `<columnIndex type="Integer" minimum="0" maximum="${proto.column}"/>`,
      stream: packIntegers(r.map((p) => p.column), 0, bitWidthFor(0, proto.column)),
    },
    {
      xml: '<cartesianInvalidState type="Integer" minimum="0" maximum="2"/>',
      stream: packIntegers(r.map((p) => p.invalid ?? 0), 0, bitWidthFor(0, 2)),
    },
  ];
  if (opts.withReturns) {
    specs.push({
      xml: '<returnIndex type="Integer" minimum="0" maximum="3"/>',
      stream: packIntegers(r.map((p) => p.returnIndex ?? 0), 0, bitWidthFor(0, 3)),
    });
    specs.push({
      xml: '<returnCount type="Integer" minimum="0" maximum="3"/>',
      stream: packIntegers(r.map((p) => p.returnCount ?? 1), 0, bitWidthFor(0, 3)),
    });
  }
  if (opts.withRange) {
    specs.push({
      xml: '<sphericalRange type="Float" precision="single"/>',
      stream: floatStream(r.map((p) => p.range ?? 0)),
    });
  }
  return specs;
}

function scanXml(opts: SyntheticOptions, offset: number): string {
  const { row, column } = opts.bounds;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<e57Root type="Structure">\n' +
    '  <formatName type="String">ASTM E57 3D Imaging Data File</formatName>\n' +
    '  <guid type="String">synthetic-structured</guid>\n' +
    '  <data3D type="Vector" allowHeterogeneousChildren="1">\n' +
    '    <vectorChild type="Structure">\n' +
    '      <guid type="String">synthetic-scan</guid>\n' +
    '      <name type="String">grid</name>\n' +
    '      <indexBounds type="Structure">' +
    `<rowMinimum type="Integer">${row[0]}</rowMinimum>` +
    `<rowMaximum type="Integer">${row[1]}</rowMaximum>` +
    `<columnMinimum type="Integer">${column[0]}</columnMinimum>` +
    `<columnMaximum type="Integer">${column[1]}</columnMaximum>` +
    '</indexBounds>\n' +
    `      <points type="CompressedVector" fileOffset="${String(offset).padStart(OFFSET_DIGITS, '0')}" recordCount="${opts.records.length}">\n` +
    '        <prototype type="Structure">\n' +
    fieldsOf(opts)
      .map((f) => `          ${f.xml}\n`)
      .join('') +
    '        </prototype>\n' +
    '        <codecs type="Vector" allowHeterogeneousChildren="1"/>\n' +
    '      </points>\n' +
    '    </vectorChild>\n' +
    '  </data3D>\n' +
    '</e57Root>\n'
  );
}

function buildSection(opts: SyntheticOptions, sectionLogicalStart: number): Uint8Array {
  const streams = fieldsOf(opts).map((f) => f.stream);
  const count = streams.length;
  const headerLen = 6 + count * 2;
  const packetLength = headerLen + streams.reduce((a, s) => a + s.length, 0);
  const sectionLength = 32 + packetLength;
  const section = new Uint8Array(sectionLength);
  const dv = new DataView(section.buffer);
  section[0] = 1;
  dv.setBigUint64(8, BigInt(sectionLength), true);
  dv.setBigUint64(16, BigInt(logicalToPhysical(sectionLogicalStart + 32)), true);
  section[32] = 1;
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

function buildStructuredE57(opts: SyntheticOptions): ArrayBuffer {
  const HEADER_LEN = 48;
  const xmlLogicalStart = HEADER_LEN;
  const xmlLength = Buffer.byteLength(scanXml(opts, 0), 'utf8');
  const start = xmlLogicalStart + xmlLength;
  const section = buildSection(opts, start);
  const xmlBytes = Buffer.from(scanXml(opts, logicalToPhysical(start)), 'utf8');
  if (xmlBytes.length !== xmlLength) throw new Error('XML length moved');

  const logicalLength = start + section.length;
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
  logical.set(section, start);

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

/**
 * A 4-row by 5-column grid whose records are laid out row by row, with every
 * third record flagged invalid by the file. The coordinates encode the cell —
 * x is the row, y is the column — so a resolved record can be checked against
 * the cell that claimed it rather than against an index.
 */
const GRID_ROWS = 4;
const GRID_COLUMNS = 5;
function gridRecords(): SyntheticRecord[] {
  const out: SyntheticRecord[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLUMNS; c++) {
      const ordinal = r * GRID_COLUMNS + c;
      out.push({
        x: 1000 + r,
        y: 2000 + c,
        z: 3000 + ordinal,
        row: r,
        column: c,
        invalid: ordinal % 3 === 0 ? 1 : 0,
        returnIndex: 0,
        returnCount: 1,
        range: 10 + ordinal,
      });
    }
  }
  return out;
}

const GRID_E57 = buildStructuredE57({
  records: gridRecords(),
  bounds: { row: [0, GRID_ROWS - 1], column: [0, GRID_COLUMNS - 1] },
});

/** Every column a parse materialised, in bytes — point columns and structured. */
function decodedBytes(result: ReturnType<typeof parseE57>): number {
  let bytes = 0;
  for (const scan of result.scans) {
    for (const column of Object.values(scan.columns)) bytes += column.byteLength;
    for (const column of Object.values(scan.structured?.columns ?? {})) bytes += column.byteLength;
  }
  return bytes;
}

// ────────────────────────────────────────────────────────────────────────────
// A. An ordinary E57 is untouched
// ────────────────────────────────────────────────────────────────────────────

describe('an E57 with no structured declarations', () => {
  it('decodes the same columns and the same bytes as it did before the sink existed', () => {
    for (const buffer of [BUNNY, NORMALS]) {
      const before = parseE57(buffer, { keepField: e57FieldIsConsumedForScan });
      const after = parseE57(buffer, {
        keepField: e57FieldIsConsumedForScan,
        structuredFor: (scan) => e57StructuredRequestsForScan(scan),
      });
      expect(after.scans.map((s) => Object.keys(s.columns).sort())).toEqual(
        before.scans.map((s) => Object.keys(s.columns).sort()),
      );
      expect(after.scans.every((s) => s.structured === undefined)).toBe(true);
      expect(decodedBytes(after)).toBe(decodedBytes(before));
    }
  });

  it('plans exactly the memory it planned before, and no grid', () => {
    const pre = summariseE57Scans(documentOf(BUNNY).scans, BUNNY.byteLength);
    const columns = Object.keys(
      parseE57(BUNNY, { keepField: e57FieldIsConsumedForScan }).scans[0].columns,
    ).length;
    // The old figure was a COLUMN COUNT multiplied by a flat eight bytes.
    expect(pre.decodeBytesPerRecord).toBe(columns * 8);
    expect(pre.structuredGridBytes).toBe(0);
  });

  it('carries no acquisition grid on the loaded cloud', async () => {
    const cloud = await loadE57(BUNNY, 'bunny.e57');
    expect(cloud.organizedRange).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// B. Extent comes from indexBounds
// ────────────────────────────────────────────────────────────────────────────

describe('the grid extent of a real structured scan', () => {
  it('is the declared indexBounds, not the prototype range', async () => {
    const cloud = await loadE57(PUMP, 'pump.e57');
    const frame = cloud.organizedRange!.frames[0];
    // indexBounds: row 0–1073, column 0–344. The prototype declares rowIndex up
    // to 2047 and columnIndex up to 511, which would be 1 048 576 cells — 2.8
    // times the 370 530 the file actually describes.
    expect(frame.height).toBe(1074);
    expect(frame.width).toBe(345);
    expect(frame.diagnostics.cells).toBe(1074 * 345);
    expect(frame.sourceKind).toBe('e57-structured');
    expect(frame.linkage).toEqual({ kind: 'exact' });
  });

  it('links a cell to a record whose coordinates are that record', async () => {
    const cloud = await loadE57(PUMP, 'pump.e57');
    const frame = cloud.organizedRange!.frames[0];
    const parsed = parseE57(PUMP, {
      keepField: e57FieldIsConsumedForScan,
      structuredFor: (scan) => e57StructuredRequestsForScan(scan),
    });
    const scan = parsed.scans[0];
    const rows = scan.structured!.columns.rowIndex as Uint16Array;
    const columns = scan.structured!.columns.columnIndex as Uint16Array;
    const invalid = scan.columns.cartesianInvalidState;
    for (const i of [0, 1, 977, 40_000, scan.recordCount - 1]) {
      if (invalid && invalid[i] !== 0) continue;
      const resolved = recordForCell(frame, rows[i], columns[i]);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.why);
      const at = cloud.worldXYZ(resolved.record);
      expect(at[0]).toBeCloseTo(scan.columns.cartesianX[i], 3);
      expect(at[1]).toBeCloseTo(scan.columns.cartesianY[i], 3);
      expect(at[2]).toBeCloseTo(scan.columns.cartesianZ[i], 3);
    }
  });

  it('bounds the grid by what the file can supply, never by the declaration', () => {
    const scan = documentOf(PUMP).scans[0];
    expect(e57StructuredGridCells(scan, PUMP.byteLength)).toBe(1074 * 345);
    // The same declaration in an 87-byte file describes a grid nothing backs.
    expect(e57StructuredGridCells(scan, 87)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// C. Identity across the invalid-state drop
// ────────────────────────────────────────────────────────────────────────────

describe('a structured scan whose file flags records invalid', () => {
  it('resolves every valid cell to the coordinates that cell measured', async () => {
    const cloud = await loadE57(GRID_E57, 'grid.e57');
    const frame = cloud.organizedRange!.frames[0];
    expect(frame.width).toBe(GRID_COLUMNS);
    expect(frame.height).toBe(GRID_ROWS);
    for (const record of gridRecords()) {
      const resolved = recordForCell(frame, record.row, record.column);
      if (record.invalid) {
        expect(resolved.ok).toBe(false);
        expect(frame.cellState[record.row * GRID_COLUMNS + record.column]).toBe(
          CellState.SOURCE_INVALID,
        );
        continue;
      }
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.why);
      const at = cloud.worldXYZ(resolved.record);
      expect(at[0]).toBeCloseTo(record.x, 3);
      expect(at[1]).toBeCloseTo(record.y, 3);
      expect(at[2]).toBeCloseTo(record.z, 3);
    }
  });

  it('drops the records the file flagged, so the cloud is shorter than the grid', async () => {
    const cloud = await loadE57(GRID_E57, 'grid.e57');
    const invalidCount = gridRecords().filter((r) => r.invalid).length;
    expect(invalidCount).toBeGreaterThan(0);
    expect(cloud.pointCount).toBe(GRID_ROWS * GRID_COLUMNS - invalidCount);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D. A record the declaration forbids
// ────────────────────────────────────────────────────────────────────────────

describe('a decoded index outside the declared indexBounds', () => {
  const CONTRADICTORY = buildStructuredE57({
    // The bounds say rows 0–3; one record says row 6, which the prototype
    // (maximum 2047) is perfectly happy to carry.
    records: [
      { x: 1, y: 2, z: 3, row: 0, column: 0 },
      { x: 4, y: 5, z: 6, row: 6, column: 1 },
    ],
    bounds: { row: [0, 3], column: [0, 4] },
  });

  it('builds no grid for that scan', async () => {
    const cloud = await loadE57(CONTRADICTORY, 'bad.e57');
    expect(cloud.organizedRange).toBeUndefined();
  });

  it('says so, and keeps the points', async () => {
    const cloud = await loadE57(CONTRADICTORY, 'bad.e57');
    expect(cloud.pointCount).toBe(2);
    expect(
      cloud.metadata?.loadWarnings?.some((w) => /indexBounds/.test(w)),
    ).toBe(true);
  });

  it('refuses a value outside the FIELD bounds without truncating it', () => {
    // A prototype maximum of 5 packs into three bits, which carry 6 and 7 as
    // well. So the file can state a row of 7 for a field it declared to reach
    // 5, and a Uint16Array holds that value without complaint: only a check
    // made before the store can see the contradiction at all.
    const narrow = buildStructuredE57({
      records: [{ x: 1, y: 2, z: 3, row: 7, column: 0 }],
      bounds: { row: [0, 7], column: [0, 4] },
      proto: { row: 5, column: 511 },
    });
    const parsed = parseE57(narrow, {
      keepField: e57FieldIsConsumedForScan,
      structuredFor: (scan) => e57StructuredRequestsForScan(scan),
    });
    expect(parsed.scans[0].structured?.contradiction).toMatch(/rowIndex/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// E. A strided decode
// ────────────────────────────────────────────────────────────────────────────

describe('a structured scan read as a sample', () => {
  const stridePlan = (sourceCount: number, stride: number): E57DecodePlan => ({
    mode: 'stride',
    stride,
    sourceCount,
    decodedCount: Math.ceil(sourceCount / stride),
    memoryEstimateBytes: 0,
    fullDecodeEstimateBytes: 0,
    ceilingBytes: Number.MAX_SAFE_INTEGER,
    fits: true,
  });

  it('marks the cells it did not read, and says the linkage is partial', async () => {
    const cloud = await loadE57(PUMP, 'pump.e57', { plan: stridePlan(155_201, 4) });
    const frame = cloud.organizedRange!.frames[0];
    expect(frame.linkage).toEqual({ kind: 'partial', reason: 'stride' });
    const notDecoded = frame.diagnostics.stateCounts[CellState.NOT_DECODED];
    const valid = frame.diagnostics.stateCounts[CellState.VALID_RETURN];
    expect(notDecoded).toBeGreaterThan(0);
    expect(valid).toBeLessThanOrEqual(Math.ceil(155_201 / 4));
    expect(valid).toBeGreaterThan(0);
  });

  it('still resolves a decoded cell to the right coordinates', async () => {
    const cloud = await loadE57(PUMP, 'pump.e57', { plan: stridePlan(155_201, 4) });
    const frame = cloud.organizedRange!.frames[0];
    const parsed = parseE57(PUMP, {
      keepField: e57FieldIsConsumedForScan,
      structuredFor: (scan) => e57StructuredRequestsForScan(scan),
      stride: 4,
    });
    const scan = parsed.scans[0];
    const rows = scan.structured!.columns.rowIndex as Uint16Array;
    const columns = scan.structured!.columns.columnIndex as Uint16Array;
    const invalid = scan.columns.cartesianInvalidState;
    let checked = 0;
    for (let i = 0; i < scan.recordCount && checked < 5; i++) {
      if (invalid && invalid[i] !== 0) continue;
      const resolved = recordForCell(frame, rows[i], columns[i]);
      if (!resolved.ok) continue;
      const at = cloud.worldXYZ(resolved.record);
      expect(at[0]).toBeCloseTo(scan.columns.cartesianX[i], 3);
      expect(at[2]).toBeCloseTo(scan.columns.cartesianZ[i], 3);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F. Integer width, and the source's own range
// ────────────────────────────────────────────────────────────────────────────

describe('integer width', () => {
  const fieldOf = (scan: E57Scan, name: string) => scan.prototype.find((f) => f.name === name)!;

  it('comes from the declared maximum, not the packed bit width', () => {
    const row = fieldOf(documentOf(PUMP).scans[0], 'rowIndex');
    expect(row.maximum).toBe(2047);
    expect(row.bitWidth).toBe(11);
    expect(e57IntegerWidthFor(row)).toBe('u16');
  });

  it('widens to Uint32 when the declaration does not fit sixteen bits', () => {
    const wide = buildStructuredE57({
      records: [{ x: 1, y: 2, z: 3, row: 70_000, column: 0 }],
      bounds: { row: [0, 70_000], column: [0, 4] },
      proto: { row: 70_000, column: 511 },
    });
    const scan = documentOf(wide).scans[0];
    expect(e57IntegerWidthFor(fieldOf(scan, 'rowIndex'))).toBe('u32');
    expect(e57IntegerWidthFor(fieldOf(scan, 'columnIndex'))).toBe('u16');
    const parsed = parseE57(wide, {
      keepField: e57FieldIsConsumedForScan,
      structuredFor: (s) => e57StructuredRequestsForScan(s),
    });
    expect(parsed.scans[0].structured!.columns.rowIndex).toBeInstanceOf(Uint32Array);
    expect(parsed.scans[0].structured!.columns.columnIndex).toBeInstanceOf(Uint16Array);
  });

  it('decodes a real structured scan into the narrow arrays, not Float64', () => {
    const parsed = parseE57(PUMP, {
      keepField: e57FieldIsConsumedForScan,
      structuredFor: (s) => e57StructuredRequestsForScan(s),
    });
    expect(parsed.scans[0].structured!.columns.rowIndex).toBeInstanceOf(Uint16Array);
    expect(parsed.scans[0].columns.rowIndex).toBeUndefined();
  });
});

describe('the range the source declares', () => {
  const WITH_RANGE = buildStructuredE57({
    records: [
      { x: 1, y: 2, z: 3, row: 0, column: 0, range: 12.5, returnIndex: 0, returnCount: 2 },
      { x: 4, y: 5, z: 6, row: 0, column: 0, range: 30.25, returnIndex: 1, returnCount: 2 },
      { x: 7, y: 8, z: 9, row: 1, column: 2, range: 44, returnIndex: 0, returnCount: 1 },
    ],
    bounds: { row: [0, 3], column: [0, 4] },
    withRange: true,
    withReturns: true,
  });

  it('is kept as sourceRange, separate from any geometric range', async () => {
    const frame = (await loadE57(WITH_RANGE, 'range.e57')).organizedRange!.frames[0];
    expect(frame.geometricRange).toBeUndefined();
    expect(frame.sourceRange![1 * 5 + 2]).toBeCloseTo(44, 4);
  });

  it('describes several returns in one cell without a dense per-return array', async () => {
    const frame = (await loadE57(WITH_RANGE, 'range.e57')).organizedRange!.frames[0];
    const cell = returnsForCell(frame, 0, 0);
    expect(cell.ok).toBe(true);
    if (!cell.ok) throw new Error(cell.why);
    const returns = cell.returns;
    expect(returns.map((r) => r.returnIndex)).toEqual([0, 1]);
    expect(returns.every((r) => r.returnCount === 2)).toBe(true);
    expect(frame.returnRecord!.length).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// G. The memory plan counts what the decode allocates
// ────────────────────────────────────────────────────────────────────────────

describe('memory planning for a structured decode', () => {
  /** The same scan with its grid declaration removed, and nothing else changed. */
  function withoutStructure(scan: E57Scan): E57Scan {
    return { ...scan, indexBounds: null };
  }

  const planFor = (scans: E57Scan[]) => {
    const pre = summariseE57Scans(scans, PUMP.byteLength);
    return {
      pre,
      plan: planE57Decode({
        sourceCount: pre.recordCount,
        fileBytes: PUMP.byteLength,
        decodeBytesPerRecord: pre.decodeBytesPerRecord,
        structuredGridBytes: pre.structuredGridBytes,
        attributes: pre.attributes,
        isMobile: false,
        deviceMemoryGB: 8,
      }),
    };
  };

  it('counts more for a structured scan than for the same file without one', () => {
    const scans = documentOf(PUMP).scans;
    const structured = planFor(scans);
    const plain = planFor(scans.map(withoutStructure));
    // Two Uint16 index columns per record, and the grid itself.
    expect(structured.pre.decodeBytesPerRecord).toBe(plain.pre.decodeBytesPerRecord + 4);
    expect(structured.pre.structuredGridBytes).toBe(1074 * 345 * 10);
    expect(plain.pre.structuredGridBytes).toBe(0);
    expect(structured.plan.fullDecodeEstimateBytes).toBeGreaterThan(
      plain.plan.fullDecodeEstimateBytes,
    );
  });

  it('never counts a grid the file cannot back', () => {
    const pre = summariseE57Scans(documentOf(PUMP).scans, 87);
    expect(pre.structuredGridBytes).toBe(0);
  });
});
