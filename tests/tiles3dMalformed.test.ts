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

const EMPTY = new Uint8Array(0);
const utf8 = (text: string) => new TextEncoder().encode(text);

/** Serialise a feature table the way a writer would, padded to 4 bytes. */
function ftJsonBytes(ft: Record<string, unknown>): Uint8Array {
  let json = JSON.stringify(ft);
  while (json.length % 4 !== 0) json += ' ';
  return utf8(json);
}

/**
 * Assemble a PNTS tile from section bytes. Every header field can be set
 * independently of what the sections actually hold, which is the point: these
 * fixtures are tiles whose header disagrees with their body.
 */
function assemble(
  sections: { ftJson: Uint8Array; ftBin?: Uint8Array; btJson?: Uint8Array; btBin?: Uint8Array },
  header: {
    version?: number;
    byteLength?: number;
    /** Applied to the real tile length when `byteLength` is not given. */
    byteLengthDelta?: number;
    ftJsonLength?: number;
    ftBinLength?: number;
    btJsonLength?: number;
    btBinLength?: number;
    /** Bytes appended after the tile, as a concatenated stream would carry. */
    trailing?: number;
  } = {},
): ArrayBuffer {
  const parts = [
    sections.ftJson,
    sections.ftBin ?? EMPTY,
    sections.btJson ?? EMPTY,
    sections.btBin ?? EMPTY,
  ];
  const tileBytes = 28 + parts.reduce((n, s) => n + s.length, 0);
  const buf = new ArrayBuffer(tileBytes + (header.trailing ?? 0));
  const view = new DataView(buf);
  view.setUint32(0, 0x73746e70, true);
  view.setUint32(4, header.version ?? 1, true);
  view.setUint32(8, header.byteLength ?? tileBytes + (header.byteLengthDelta ?? 0), true);
  view.setUint32(12, header.ftJsonLength ?? parts[0].length, true);
  view.setUint32(16, header.ftBinLength ?? parts[1].length, true);
  view.setUint32(20, header.btJsonLength ?? parts[2].length, true);
  view.setUint32(24, header.btBinLength ?? parts[3].length, true);
  const bytes = new Uint8Array(buf);
  let at = 28;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return buf;
}

/**
 * Build a float32-POSITION PNTS tile. `ft` replaces the whole feature table;
 * `binPoints` sizes the feature-table binary independently of POINTS_LENGTH.
 */
function pnts(
  opts: {
    version?: number;
    pointsLength?: number;
    positionByteOffset?: number;
    declaredLength?: number;
    trailing?: number;
    rtc?: unknown;
    ft?: Record<string, unknown>;
    binPoints?: number;
    btJson?: Uint8Array;
  } = {},
): ArrayBuffer {
  const pointsLength = opts.pointsLength ?? 2;
  const ft: Record<string, unknown> = opts.ft ?? {
    POINTS_LENGTH: pointsLength,
    POSITION: { byteOffset: opts.positionByteOffset ?? 0 },
  };
  if (opts.rtc !== undefined) ft.RTC_CENTER = opts.rtc;
  return assemble(
    {
      ftJson: ftJsonBytes(ft),
      ftBin: new Uint8Array((opts.binPoints ?? pointsLength) * 3 * 4),
      btJson: opts.btJson,
    },
    { version: opts.version, byteLength: opts.declaredLength, trailing: opts.trailing },
  );
}

/** A tile whose only defect is the POINTS_LENGTH it declares. */
const withPointsLength = (value: unknown) =>
  pnts({ ft: { POINTS_LENGTH: value, POSITION: { byteOffset: 0 } }, binPoints: 2 });

describe('PNTS perimeter', () => {
  it('accepts the well-formed baseline', () => {
    expect(parsePnts(pnts()).pointsLength).toBe(2);
  });

  it('refuses a buffer that cannot hold the header', () => {
    expect(() => parsePnts(new ArrayBuffer(27))).toThrow(/buffer shorter than the 28-byte header/);
    expect(() => parsePnts(new ArrayBuffer(0))).toThrow(/buffer shorter than the 28-byte header/);
  });

  it('refuses a version it does not claim to read', () => {
    expect(() => parsePnts(pnts({ version: 2 }))).toThrow(/version 2 is not supported/);
    expect(() => parsePnts(pnts({ version: 0 }))).toThrow(/version 0 is not supported/);
  });

  it('refuses a declared byteLength outside the buffer or under the header', () => {
    // Declared past the end of what arrived: no section can be satisfied from
    // bytes the transport never delivered.
    expect(() => parsePnts(assemble({ ftJson: utf8('{}  ') }, { byteLengthDelta: 8 }))).toThrow(
      /declared byteLength exceeds the buffer/,
    );
    expect(() => parsePnts(assemble({ ftJson: utf8('{}  ') }, { byteLength: 27 }))).toThrow(
      /declared byteLength is shorter than the header/,
    );
  });

  it('refuses a declared byteLength that is not the sum of its sections', () => {
    // Shorter than the sections imply: the body runs past the tile.
    expect(() => parsePnts(pnts({ declaredLength: 28 + 4 }))).toThrow(
      /section lengths overrun the declared byteLength/,
    );
    // Longer than the sections imply: bytes inside the tile that no section
    // accounts for. The trailing room is what lets the declaration grow while
    // still fitting the buffer.
    expect(() =>
      parsePnts(
        assemble(
          { ftJson: ftJsonBytes({ POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } }), ftBin: new Uint8Array(12) },
          { byteLengthDelta: 16, trailing: 16 },
        ),
      ),
    ).toThrow(/declared byteLength leaves bytes past the last section/);
  });

  it('refuses a feature-table JSON length that overruns the tile', () => {
    const ftJson = ftJsonBytes({ POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } });
    const ftBin = new Uint8Array(12);
    expect(() =>
      parsePnts(assemble({ ftJson, ftBin }, { ftJsonLength: ftJson.length + 4 })),
    ).toThrow(/section lengths overrun the declared byteLength/);
    expect(() => parsePnts(assemble({ ftJson, ftBin }, { ftJsonLength: 0xffffffff }))).toThrow(
      /section lengths overrun the declared byteLength/,
    );
    expect(() => parsePnts(assemble({ ftJson, ftBin }, { ftBinLength: 0xffffffff }))).toThrow(
      /section lengths overrun the declared byteLength/,
    );
    expect(() => parsePnts(assemble({ ftJson, ftBin }, { btJsonLength: 0xffffffff }))).toThrow(
      /section lengths overrun the declared byteLength/,
    );
    expect(() => parsePnts(assemble({ ftJson, ftBin }, { btBinLength: 0xffffffff }))).toThrow(
      /section lengths overrun the declared byteLength/,
    );
  });

  it('refuses a binary section that starts inside the JSON text', () => {
    // The section lengths still add up, so only the truncated JSON gives the
    // shortfall away: the feature-table binary begins 8 bytes early.
    const ftJson = ftJsonBytes({ POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } });
    const ftBin = new Uint8Array(12);
    expect(() =>
      parsePnts(
        assemble({ ftJson, ftBin }, { ftJsonLength: ftJson.length - 8, ftBinLength: ftBin.length + 8 }),
      ),
    ).toThrow(/feature table JSON does not parse/);
  });

  it('refuses a feature table that is not UTF-8, not JSON, or not an object', () => {
    // 0xff never appears in well-formed UTF-8.
    expect(() => parsePnts(assemble({ ftJson: new Uint8Array([0x7b, 0xff, 0x7d, 0x20]) }))).toThrow(
      /feature table JSON is not valid UTF-8/,
    );
    expect(() => parsePnts(assemble({ ftJson: utf8('{oops} ') }))).toThrow(
      /feature table JSON does not parse/,
    );
    expect(() => parsePnts(assemble({ ftJson: EMPTY }))).toThrow(/feature table JSON does not parse/);
    expect(() => parsePnts(assemble({ ftJson: utf8('[1,2,3]') }))).toThrow(
      /feature table JSON is not an object/,
    );
    expect(() => parsePnts(assemble({ ftJson: utf8('null') }))).toThrow(
      /feature table JSON is not an object/,
    );
    expect(() => parsePnts(assemble({ ftJson: utf8('7') }))).toThrow(
      /feature table JSON is not an object/,
    );
  });

  it('refuses a batch table that does not parse, and accepts one that does', () => {
    expect(() => parsePnts(pnts({ btJson: utf8('{oops} ') }))).toThrow(
      /batch table JSON does not parse/,
    );
    expect(() => parsePnts(pnts({ btJson: new Uint8Array([0x7b, 0xff, 0x7d, 0x20]) }))).toThrow(
      /batch table JSON is not valid UTF-8/,
    );
    expect(() => parsePnts(pnts({ btJson: utf8('[]  ') }))).toThrow(
      /batch table JSON is not an object/,
    );
    expect(parsePnts(pnts({ btJson: utf8('{"name":[1,2]}  ') })).pointsLength).toBe(2);
  });

  it('refuses a POINTS_LENGTH that is not a positive uint32', () => {
    for (const value of [0, -1, -2.5, 1.5, 4294967296, 1e300, '2', true, null, [2]]) {
      expect(() => parsePnts(withPointsLength(value))).toThrow(
        /POINTS_LENGTH is not a positive uint32/,
      );
    }
    // JSON has no NaN or Infinity literal; `JSON.stringify` writes both as null,
    // which is the form a real feature table would hold.
    expect(() => parsePnts(withPointsLength(Number.NaN))).toThrow(
      /POINTS_LENGTH is not a positive uint32/,
    );
    // Absent entirely.
    expect(() => parsePnts(pnts({ ft: { POSITION: { byteOffset: 0 } }, binPoints: 2 }))).toThrow(
      /POINTS_LENGTH is not a positive uint32/,
    );
    // The upper bound is inclusive, so the refusal above is about the value and
    // not about uint32 generally.
    expect(() => parsePnts(withPointsLength(4294967295))).toThrow(
      /POSITION extends past the feature-table binary section/,
    );
  });

  it('refuses a POSITION that is not an accessor object', () => {
    for (const position of [0, 'nope', [0], null, true]) {
      expect(() => parsePnts(pnts({ ft: { POINTS_LENGTH: 2, POSITION: position }, binPoints: 2 }))).toThrow(
        /POSITION is not a feature-table accessor object/,
      );
    }
    expect(() => parsePnts(pnts({ ft: { POINTS_LENGTH: 2, POSITION: {} }, binPoints: 2 }))).toThrow(
      /POSITION\.byteOffset is not a non-negative whole number/,
    );
  });

  it('refuses a fractional or negative POSITION.byteOffset', () => {
    expect(() => parsePnts(pnts({ positionByteOffset: 1.5 }))).toThrow(/non-negative whole number/);
    expect(() => parsePnts(pnts({ positionByteOffset: -4 }))).toThrow(/non-negative whole number/);
    // Past the safe-integer ceiling the offset is no longer the number that was
    // written, so it is refused before any arithmetic is done on it.
    expect(() => parsePnts(pnts({ positionByteOffset: 2 ** 53 }))).toThrow(
      /non-negative whole number/,
    );
  });

  it('refuses a byte range whose arithmetic would not be exact', () => {
    // A safe offset plus a safe length whose sum is not safe: the range check
    // would otherwise compare an approximation and could compare it favourably.
    expect(() => parsePnts(pnts({ positionByteOffset: Number.MAX_SAFE_INTEGER - 8 }))).toThrow(
      /POSITION spans a byte range too large to address exactly/,
    );
  });

  it('treats the declared tile length as the boundary, not the buffer', () => {
    // A tile followed by 64 bytes of whatever came next in the stream still
    // decodes: the trailing bytes are not the tile's problem.
    expect(parsePnts(pnts({ trailing: 64 })).pointsLength).toBe(2);
    // POSITION starts 4 bytes into the feature-table binary, so its 24 bytes run
    // 4 past the section and into those trailing bytes. The buffer can satisfy
    // that read; the tile cannot.
    expect(() => parsePnts(pnts({ trailing: 64, positionByteOffset: 4 }))).toThrow(
      /POSITION extends past the feature-table binary section/,
    );
    // The same overrun without trailing bytes, so the case above is about the
    // section boundary rather than about running out of buffer.
    expect(() => parsePnts(pnts({ positionByteOffset: 4 }))).toThrow(
      /POSITION extends past the feature-table binary section/,
    );
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

/** A quantised tile whose feature table is `ft`, over a 2-point binary. */
const quantized = (ft: Record<string, unknown>) =>
  assemble({ ftJson: ftJsonBytes(ft), ftBin: new Uint8Array(12) });

describe('PNTS quantised perimeter', () => {
  const volume = { QUANTIZED_VOLUME_OFFSET: [0, 0, 0], QUANTIZED_VOLUME_SCALE: [1, 1, 1] };

  it('accepts the well-formed baseline', () => {
    const tile = quantized({ POINTS_LENGTH: 2, POSITION_QUANTIZED: { byteOffset: 0 }, ...volume });
    expect([...parsePnts(tile).positions]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('refuses a quantised array with no volume to interpret it', () => {
    expect(() => parsePnts(quantized({ POINTS_LENGTH: 2, POSITION_QUANTIZED: { byteOffset: 0 } }))).toThrow(
      /POSITION_QUANTIZED requires QUANTIZED_VOLUME_OFFSET/,
    );
    expect(() =>
      parsePnts(
        quantized({
          POINTS_LENGTH: 2,
          POSITION_QUANTIZED: { byteOffset: 0 },
          QUANTIZED_VOLUME_OFFSET: [0, 0, 0],
        }),
      ),
    ).toThrow(/POSITION_QUANTIZED requires QUANTIZED_VOLUME_SCALE/);
    expect(() =>
      parsePnts(
        quantized({
          POINTS_LENGTH: 2,
          POSITION_QUANTIZED: { byteOffset: 0 },
          QUANTIZED_VOLUME_SCALE: [1, 1, 1],
        }),
      ),
    ).toThrow(/POSITION_QUANTIZED requires QUANTIZED_VOLUME_OFFSET/);
  });

  it('refuses a quantised volume that is not three real numbers', () => {
    expect(() =>
      parsePnts(
        quantized({ POINTS_LENGTH: 2, POSITION_QUANTIZED: { byteOffset: 0 }, ...volume, QUANTIZED_VOLUME_SCALE: [1, 1] }),
      ),
    ).toThrow(/QUANTIZED_VOLUME_SCALE must have 3 components/);
    expect(() =>
      parsePnts(
        quantized({
          POINTS_LENGTH: 2,
          POSITION_QUANTIZED: { byteOffset: 0 },
          ...volume,
          QUANTIZED_VOLUME_OFFSET: [1, 2, Number.NaN],
        }),
      ),
    ).toThrow(/QUANTIZED_VOLUME_OFFSET has a component that is not a finite number/);
    expect(() =>
      parsePnts(
        quantized({
          POINTS_LENGTH: 2,
          POSITION_QUANTIZED: { byteOffset: 0 },
          ...volume,
          QUANTIZED_VOLUME_SCALE: { x: 1, y: 1, z: 1 },
        }),
      ),
    ).toThrow(/QUANTIZED_VOLUME_SCALE must have 3 components/);
  });

  it('refuses a quantised array that runs past the feature-table binary', () => {
    // 2 points of uint16 xyz need 12 bytes, and the section holds 12, so an
    // offset of 2 is two bytes too many.
    expect(() =>
      parsePnts(quantized({ POINTS_LENGTH: 2, POSITION_QUANTIZED: { byteOffset: 2 }, ...volume })),
    ).toThrow(/POSITION_QUANTIZED extends past the feature-table binary section/);
    expect(() =>
      parsePnts(quantized({ POINTS_LENGTH: 3, POSITION_QUANTIZED: { byteOffset: 0 }, ...volume })),
    ).toThrow(/POSITION_QUANTIZED extends past the feature-table binary section/);
    expect(() =>
      parsePnts(
        quantized({
          POINTS_LENGTH: 2,
          POSITION_QUANTIZED: { byteOffset: Number.MAX_SAFE_INTEGER - 8 },
          ...volume,
        }),
      ),
    ).toThrow(/POSITION_QUANTIZED spans a byte range too large to address exactly/);
  });
});

/**
 * A tile whose feature table is `ft`, over a feature-table binary of `binBytes`
 * bytes. The default 24 bytes is a float32 POSITION for 2 points, so a colour
 * or normal array added at any offset overruns the section and the fixtures
 * below say by how much rather than by whether.
 */
const attributes = (ft: Record<string, unknown>, binBytes = 24) =>
  assemble({ ftJson: ftJsonBytes(ft), ftBin: new Uint8Array(binBytes) });

/** POINTS_LENGTH 2 with a POSITION that fits the default 24-byte binary. */
const twoPoints = { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 } };

describe('PNTS colour perimeter', () => {
  it('accepts the well-formed baseline of each encoding', () => {
    // 8 bytes of RGBA, 6 of RGB, 4 of RGB565 all fit alongside the 24 bytes of
    // POSITION when the binary is grown to hold them.
    expect(parsePnts(attributes({ ...twoPoints, RGBA: { byteOffset: 24 } }, 32)).colors).toHaveLength(6);
    expect(parsePnts(attributes({ ...twoPoints, RGB: { byteOffset: 24 } }, 30)).colors).toHaveLength(6);
    expect(parsePnts(attributes({ ...twoPoints, RGB565: { byteOffset: 24 } }, 28)).colors).toHaveLength(6);
    expect(parsePnts(attributes({ ...twoPoints, CONSTANT_RGBA: [1, 2, 3, 4] })).colors).toHaveLength(6);
  });

  it('refuses a colour array that runs past the feature-table binary', () => {
    // Each array is one byte short of fitting: the section ends where POSITION
    // does, so any colour byte at all is outside it.
    expect(() => parsePnts(attributes({ ...twoPoints, RGBA: { byteOffset: 24 } }, 31))).toThrow(
      /RGBA extends past the feature-table binary section/,
    );
    expect(() => parsePnts(attributes({ ...twoPoints, RGB: { byteOffset: 24 } }, 29))).toThrow(
      /RGB extends past the feature-table binary section/,
    );
    expect(() => parsePnts(attributes({ ...twoPoints, RGB565: { byteOffset: 24 } }, 27))).toThrow(
      /RGB565 extends past the feature-table binary section/,
    );
    // Wholly outside, rather than one byte over.
    expect(() => parsePnts(attributes({ ...twoPoints, RGBA: { byteOffset: 1024 } }, 32))).toThrow(
      /RGBA extends past the feature-table binary section/,
    );
  });

  it('refuses a colour byte range whose arithmetic would not be exact', () => {
    for (const key of ['RGBA', 'RGB', 'RGB565']) {
      expect(() =>
        parsePnts(attributes({ ...twoPoints, [key]: { byteOffset: Number.MAX_SAFE_INTEGER - 8 } }, 32)),
      ).toThrow(new RegExp(`${key} spans a byte range too large to address exactly`));
    }
  });

  it('refuses a colour accessor that is not an accessor object', () => {
    for (const key of ['RGBA', 'RGB', 'RGB565']) {
      for (const value of [0, 'nope', [0], null, true]) {
        expect(() => parsePnts(attributes({ ...twoPoints, [key]: value }, 32))).toThrow(
          new RegExp(`${key} is not a feature-table accessor object`),
        );
      }
      expect(() => parsePnts(attributes({ ...twoPoints, [key]: {} }, 32))).toThrow(
        new RegExp(`${key}\\.byteOffset is not a non-negative whole number`),
      );
      expect(() => parsePnts(attributes({ ...twoPoints, [key]: { byteOffset: -4 } }, 32))).toThrow(
        new RegExp(`${key}\\.byteOffset is not a non-negative whole number`),
      );
      expect(() => parsePnts(attributes({ ...twoPoints, [key]: { byteOffset: 1.5 } }, 32))).toThrow(
        new RegExp(`${key}\\.byteOffset is not a non-negative whole number`),
      );
    }
  });

  it('refuses a CONSTANT_RGBA that is not four bytes', () => {
    const bad = (value: unknown) => () => parsePnts(attributes({ ...twoPoints, CONSTANT_RGBA: value }));
    expect(bad([1, 2, 3])).toThrow(/CONSTANT_RGBA must have 4 components/);
    expect(bad([1, 2, 3, 4, 5])).toThrow(/CONSTANT_RGBA must have 4 components/);
    expect(bad([])).toThrow(/CONSTANT_RGBA must have 4 components/);
    expect(bad({ r: 1, g: 2, b: 3, a: 4 })).toThrow(/CONSTANT_RGBA must have 4 components/);
    expect(bad('white')).toThrow(/CONSTANT_RGBA must have 4 components/);
    expect(bad(255)).toThrow(/CONSTANT_RGBA must have 4 components/);
    expect(bad(null)).toThrow(/CONSTANT_RGBA must have 4 components/);
    for (const component of [-1, 256, 1.5, '255', true, null, Number.NaN]) {
      expect(bad([1, 2, 3, component])).toThrow(
        /CONSTANT_RGBA has a component that is not a whole number in 0-255/,
      );
    }
    // The bounds are inclusive, so the refusals above are about the values.
    expect(parsePnts(attributes({ ...twoPoints, CONSTANT_RGBA: [0, 255, 0, 255] })).colors).toEqual(
      new Uint8Array([0, 255, 0, 0, 255, 0]),
    );
  });

  it('refuses a malformed colour array instead of falling back to a lower-ranked one', () => {
    // Every lower-ranked encoding is present and well-formed. A decoder that
    // answered the defect by moving down the ranking would return a colour, and
    // the colour it returned would not be the one the tile named.
    const lower = { RGB: { byteOffset: 24 }, RGB565: { byteOffset: 30 }, CONSTANT_RGBA: [9, 9, 9, 255] };
    expect(() =>
      parsePnts(attributes({ ...twoPoints, RGBA: { byteOffset: 34 }, ...lower }, 34)),
    ).toThrow(/RGBA extends past the feature-table binary section/);
    expect(() =>
      parsePnts(attributes({ ...twoPoints, RGB: { byteOffset: 34 }, RGB565: { byteOffset: 24 }, CONSTANT_RGBA: [9, 9, 9, 255] }, 34)),
    ).toThrow(/RGB extends past the feature-table binary section/);
    expect(() =>
      parsePnts(attributes({ ...twoPoints, RGB565: { byteOffset: 34 }, CONSTANT_RGBA: [9, 9, 9, 255] }, 34)),
    ).toThrow(/RGB565 extends past the feature-table binary section/);
  });
});

describe('PNTS normal perimeter', () => {
  it('accepts the well-formed baseline of each encoding', () => {
    expect(parsePnts(attributes({ ...twoPoints, NORMAL: { byteOffset: 24 } }, 48)).normals).toHaveLength(6);
    expect(parsePnts(attributes({ ...twoPoints, NORMAL_OCT16P: { byteOffset: 24 } }, 28)).normals).toHaveLength(6);
  });

  it('refuses a normal array that runs past the feature-table binary', () => {
    expect(() => parsePnts(attributes({ ...twoPoints, NORMAL: { byteOffset: 24 } }, 47))).toThrow(
      /NORMAL extends past the feature-table binary section/,
    );
    expect(() => parsePnts(attributes({ ...twoPoints, NORMAL_OCT16P: { byteOffset: 24 } }, 27))).toThrow(
      /NORMAL_OCT16P extends past the feature-table binary section/,
    );
    expect(() => parsePnts(attributes({ ...twoPoints, NORMAL: { byteOffset: 4096 } }, 48))).toThrow(
      /NORMAL extends past the feature-table binary section/,
    );
  });

  it('refuses a normal byte range whose arithmetic would not be exact', () => {
    for (const key of ['NORMAL', 'NORMAL_OCT16P']) {
      expect(() =>
        parsePnts(attributes({ ...twoPoints, [key]: { byteOffset: Number.MAX_SAFE_INTEGER - 8 } }, 48)),
      ).toThrow(new RegExp(`${key} spans a byte range too large to address exactly`));
    }
  });

  it('refuses a normal accessor that is not an accessor object', () => {
    for (const key of ['NORMAL', 'NORMAL_OCT16P']) {
      for (const value of [0, 'nope', [0], null, true]) {
        expect(() => parsePnts(attributes({ ...twoPoints, [key]: value }, 48))).toThrow(
          new RegExp(`${key} is not a feature-table accessor object`),
        );
      }
      expect(() => parsePnts(attributes({ ...twoPoints, [key]: {} }, 48))).toThrow(
        new RegExp(`${key}\\.byteOffset is not a non-negative whole number`),
      );
      expect(() => parsePnts(attributes({ ...twoPoints, [key]: { byteOffset: -2 } }, 48))).toThrow(
        new RegExp(`${key}\\.byteOffset is not a non-negative whole number`),
      );
      expect(() => parsePnts(attributes({ ...twoPoints, [key]: { byteOffset: 0.5 } }, 48))).toThrow(
        new RegExp(`${key}\\.byteOffset is not a non-negative whole number`),
      );
    }
  });

  it('refuses a malformed NORMAL instead of falling back to NORMAL_OCT16P', () => {
    expect(() =>
      parsePnts(
        attributes({ ...twoPoints, NORMAL: { byteOffset: 28 }, NORMAL_OCT16P: { byteOffset: 24 } }, 28),
      ),
    ).toThrow(/NORMAL extends past the feature-table binary section/);
  });

  it('refuses a colour or normal array on a quantised tile too', () => {
    // The position encoding does not decide whether the other arrays are
    // checked: the 12-byte binary holds the quantised positions and nothing else.
    const volume = { QUANTIZED_VOLUME_OFFSET: [0, 0, 0], QUANTIZED_VOLUME_SCALE: [1, 1, 1] };
    const base = { POINTS_LENGTH: 2, POSITION_QUANTIZED: { byteOffset: 0 }, ...volume };
    expect(() => parsePnts(attributes({ ...base, RGB: { byteOffset: 12 } }, 12))).toThrow(
      /RGB extends past the feature-table binary section/,
    );
    expect(() => parsePnts(attributes({ ...base, NORMAL_OCT16P: { byteOffset: 12 } }, 12))).toThrow(
      /NORMAL_OCT16P extends past the feature-table binary section/,
    );
  });
});
