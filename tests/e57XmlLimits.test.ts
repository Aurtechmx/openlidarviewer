import { describe, it, expect } from 'vitest';
import { parseXml, MAX_XML_NODES, MAX_XML_ATTRIBUTES } from '../src/io/e57/xml';
import { LoadError } from '../src/io/loadErrors';
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
    expect(() => parseXml(doc)).toThrow(/its XML section nests deeper than/);
    try {
      parseXml(doc);
    } catch (e) {
      expect((e as LoadError).category).toBe('malformed-file');
    }
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

describe('E57 XML element and attribute ceilings', () => {
  it('refuses a document with more elements than the ceiling, naming the limit', () => {
    const doc = `<r>${'<a/>'.repeat(MAX_XML_NODES)}</r>`;
    let caught: unknown;
    try {
      parseXml(doc);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LoadError);
    expect((caught as LoadError).category).toBe('malformed-file');
    expect((caught as LoadError).message).toContain(String(MAX_XML_NODES));
  });

  it('accepts a document exactly at the element ceiling', () => {
    const doc = `<r>${'<a/>'.repeat(MAX_XML_NODES - 1)}</r>`;
    expect(parseXml(doc).children).toHaveLength(MAX_XML_NODES - 1);
  });

  it('refuses a document with more attributes than the ceiling', () => {
    const attrs = Array.from({ length: 1000 }, (_, i) => `k${i}="v"`).join(' ');
    const doc = `<r>${`<a ${attrs}/>`.repeat(Math.ceil(MAX_XML_ATTRIBUTES / 1000) + 1)}</r>`;
    expect(() => parseXml(doc)).toThrow(/attributes/);
  });

  it('keeps every shipped E57 fixture far below the ceilings', () => {
    // The shipped files declare 8 to 60 elements; 200,000 is three orders above.
    expect(MAX_XML_NODES).toBeGreaterThanOrEqual(100 * 60);
    expect(MAX_XML_ATTRIBUTES).toBeGreaterThanOrEqual(100 * 96);
  });
});

describe('E57 XML attributes', () => {
  it('reads keys and quoted values, and an unterminated value runs to the end of the document', () => {
    expect(parseXml('<a x="1" y=\'two\'/>').attrs).toEqual({ x: '1', y: 'two' });
    expect(parseXml('<a x="1"><b k="v"/></a>').children[0].attrs.k).toBe('v');
    expect(parseXml('<a x="1').attrs).toEqual({ x: '1' });
    expect(parseXml('<a x=').attrs).toEqual({ x: '' });
  });
});
