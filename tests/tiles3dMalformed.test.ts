/**
 * tiles3dMalformed.test.ts — what the 3D Tiles parsers must refuse.
 *
 * Neither parser is user-facing in v0.6.6, so nothing routes untrusted bytes
 * into them yet. That is exactly when a format boundary is cheap to make
 * strict: `parseTileset` also accepts an already-parsed object, which can carry
 * NaN where JSON text cannot, and a PNTS tile declares its own length that the
 * decoder should honour instead of reading to the end of whatever buffer it was
 * handed. Every case below was accepted before this suite existed.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { parsePnts } from '../src/io/tiles3d/pnts';

const tileset = (over: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) => ({
  asset: { version: '1.0' },
  geometricError: 100,
  root: {
    boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
    geometricError: 10,
    refine: 'REPLACE',
    ...rootOver,
  },
  ...over,
});

describe('tileset.json perimeter', () => {
  it('accepts the well-formed baseline', () => {
    expect(parseTileset(tileset()).root.refine).toBe('REPLACE');
  });

  it('refuses a bounding volume of the wrong length', () => {
    expect(() => parseTileset(tileset({}, { boundingVolume: { box: [1, 2, 3] } }))).toThrow(/12 components/);
    expect(() => parseTileset(tileset({}, { boundingVolume: { region: [1, 2, 3] } }))).toThrow(/6 components/);
    expect(() => parseTileset(tileset({}, { boundingVolume: { sphere: [1, 2, 3, 4, 5] } }))).toThrow(/4 components/);
  });

  it('refuses a boundingVolume that declares more than one shape', () => {
    const box = [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5];
    const region = [0, 0, 0.1, 0.1, 0, 10];
    const sphere = [0, 0, 0, 5];
    expect(() => parseTileset(tileset({}, { boundingVolume: { box, sphere } }))).toThrow(/exactly one/);
    expect(() => parseTileset(tileset({}, { boundingVolume: { box, region } }))).toThrow(/exactly one/);
    expect(() => parseTileset(tileset({}, { boundingVolume: { region, sphere } }))).toThrow(/exactly one/);
    expect(() => parseTileset(tileset({}, { boundingVolume: { box, region, sphere } }))).toThrow(/exactly one/);
  });

  it('accepts a single bounding volume of each kind', () => {
    const box = [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5];
    const region = [0, 0, 0.1, 0.1, 0, 10];
    const sphere = [0, 0, 0, 5];
    expect(parseTileset(tileset({}, { boundingVolume: { box } })).root.boundingVolume.box).toEqual(box);
    expect(parseTileset(tileset({}, { boundingVolume: { region } })).root.boundingVolume.region).toEqual(region);
    expect(parseTileset(tileset({}, { boundingVolume: { sphere } })).root.boundingVolume.sphere).toEqual(sphere);
  });

  it('refuses a non-finite bounding-volume component', () => {
    const box = [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, Number.NaN];
    expect(() => parseTileset(tileset({}, { boundingVolume: { box } }))).toThrow(/non-finite/);
  });

  it('refuses a negative sphere radius and a negative geometric error', () => {
    expect(() => parseTileset(tileset({}, { boundingVolume: { sphere: [0, 0, 0, -1] } }))).toThrow(/negative radius/);
    expect(() => parseTileset(tileset({}, { geometricError: -1 }))).toThrow(/negative geometricError/);
    expect(() => parseTileset(tileset({ geometricError: -1 }))).toThrow(/negative geometricError/);
  });

  it('refuses a transform that is not a 4x4 of real numbers', () => {
    expect(() => parseTileset(tileset({}, { transform: [1, 2, 3] }))).toThrow(/16 components/);
    const sixteen = Array.from({ length: 16 }, (_, i) => (i === 15 ? Number.POSITIVE_INFINITY : 0));
    expect(() => parseTileset(tileset({}, { transform: sixteen }))).toThrow(/non-finite/);
  });

  it('refuses a content URI that is not a non-empty string', () => {
    expect(() => parseTileset(tileset({}, { content: { uri: 123 } }))).toThrow(/not a non-empty string/);
    expect(() => parseTileset(tileset({}, { content: { uri: '' } }))).toThrow(/not a non-empty string/);
  });

  it('refuses an explicit refine that is neither ADD nor REPLACE', () => {
    const child = { geometricError: 5, boundingVolume: { sphere: [0, 0, 0, 1] } };
    // A child that declares an undefined strategy is not a child that omitted
    // one, so it does not fall back to the parent's.
    expect(() => parseTileset(tileset({}, { children: [{ ...child, refine: 'BOGUS' }] }))).toThrow(/not ADD or REPLACE/);
    expect(() => parseTileset(tileset({}, { children: [{ ...child, refine: '' }] }))).toThrow(/not ADD or REPLACE/);
    expect(() => parseTileset(tileset({}, { refine: 'BOGUS' }))).toThrow(/not ADD or REPLACE/);
  });

  it('refuses a refine that is not a string', () => {
    const child = { geometricError: 5, boundingVolume: { sphere: [0, 0, 0, 1] } };
    // The message is the parser's own. A TypeError raised by calling
    // `.toUpperCase()` on a number would read differently.
    for (const refine of [5, true, ['ADD'], { mode: 'ADD' }]) {
      expect(() => parseTileset(tileset({}, { refine }))).toThrow(/refine is not a string/);
      expect(() => parseTileset(tileset({}, { children: [{ ...child, refine }] }))).toThrow(/refine is not a string/);
    }
  });

  it('inherits refine into a child that omits it', () => {
    const child = { geometricError: 5, boundingVolume: { sphere: [0, 0, 0, 1] } };
    const parsed = parseTileset(tileset({}, {
      refine: 'REPLACE',
      children: [child, { ...child, refine: 'ADD' }, { ...child, refine: 'replace' }],
    }));
    expect(parsed.root.children[0].refine).toBe('REPLACE'); // inherited
    expect(parsed.root.children[1].refine).toBe('ADD'); // explicit override
    expect(parsed.root.children[2].refine).toBe('REPLACE'); // case-insensitive
  });

  it('refuses a children field that is not an array', () => {
    expect(() => parseTileset(tileset({}, { children: { nope: true } }))).toThrow(/not an array/);
  });
});

/** Build a PNTS tile. `declaredLength` defaults to the real byte length. */
function pnts(opts: {
  version?: number;
  pointsLength?: number;
  positionByteOffset?: number;
  declaredLength?: number;
  trailing?: number;
  rtc?: unknown;
} = {}): ArrayBuffer {
  const pointsLength = opts.pointsLength ?? 2;
  const ftJson: Record<string, unknown> = {
    POINTS_LENGTH: pointsLength,
    POSITION: { byteOffset: opts.positionByteOffset ?? 0 },
  };
  if (opts.rtc !== undefined) ftJson.RTC_CENTER = opts.rtc;
  let json = JSON.stringify(ftJson);
  while (json.length % 4 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const binBytes = pointsLength * 3 * 4;
  const tileBytes = 28 + jsonBytes.length + binBytes;
  const total = tileBytes + (opts.trailing ?? 0);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, 0x73746e70, true);
  view.setUint32(4, opts.version ?? 1, true);
  // The declared length is the TILE, not the buffer: trailing bytes are
  // whatever followed it in a concatenated stream.
  view.setUint32(8, opts.declaredLength ?? tileBytes, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  new Uint8Array(buf).set(jsonBytes, 28);
  return buf;
}

describe('PNTS perimeter', () => {
  it('accepts the well-formed baseline', () => {
    expect(parsePnts(pnts()).pointsLength).toBe(2);
  });

  it('refuses a version it does not claim to read', () => {
    expect(() => parsePnts(pnts({ version: 2 }))).toThrow(/version 2 is not supported/);
  });

  it('treats the declared tile length as the boundary, not the buffer', () => {
    // 64 trailing bytes follow the tile. POSITION starts 4 bytes into the
    // feature-table binary, so its 24 bytes run 4 past the tile and into them.
    // The buffer can satisfy that read; the tile cannot.
    const withTrailing = pnts({ trailing: 64, positionByteOffset: 4 });
    expect(() => parsePnts(withTrailing)).toThrow(/past the declared tile length/);
    // Without the trailing bytes the buffer would have refused it anyway, so
    // the case above is the one that needs the declared length to be enforced.
    expect(parsePnts(pnts()).pointsLength).toBe(2);
  });

  it('refuses a fractional or negative POSITION.byteOffset', () => {
    expect(() => parsePnts(pnts({ positionByteOffset: 1.5 }))).toThrow(/non-negative whole number/);
    expect(() => parsePnts(pnts({ positionByteOffset: -4 }))).toThrow(/non-negative whole number/);
  });

  it('refuses a malformed RTC_CENTER rather than dropping it', () => {
    // The positions RTC_CENTER offsets are tile-local, so dropping a present
    // center places the tile at the local origin instead of refusing it.
    expect(() => parsePnts(pnts({ rtc: [1, 2] }))).toThrow(/RTC_CENTER must have 3 components/);
    expect(() => parsePnts(pnts({ rtc: [1, 2, 3, 4] }))).toThrow(/RTC_CENTER must have 3 components/);
    expect(() => parsePnts(pnts({ rtc: [] }))).toThrow(/RTC_CENTER must have 3 components/);
    expect(() => parsePnts(pnts({ rtc: 'nope' }))).toThrow(/RTC_CENTER must have 3 components/);
    expect(() => parsePnts(pnts({ rtc: 12 }))).toThrow(/RTC_CENTER must have 3 components/);
    expect(() => parsePnts(pnts({ rtc: null }))).toThrow(/RTC_CENTER must have 3 components/);
    expect(() => parsePnts(pnts({ rtc: { x: 1, y: 2, z: 3 } }))).toThrow(/RTC_CENTER must have 3 components/);
    expect(() => parsePnts(pnts({ rtc: [1, 2, '3'] }))).toThrow(/not a finite number/);
    // JSON carries no NaN or Infinity literal: `JSON.stringify` writes both as
    // null, which is the form a real feature table would hold.
    expect(() => parsePnts(pnts({ rtc: [1, 2, Number.NaN] }))).toThrow(/not a finite number/);
    expect(() => parsePnts(pnts({ rtc: [Number.POSITIVE_INFINITY, 2, 3] }))).toThrow(/not a finite number/);
  });

  it('accepts a 3-element RTC_CENTER and an absent one', () => {
    expect(parsePnts(pnts({ rtc: [1, 2, 3] })).rtcCenter).toEqual([1, 2, 3]);
    expect(parsePnts(pnts({ rtc: [0, 0, 0] })).rtcCenter).toEqual([0, 0, 0]);
    expect(parsePnts(pnts()).rtcCenter).toBeNull();
  });
});
