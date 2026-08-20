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
import { parseHierarchyFile } from '../src/io/ept/eptHierarchy';
import { eptStringToKey } from '../src/io/ept/eptTypes';

const XYZ = [
  { name: 'X', size: 4, type: 'signed' },
  { name: 'Y', size: 4, type: 'signed' },
  { name: 'Z', size: 4, type: 'signed' },
];

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
  it('accepts an address inside its depth', () => {
    expect(eptStringToKey('2-3-3-3')).toEqual({ d: 2, x: 3, y: 3, z: 3 });
  });

  it('refuses a coordinate outside the cells that depth has', () => {
    // At depth 2 each axis has 4 cells, so index 4 names nothing.
    expect(eptStringToKey('2-4-0-0')).toBeNull();
    expect(eptStringToKey('0-1-0-0')).toBeNull();
  });

  it('refuses a depth beyond the bound and digits beyond precision', () => {
    expect(eptStringToKey('99-0-0-0')).toBeNull();
    expect(eptStringToKey('1-99999999999999999999-0-0')).toBeNull();
  });
});
