/**
 * eptMalformedManifest.test.ts — what the EPT perimeter must refuse.
 *
 * `ept.json` and the hierarchy files arrive over the network from a source the
 * viewer does not control, so the manifest parser is a trust boundary. Being
 * lenient there does not make a bad dataset work; it moves the failure to
 * `decodeEptBinaryTile`, where a fractional point count reaches
 * `pointCount * stride` and typed-array allocation, and a schema width the
 * decoder cannot read reaches byte-offset arithmetic.
 *
 * Every case below was ACCEPTED before this suite existed.
 */

import { describe, it, expect } from 'vitest';
import { parseEptMetadata } from '../src/io/ept/eptDetect';
import { computeSchemaLayout } from '../src/io/ept/eptBinaryDecode';
import { parseHierarchyFile } from '../src/io/ept/eptHierarchy';
import { eptStringToKey } from '../src/io/ept/eptTypes';

const XYZ = [
  { name: 'X', size: 4, type: 'signed' },
  { name: 'Y', size: 4, type: 'signed' },
  { name: 'Z', size: 4, type: 'signed' },
];

/**
 * A manifest carrying `extra` as raw JSON text inside the X attribute.
 *
 * `JSON.stringify` cannot emit NaN or Infinity (both serialise to `null`), so
 * a manifest that reaches the parser holding one has to be built as text.
 * `1e999` is valid JSON number syntax and `JSON.parse` returns Infinity for it.
 */
function manifestWithXExtras(extra: string): string {
  const marker = JSON.stringify(XYZ[0]);
  return manifest().replace(marker, `${marker.slice(0, -1)},${extra}}`);
}

/** A manifest that parses, with `over` applied on top. */
function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.0.0',
    dataType: 'binary',
    hierarchyType: 'json',
    points: 100,
    span: 128,
    bounds: [0, 0, 0, 10, 10, 10],
    boundsConforming: [0, 0, 0, 10, 10, 10],
    schema: XYZ,
    ...over,
  });
}

describe('EPT manifest perimeter', () => {
  it('accepts the well-formed baseline, so the refusals below mean something', () => {
    expect(parseEptMetadata(manifest()).isEpt).toBe(true);
  });

  it('refuses a fractional or unsafe point count', () => {
    expect(parseEptMetadata(manifest({ points: 100.5 })).isEpt).toBe(false);
    expect(parseEptMetadata(manifest({ points: Number.MAX_SAFE_INTEGER * 4 })).isEpt).toBe(false);
    expect(parseEptMetadata(manifest({ points: -1 })).isEpt).toBe(false);
  });

  it('refuses a fractional span', () => {
    expect(parseEptMetadata(manifest({ span: 128.5 })).isEpt).toBe(false);
  });

  it('refuses an attribute width the binary decoder cannot read', () => {
    // decodeEptBinaryTile switches on 1, 2, 4, 8 and nothing else.
    for (const size of [3, 5, 2.5, 0, -4, 16]) {
      const schema = [{ name: 'X', size, type: 'signed' }, XYZ[1], XYZ[2]];
      expect(parseEptMetadata(manifest({ schema })).isEpt).toBe(false);
    }
    for (const size of [1, 2, 4, 8]) {
      const schema = [{ name: 'X', size, type: 'signed' }, XYZ[1], XYZ[2]];
      expect(parseEptMetadata(manifest({ schema })).isEpt).toBe(true);
    }
  });

  it('refuses a float at a width IEEE-754 has no format for', () => {
    // readAttr switches on size before type: a float declared at size 1 lands
    // on getUint8 and a float at size 2 lands on getUint16. Both return an
    // in-range number, so an X/Y/Z attribute decodes to a coordinate that
    // looks valid and is wrong.
    for (const size of [1, 2]) {
      const schema = [{ name: 'X', size, type: 'float' }, XYZ[1], XYZ[2]];
      expect(parseEptMetadata(manifest({ schema })).isEpt).toBe(false);
    }
  });

  it('accepts every type and width combination the decoder reads', () => {
    for (const size of [4, 8]) {
      const schema = [{ name: 'X', size, type: 'float' }, XYZ[1], XYZ[2]];
      expect(parseEptMetadata(manifest({ schema })).isEpt).toBe(true);
    }
    for (const type of ['signed', 'unsigned']) {
      for (const size of [1, 2, 4, 8]) {
        const schema = [{ name: 'X', size, type }, XYZ[1], XYZ[2]];
        expect(parseEptMetadata(manifest({ schema })).isEpt).toBe(true);
      }
    }
    // The 1-byte signed case spelled out, since the float rule shares its width.
    const oneByteSigned = [{ name: 'X', size: 1, type: 'signed' }, XYZ[1], XYZ[2]];
    expect(parseEptMetadata(manifest({ schema: oneByteSigned })).isEpt).toBe(true);
  });

  it('refuses a scale or offset that is present and not a finite number', () => {
    // A present-but-malformed value used to read as absent, which applied the
    // decoder default of scale 1 to an axis whose manifest declared 0.01.
    expect(parseEptMetadata(manifestWithXExtras('"scale":"0.01"')).isEpt).toBe(false);
    expect(parseEptMetadata(manifestWithXExtras('"offset":"5"')).isEpt).toBe(false);
    // NaN reaches the parser as the `null` JSON.stringify writes for it.
    expect(parseEptMetadata(manifestWithXExtras('"scale":null')).isEpt).toBe(false);
    expect(parseEptMetadata(manifestWithXExtras('"offset":null')).isEpt).toBe(false);
    // A literal NaN token is not JSON at all and is refused one step earlier.
    expect(parseEptMetadata(manifestWithXExtras('"scale":NaN')).isEpt).toBe(false);
    // 1e999 is valid JSON number syntax that parses to Infinity.
    expect(parseEptMetadata(manifestWithXExtras('"offset":1e999')).isEpt).toBe(false);
    expect(parseEptMetadata(manifestWithXExtras('"scale":1e999')).isEpt).toBe(false);
    expect(parseEptMetadata(manifestWithXExtras('"offset":-1e999')).isEpt).toBe(false);
    // Other shapes a writer can produce for a numeric field.
    expect(parseEptMetadata(manifestWithXExtras('"scale":true')).isEpt).toBe(false);
    expect(parseEptMetadata(manifestWithXExtras('"offset":[0.01]')).isEpt).toBe(false);
  });

  it('keeps a scale and offset that are present and finite', () => {
    const result = parseEptMetadata(manifestWithXExtras('"scale":0.01,"offset":500000'));
    expect(result.isEpt).toBe(true);
    if (!result.isEpt) return;
    const x = result.metadata.schema.find((f) => f.name === 'X');
    expect(x?.scale).toBe(0.01);
    expect(x?.offset).toBe(500_000);
  });

  it('takes the decoder default when scale and offset are absent', () => {
    const result = parseEptMetadata(manifest());
    expect(result.isEpt).toBe(true);
    if (!result.isEpt) return;
    const x = result.metadata.schema.find((f) => f.name === 'X');
    expect(x?.scale).toBeUndefined();
    expect(x?.offset).toBeUndefined();
    // computeSchemaLayout is what turns the absent keys into 1 and 0.
    const layout = computeSchemaLayout(result.metadata.schema);
    const attr = layout.attrs.find((a) => a.name === 'X');
    expect(attr?.scale).toBe(1);
    expect(attr?.offsetVal).toBe(0);
  });

  it('refuses a duplicated attribute name', () => {
    const schema = [XYZ[0], { name: 'X', size: 2, type: 'unsigned' }, XYZ[1], XYZ[2]];
    expect(parseEptMetadata(manifest({ schema })).isEpt).toBe(false);
  });

  it('refuses bounds whose minimum sits above its maximum', () => {
    const inverted = [10, 10, 10, 0, 0, 0];
    expect(parseEptMetadata(manifest({ bounds: inverted, boundsConforming: inverted })).isEpt).toBe(false);
    // One inverted axis is enough.
    const oneAxis = [0, 0, 0, 10, -1, 10];
    expect(parseEptMetadata(manifest({ bounds: oneAxis, boundsConforming: oneAxis })).isEpt).toBe(false);
  });
});

describe('EPT hierarchy perimeter', () => {
  const key = '0-0-0-0';

  it('accepts the link sentinel and a whole count', () => {
    expect(parseHierarchyFile(JSON.stringify({ [key]: -1 })).links).toHaveLength(1);
    expect(parseHierarchyFile(JSON.stringify({ [key]: 12 })).nodes).toHaveLength(1);
    expect(parseHierarchyFile(JSON.stringify({ [key]: 0 })).nodes).toHaveLength(0);
  });

  it('refuses a fractional count instead of counting it as a node', () => {
    expect(() => parseHierarchyFile(JSON.stringify({ [key]: 0.5 }))).toThrow(/whole point count/);
  });

  it('refuses a negative value that is not the link sentinel', () => {
    // -2 previously fell through both branches and was silently ignored.
    expect(() => parseHierarchyFile(JSON.stringify({ [key]: -2 }))).toThrow(/whole point count/);
  });
});

describe('EPT octree addresses', () => {
  it('parses a well-formed address', () => {
    expect(eptStringToKey('2-3-3-3')).toEqual({ d: 2, x: 3, y: 3, z: 3 });
  });

  it('refuses a depth beyond the bound and digits beyond precision', () => {
    expect(eptStringToKey('99-0-0-0')).toBeNull();
    expect(eptStringToKey('1-99999999999999999999-0-0')).toBeNull();
  });

  it('leaves the coordinate-versus-depth question to the hierarchy', () => {
    // The string is well formed; whether depth 2 HAS a cell 4 is a question
    // about the tree, and parseHierarchyFile is where an address is accepted.
    expect(eptStringToKey('2-4-0-0')).toEqual({ d: 2, x: 4, y: 0, z: 0 });
    expect(() => parseHierarchyFile(JSON.stringify({ '2-4-0-0': 5 }))).toThrow(/outside the 4 cells/);
    expect(() => parseHierarchyFile(JSON.stringify({ '0-1-0-0': 5 }))).toThrow(/outside the 1 cells/);
  });
});
