import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/io/e57/xml';
import { parseE57Header } from '../src/io/e57/header';

/** A 48-byte ASTM E57 header with the given XML length (uint64 little-endian). */
function header(xmlLogicalLength: bigint, fileBytes: number): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(48, fileBytes));
  const v = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode('ASTM-E57'), 0);
  v.setUint32(8, 1, true); // version major
  v.setUint32(12, 0, true);
  v.setBigUint64(16, BigInt(fileBytes), true); // file physical length
  v.setBigUint64(24, 48n, true); // XML physical offset
  v.setBigUint64(32, xmlLogicalLength, true);
  v.setBigUint64(40, 1024n, true); // page size
  return buf;
}

describe('E57 XML limits', () => {
  it('refuses XML nested deeper than real E57 schemas, with a clear error', () => {
    const depth = 100_000;
    const doc = '<a>'.repeat(depth) + '</a>'.repeat(depth);
    expect(() => parseXml(doc)).toThrow(/Invalid XML: nesting/);
  }, 5000);

  it('still parses ordinary nesting', () => {
    const doc = '<a>'.repeat(40) + 'x' + '</a>'.repeat(40);
    expect(parseXml(doc).name).toBe('a');
  });

  it('refuses a header that declares an XML section far larger than any E57 schema', () => {
    const fileBytes = 2048;
    // The length is checked against its own cap before anything is read.
    expect(() => parseE57Header(header(3_000_000_000n, fileBytes), 4_000_000_000)).toThrow(/XML section/);
  });

  it('accepts a normal XML length', () => {
    expect(parseE57Header(header(4096n, 8192), 8192).xmlLogicalLength).toBe(4096);
  });
});
