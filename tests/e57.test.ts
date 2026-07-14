import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57Header } from '../src/io/e57/header';
import { depage, physicalToLogical } from '../src/io/e57/depage';
import { parseXml, child } from '../src/io/e57/xml';
import { parseE57 } from '../src/io/e57/parseE57';

// Real-file E57 coverage runs against the pump fixture, which carries an
// explicit redistribution grant (libE57 Test Data License; see
// THIRD_PARTY_NOTICES.md). It exercises the header, depage, XML, and full-parse
// paths on a genuine E57 without bundling any dataset whose redistribution
// rights are not granted.
const pump = readFileSync(
  fileURLToPath(new URL('./pumpARowColumnIndexNoInvalidPoints.e57', import.meta.url)),
);
const pumpBuffer = pump.buffer.slice(
  pump.byteOffset,
  pump.byteOffset + pump.byteLength,
) as ArrayBuffer;

// The Stanford Bunny E57 is NOT redistributed with this repository (its
// redistribution rights are not granted). Its bit-packed invalid-state decode
// assertions run only when a developer drops `tests/bunnyFloat.e57` locally.
const bunnyPath = fileURLToPath(new URL('./bunnyFloat.e57', import.meta.url));
const hasBunny = existsSync(bunnyPath);

describe('parseE57Header', () => {
  it('reads the header of a real E57 file', () => {
    const h = parseE57Header(pumpBuffer);
    // E57 pages are 1024 bytes; the XML section sits at a positive offset with a
    // positive length. (Exact offsets are file-specific, so assert structurally.)
    expect(h.pageSize).toBe(1024);
    expect(h.xmlPhysicalOffset).toBeGreaterThan(0);
    expect(h.xmlLogicalLength).toBeGreaterThan(0);
  });

  it('rejects a file that is too short', () => {
    expect(() => parseE57Header(new ArrayBuffer(8))).toThrow(/E57/);
  });

  it('rejects a file with the wrong signature', () => {
    const bad = new Uint8Array(48);
    bad.set([66, 65, 68, 0, 0, 0, 0, 0]); // "BAD"
    expect(() => parseE57Header(bad.buffer)).toThrow(/signature/);
  });
});

describe('depage', () => {
  it('strips page checksums into a contiguous logical buffer', () => {
    // Two 8-byte pages; the last 4 bytes of each are checksum filler.
    const paged = new Uint8Array([0, 1, 2, 3, 99, 99, 99, 99, 4, 5, 6, 7, 88, 88, 88, 88]);
    const { logical } = depage(paged.buffer, 8);
    expect([...logical.subarray(0, 8)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('maps physical offsets to logical offsets', () => {
    expect(physicalToLogical(0, 8)).toBe(0);
    expect(physicalToLogical(8, 8)).toBe(4);
    expect(physicalToLogical(10, 8)).toBe(6);
  });
});

describe('parseXml', () => {
  it('parses attributes, nesting, text and self-closing tags', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><root a="1"><item type="X">hello</item><empty flag="y"/></root>',
    );
    expect(doc.name).toBe('root');
    expect(doc.attrs.a).toBe('1');
    expect(doc.children).toHaveLength(2);
    const item = child(doc, 'item');
    expect(item?.attrs.type).toBe('X');
    expect(item?.text).toBe('hello');
    const empty = child(doc, 'empty');
    expect(empty?.attrs.flag).toBe('y');
    expect(empty?.children).toHaveLength(0);
  });

  it('reads CDATA content verbatim', () => {
    const doc = parseXml('<r><n><![CDATA[a<b>c]]></n></r>');
    expect(child(doc, 'n')?.text).toBe('a<b>c');
  });
});

describe('parseE57 — pump fixture (licensed, real file)', () => {
  const result = parseE57(pumpBuffer);

  it('finds at least one scan with a name', () => {
    expect(result.scans.length).toBeGreaterThanOrEqual(1);
    expect(typeof result.scans[0].name).toBe('string');
  });

  it('reads file metadata', () => {
    expect(result.metadata.formatName).toBe('ASTM E57 3D Imaging Data File');
    expect(result.metadata.library.length).toBeGreaterThan(0);
  });

  it('reads a prototype with cartesian coordinate fields', () => {
    const fields = result.scans[0].fields;
    expect(fields.length).toBeGreaterThan(0);
    const names = fields.map((f) => f.name);
    expect(names).toContain('cartesianX');
  });

  it('decodes the declared record count consistently across columns', () => {
    const s = result.scans[0];
    expect(s.recordCount).toBeGreaterThan(0);
    expect(s.columns.cartesianX).toHaveLength(s.recordCount);
    expect(s.columns.cartesianY).toHaveLength(s.recordCount);
    expect(s.columns.cartesianZ).toHaveLength(s.recordCount);
  });

  it('decodes finite coordinate values', () => {
    const c = result.scans[0].columns;
    const n = result.scans[0].recordCount;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 10))) {
      expect(Number.isFinite(c.cartesianX[i])).toBe(true);
      expect(Number.isFinite(c.cartesianY[i])).toBe(true);
      expect(Number.isFinite(c.cartesianZ[i])).toBe(true);
    }
  });
});

// Bunny-specific decode assertions (exact Float coordinates + the bit-packed
// cartesianInvalidState column). The bunny is not redistributed, so this block
// is skipped unless a developer supplies the file locally.
describe.skipIf(!hasBunny)('parseE57 — bunnyFloat.e57 fixture (local only)', () => {
  // The describe factory still executes when skipped, so only touch the file
  // when it is actually present (it is not redistributed).
  const bunnyBuffer = hasBunny
    ? (() => {
        const b = readFileSync(bunnyPath);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      })()
    : new ArrayBuffer(0);
  const result = hasBunny
    ? parseE57(bunnyBuffer)
    : ({ scans: [] } as unknown as ReturnType<typeof parseE57>);

  it('finds the single "bunny" scan', () => {
    expect(result.scans).toHaveLength(1);
    expect(result.scans[0].name).toBe('bunny');
  });

  it('reads the prototype: three Float coordinates plus an Integer flag', () => {
    const fields = result.scans[0].fields;
    expect(fields).toHaveLength(4);
    expect(fields[0].type).toBe('float');
    expect(fields[0].floatBytes).toBe(4);
    expect(fields[3].name).toBe('cartesianInvalidState');
    expect(fields[3].type).toBe('integer');
    expect(fields[3].bitWidth).toBe(1);
  });

  it('decodes the first Float coordinates correctly', () => {
    const x = result.scans[0].columns.cartesianX;
    expect(x[0]).toBeCloseTo(-0.07063, 4);
    expect(x[1]).toBeCloseTo(-0.07089, 4);
    expect(x[2]).toBeCloseTo(-0.07105, 4);
  });

  it('decodes the bit-packed invalid-state column as 0/1 values', () => {
    const inv = result.scans[0].columns.cartesianInvalidState;
    for (let i = 0; i < 30571; i += 1000) {
      expect(inv[i] === 0 || inv[i] === 1).toBe(true);
    }
  });
});
