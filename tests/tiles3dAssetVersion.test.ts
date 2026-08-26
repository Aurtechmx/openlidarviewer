/**
 * tiles3dAssetVersion.test.ts — the schema version a tileset declares.
 *
 * `asset.version` names the 3D Tiles schema the rest of the document is written
 * in, and with it the base set of tile formats a reader is expected to handle.
 * This reader implements a bounded subset of 1.0 and 1.1, so anything else has
 * to fail the parse: a document written to a later schema can reuse a field name
 * and still parse into a tree that looks valid and means something else.
 *
 * Before this suite, any string at all was accepted, so "2.0" and "banana" both
 * parsed as though they were 1.1.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset, SUPPORTED_ASSET_VERSIONS } from '../src/io/tiles3d/tileset';

const tileset = (version: unknown) => {
  const doc: Record<string, unknown> = {
    geometricError: 100,
    root: {
      boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
      geometricError: 10,
      refine: 'REPLACE',
    },
  };
  if (version !== undefined) doc.asset = { version };
  return doc;
};

describe('tileset asset.version', () => {
  it('parses every supported version', () => {
    expect([...SUPPORTED_ASSET_VERSIONS]).toEqual(['1.0', '1.1']);
    for (const v of SUPPORTED_ASSET_VERSIONS) {
      expect(parseTileset(tileset(v)).assetVersion).toBe(v);
    }
  });

  it('refuses a schema version outside the supported set, naming both', () => {
    let message = '';
    try {
      parseTileset(tileset('2.0'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('2.0');
    expect(message).toContain('1.0');
    expect(message).toContain('1.1');
    expect(message).toMatch(/^3D Tiles: /);
  });

  it('refuses a version string that names no schema at all', () => {
    expect(() => parseTileset(tileset('banana'))).toThrow(/"banana"/);
    expect(() => parseTileset(tileset('1'))).toThrow(/not 1\.0 or 1\.1/);
    expect(() => parseTileset(tileset('1.10'))).toThrow(/not 1\.0 or 1\.1/);
  });

  it('still refuses a missing or non-string asset.version', () => {
    expect(() => parseTileset(tileset(undefined))).toThrow(/no asset\.version/);
    expect(() => parseTileset(tileset(1.1))).toThrow(/no asset\.version/);
    expect(() => parseTileset(tileset(null))).toThrow(/no asset\.version/);
  });
});
