import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57Header } from '../src/io/e57/header';
import { depage, physicalToLogical } from '../src/io/e57/depage';
import { parseXml, child } from '../src/io/e57/xml';
import { parseE57 } from '../src/io/e57/parseE57';

const bunny = readFileSync(fileURLToPath(new URL('./bunnyFloat.e57', import.meta.url)));
const bunnyBuffer = bunny.buffer.slice(
  bunny.byteOffset,
  bunny.byteOffset + bunny.byteLength,
) as ArrayBuffer;

describe('parseE57Header', () => {
  it('reads the header of a real E57 file', () => {
    const h = parseE57Header(bunnyBuffer);
    expect(h.pageSize).toBe(1024);
    expect(h.xmlPhysicalOffset).toBe(372332);
    expect(h.xmlLogicalLength).toBe(2176);
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

describe('parseE57 — bunnyFloat.e57 fixture', () => {
  const result = parseE57(bunnyBuffer);

  it('finds the single "bunny" scan', () => {
    expect(result.scans).toHaveLength(1);
    expect(result.scans[0].name).toBe('bunny');
  });

  it('reads file metadata', () => {
    expect(result.metadata.formatName).toBe('ASTM E57 3D Imaging Data File');
    expect(result.metadata.library.length).toBeGreaterThan(0);
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

  it('decodes the declared record count for every column', () => {
    const s = result.scans[0];
    expect(s.recordCount).toBe(30571);
    expect(s.columns.cartesianX).toHaveLength(30571);
    expect(s.columns.cartesianY).toHaveLength(30571);
    expect(s.columns.cartesianZ).toHaveLength(30571);
    expect(s.columns.cartesianInvalidState).toHaveLength(30571);
  });

  it('decodes the first Float coordinates correctly', () => {
    const x = result.scans[0].columns.cartesianX;
    expect(x[0]).toBeCloseTo(-0.07063, 4);
    expect(x[1]).toBeCloseTo(-0.07089, 4);
    expect(x[2]).toBeCloseTo(-0.07105, 4);
  });

  it('decodes all coordinates within the file-declared bounds', () => {
    const c = result.scans[0].columns;
    for (let i = 0; i < 30571; i += 2500) {
      expect(c.cartesianX[i]).toBeGreaterThan(-0.11);
      expect(c.cartesianX[i]).toBeLessThan(0.08);
      expect(c.cartesianY[i]).toBeGreaterThan(0.03);
      expect(c.cartesianY[i]).toBeLessThan(0.2);
      expect(c.cartesianZ[i]).toBeGreaterThan(-0.08);
      expect(c.cartesianZ[i]).toBeLessThan(0.07);
    }
  });

  it('decodes the bit-packed invalid-state column as 0/1 values', () => {
    const inv = result.scans[0].columns.cartesianInvalidState;
    for (let i = 0; i < 30571; i += 1000) {
      expect(inv[i] === 0 || inv[i] === 1).toBe(true);
    }
  });
});
