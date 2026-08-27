/**
 * tilesetMixedColour.test.ts — one colour meaning per tileset layer.
 *
 * The merged 3D Tiles reader kept colour only when EVERY tile carried it, so a
 * tileset mixing coloured and uncoloured tiles opened uncoloured and said so.
 * The streaming reader decodes tiles one at a time and cannot inspect them all
 * up front, and the rule was lost on the way across: a tile with no RGB fell
 * back to the elevation ramp on its own, beside tiles painted from their stated
 * RGB. Two colour meanings in one scene, with nothing said about it.
 *
 * A viewer reads a scene as ONE colour meaning. These tests pin that a tileset
 * layer only ever has one, and that a mixture is named rather than drawn.
 */

import { describe, it, expect } from 'vitest';
import {
  PntsChunkDecoder,
  noteTileColour,
  tilesetColourNotice,
  NO_TILE_DECODED,
  MIXED_TILE_COLOUR_KEPT_NOTICE,
  MIXED_TILE_COLOUR_DROPPED_NOTICE,
  type PntsDecodeMetadata,
} from '../src/io/tiles3d/pntsDecode';
import {
  streamingNodeColors,
  UNSTATED_COLOUR_GREY,
  type StreamingColorRanges,
} from '../src/render/streaming/streamingColors';
import { colorByElevation } from '../src/render/colorModes';
import { renderLocalPositions } from '../src/model/pointFrames';

const PNTS_MAGIC = 0x73746e70;

/** A minimal valid `.pnts` body, optionally carrying per-point RGB. */
function makePnts(
  points: readonly (readonly [number, number, number])[],
  rgb?: readonly (readonly [number, number, number])[],
): ArrayBuffer {
  const posBytes = points.length * 3 * 4;
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: points.length,
    POSITION: { byteOffset: 0 },
  };
  if (rgb) ft.RGB = { byteOffset: posBytes };
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const binBytes = posBytes + (rgb ? points.length * 3 : 0);
  const total = 28 + jsonBytes.length + binBytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, PNTS_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  const binStart = 28 + jsonBytes.length;
  let k = 0;
  for (const p of points) for (const c of p) view.setFloat32(binStart + k++ * 4, c, true);
  if (rgb) {
    const bytes = new Uint8Array(buf, binStart + posBytes, points.length * 3);
    let j = 0;
    for (const c of rgb) for (const v of c) bytes[j++] = v;
  }
  return buf;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const META: PntsDecodeMetadata = {
  format: 'pnts',
  tileTransform: IDENTITY,
  renderOrigin: [0, 0, 0],
};

/** Two points at opposite ends of the layer's height span. */
const LOW_AND_HIGH: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0, 0, 100],
];
/** Colour the tile states for those two points. */
const STATED: readonly (readonly [number, number, number])[] = [
  [200, 10, 10],
  [10, 200, 10],
];
const STATED_BYTES = Uint8Array.from([200, 10, 10, 10, 200, 10]);

const RANGES: StreamingColorRanges = {
  minZ: 0,
  maxZ: 100,
  minIntensity: 0,
  maxIntensity: 1,
  minGpsTime: 0,
  maxGpsTime: 1,
  minReturnNumber: 0,
  maxReturnNumber: 1,
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The colours a node is given, copied out of the shared scratch buffer. */
function paint(chunk: Parameters<typeof streamingNodeColors>[1]): Uint8Array {
  return Uint8Array.from(streamingNodeColors('rgb', chunk, RANGES));
}

describe('a tileset that mixes coloured and uncoloured tiles', () => {
  it('never paints one tile from its stated colour and another by height', async () => {
    // ONE decoder, because one decoder serves one tileset layer.
    const decoder = new PntsChunkDecoder();
    const coloured = await decoder.decode(makePnts(LOW_AND_HIGH, STATED), META);
    const plain = await decoder.decode(makePnts(LOW_AND_HIGH), META);

    const heightRamp = colorByElevation(
      renderLocalPositions(plain),
      plain.pointCount,
      RANGES.minZ,
      RANGES.maxZ,
    );
    const fromStatedColour = sameBytes(paint(coloured), STATED_BYTES);
    const fromHeight = sameBytes(paint(plain), heightRamp);

    expect(
      fromStatedColour && fromHeight,
      'one tile is painted from its stated colour and another by height, in the same scene',
    ).toBe(false);
  });

  it('says so', async () => {
    const decoder = new PntsChunkDecoder();
    await decoder.decode(makePnts(LOW_AND_HIGH, STATED), META);
    await decoder.decode(makePnts(LOW_AND_HIGH), META);

    expect(
      decoder.colourNotice,
      'the mixture was not named anywhere a user could read it',
    ).not.toBeNull();
  });

  it('raises the notice once, through the shell surface it was given', async () => {
    const said: string[] = [];
    const decoder = new PntsChunkDecoder({ onColourNotice: (m) => said.push(m) });
    await decoder.decode(makePnts(LOW_AND_HIGH, STATED), META);
    expect(said, 'nothing has disagreed yet').toEqual([]);
    await decoder.decode(makePnts(LOW_AND_HIGH), META);
    await decoder.decode(makePnts(LOW_AND_HIGH), META);
    expect(said).toEqual([MIXED_TILE_COLOUR_KEPT_NOTICE]);
  });

  it('draws the tiles that state no colour flat, and keeps the stated colour', async () => {
    const decoder = new PntsChunkDecoder();
    const coloured = await decoder.decode(makePnts(LOW_AND_HIGH, STATED), META);
    const plain = await decoder.decode(makePnts(LOW_AND_HIGH), META);

    expect([...paint(coloured)]).toEqual([...STATED_BYTES]);
    expect([...paint(plain)]).toEqual(Array<number>(6).fill(UNSTATED_COLOUR_GREY));
  });

  it('leaves rgb absent on a tile that states none, so no reading is invented', async () => {
    const decoder = new PntsChunkDecoder();
    await decoder.decode(makePnts(LOW_AND_HIGH, STATED), META);
    const plain = await decoder.decode(makePnts(LOW_AND_HIGH), META);

    // The flat grey is a colour BUFFER, not a colour reading. `residentSnapshot`
    // and the point inspector both read `rgb`, and both must keep reporting
    // that these points state no colour.
    expect(plain.rgb).toBeUndefined();
  });

  it('withholds colour from a tile that has it when the layer is already ramped', async () => {
    const decoder = new PntsChunkDecoder();
    const plain = await decoder.decode(makePnts(LOW_AND_HIGH), META);
    const coloured = await decoder.decode(makePnts(LOW_AND_HIGH, STATED), META);

    const ramp = (c: typeof plain): Uint8Array =>
      colorByElevation(renderLocalPositions(c), c.pointCount, RANGES.minZ, RANGES.maxZ);
    expect([...paint(plain)]).toEqual([...ramp(plain)]);
    expect(
      [...paint(coloured)],
      'a tile painted from its stated colour beside ramped neighbours',
    ).toEqual([...ramp(coloured)]);
    expect(coloured.rgb).toBeUndefined();
    expect(decoder.colourNotice).toBe(MIXED_TILE_COLOUR_DROPPED_NOTICE);
  });
});

describe('a tileset whose tiles all agree', () => {
  it('renders in full stated RGB when every tile carries colour', async () => {
    const decoder = new PntsChunkDecoder();
    const first = await decoder.decode(makePnts(LOW_AND_HIGH, STATED), META);
    const second = await decoder.decode(
      makePnts(LOW_AND_HIGH, [
        [1, 2, 3],
        [4, 5, 6],
      ]),
      META,
    );

    expect([...paint(first)]).toEqual([...STATED_BYTES]);
    expect([...paint(second)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(first.rgb, 'colour must survive a uniformly coloured tileset').toBeDefined();
    expect(second.rgb).toBeDefined();
    expect(decoder.colourNotice, 'nothing disagreed, so nothing to report').toBeNull();
  });

  it('uses the elevation ramp with no notice when no tile carries colour', async () => {
    const decoder = new PntsChunkDecoder();
    const first = await decoder.decode(makePnts(LOW_AND_HIGH), META);
    const second = await decoder.decode(makePnts(LOW_AND_HIGH), META);

    for (const c of [first, second]) {
      expect([...paint(c)]).toEqual([
        ...colorByElevation(renderLocalPositions(c), c.pointCount, RANGES.minZ, RANGES.maxZ),
      ]);
      expect(c.rgb).toBeUndefined();
    }
    expect(decoder.colourNotice, 'a uniformly uncoloured tileset is not a mixture').toBeNull();
  });

});

describe('the colour consensus itself', () => {
  const fold = (...tiles: boolean[]) =>
    tiles.reduce(
      (state, hasColour) => noteTileColour(state, { pointCount: 2, hasColour }),
      NO_TILE_DECODED,
    );

  it('settles on the first tile with points and never moves', () => {
    expect(fold(true, false, false, false).settled).toBe('colour');
    expect(fold(false, true, true, true).settled).toBe('no-colour');
  });

  it('counts every tile that disagreed', () => {
    expect(fold(true, false, false).disagreeing).toBe(2);
    expect(fold(true, true, true).disagreeing).toBe(0);
  });

  it('ignores an empty tile entirely', () => {
    // `parsePnts` refuses a body whose POINTS_LENGTH is zero, so this cannot
    // arrive through the decoder today. The guard is here because a tile that
    // states no points states nothing about colour either, and settling a whole
    // layer's meaning on one would be a decision made from no data.
    const after = noteTileColour(NO_TILE_DECODED, { pointCount: 0, hasColour: false });
    expect(after).toBe(NO_TILE_DECODED);
  });

  it('names which colour the layer kept', () => {
    expect(tilesetColourNotice(fold(true, false))).toBe(MIXED_TILE_COLOUR_KEPT_NOTICE);
    expect(tilesetColourNotice(fold(false, true))).toBe(MIXED_TILE_COLOUR_DROPPED_NOTICE);
    expect(tilesetColourNotice(fold(true, true))).toBeNull();
  });
});
