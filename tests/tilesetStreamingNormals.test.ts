/**
 * tilesetStreamingNormals.test.ts — a point tile's stated normals across the
 * streaming boundary.
 *
 * `parsePnts` has always decoded a tile's NORMAL (and NORMAL_OCT16P) accessor,
 * and the viewer has always had a normals shading path. The two never met: the
 * streaming chunk had nowhere to put a normal, so the decoder read one and
 * dropped it, and a tileset that measured its surfaces drew as if it had not.
 *
 * A normal is a measurement. These tests pin that it survives the crossing
 * unaltered, that nothing is invented when a tile states none, and that a layer
 * is never offered a colour mode its tiles cannot fill.
 */

import { describe, it, expect } from 'vitest';
import {
  PntsChunkDecoder,
  noteTileNormals,
  tilesetNormalsNotice,
  NO_TILE_DECODED_NORMALS,
  MIXED_TILE_NORMALS_KEPT_NOTICE,
  MIXED_TILE_NORMALS_DROPPED_NOTICE,
  type PntsDecodeMetadata,
} from '../src/io/tiles3d/pntsDecode';
import {
  chunkTransferables,
  type ChunkDecodeMetadata,
  type DecodedChunk,
} from '../src/io/copc/copcChunkDecode';
import { decodedChunkBytes } from '../src/render/streaming/StreamingScheduler';
import {
  streamingNodeColors,
  UNSTATED_COLOUR_GREY,
  type StreamingColorRanges,
} from '../src/render/streaming/streamingColors';
import { colorByNormal } from '../src/render/colorModes';
import { TilesetStreamingSource } from '../src/render/streaming/TilesetStreamingSource';
import { parseTileset } from '../src/io/tiles3d/tileset';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';
import { buildResidentSnapshot } from '../src/render/streaming/residentSnapshot';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';

const PNTS_MAGIC = 0x73746e70;

type Triple = readonly [number, number, number];

/** A minimal valid `.pnts` body, optionally carrying RGB and/or float32 NORMAL. */
function makePnts(
  points: readonly Triple[],
  extras: { rgb?: readonly Triple[]; normals?: readonly Triple[] } = {},
): ArrayBuffer {
  const posBytes = points.length * 3 * 4;
  const rgbBytes = extras.rgb ? points.length * 3 : 0;
  const normalBytes = extras.normals ? points.length * 3 * 4 : 0;
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: points.length,
    POSITION: { byteOffset: 0 },
  };
  if (extras.rgb) ft.RGB = { byteOffset: posBytes };
  // NORMAL is float32 and must start on a 4-byte boundary within the binary
  // section, so it follows the (byte-wide) RGB block, whose length is a
  // multiple of 3. Padded to 4 below so the offset stays aligned.
  const normalPad = (4 - ((posBytes + rgbBytes) % 4)) % 4;
  if (extras.normals) ft.NORMAL = { byteOffset: posBytes + rgbBytes + normalPad };
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const binBytes = posBytes + rgbBytes + normalPad + normalBytes;
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
  if (extras.rgb) {
    const bytes = new Uint8Array(buf, binStart + posBytes, rgbBytes);
    let j = 0;
    for (const c of extras.rgb) for (const v of c) bytes[j++] = v;
  }
  if (extras.normals) {
    const at = binStart + posBytes + rgbBytes + normalPad;
    let j = 0;
    for (const nrm of extras.normals) for (const v of nrm) view.setFloat32(at + j++ * 4, v, true);
  }
  return buf;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A wide view: clip = world/256, so the frustum spans [-256,256]³. */
const WIDE_VIEW = [1 / 256, 0, 0, 0, 0, 1 / 256, 0, 0, 0, 0, 1 / 256, 0, 0, 0, 0, 1];
const META: PntsDecodeMetadata = {
  format: 'pnts',
  tileTransform: IDENTITY,
  renderOrigin: [0, 0, 0],
};

/** Two points at opposite ends of the layer's height span. */
const LOW_AND_HIGH: readonly Triple[] = [
  [0, 0, 0],
  [0, 0, 100],
];
/** Two unit normals a tile states: one straight up, one along +X. */
const STATED_NORMALS: readonly Triple[] = [
  [0, 0, 1],
  [1, 0, 0],
];
const STATED_RGB: readonly Triple[] = [
  [200, 10, 10],
  [10, 200, 10],
];

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

/** The colours a node is given, copied out of any shared scratch buffer. */
function paint(mode: 'normal' | 'rgb', chunk: DecodedChunk): number[] {
  return [...streamingNodeColors(mode, chunk, RANGES)];
}

describe('a tile that states normals', () => {
  it('carries them across the chunk boundary, byte for byte', async () => {
    const decoded = await new PntsChunkDecoder().decode(
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
      META,
    );
    expect(
      decoded.normals,
      'parsePnts read the tile’s NORMAL accessor and the chunk dropped it, so a ' +
        'tileset that measured its surfaces reaches the renderer as if it had not',
    ).toBeDefined();
    expect([...(decoded.normals ?? [])]).toEqual([0, 0, 1, 1, 0, 0]);
    expect(decoded.normals?.length).toBe(3 * decoded.pointCount);
  });

  it('states no normals when the tile carries none', async () => {
    const decoded = await new PntsChunkDecoder().decode(makePnts(LOW_AND_HIGH), META);
    expect(
      decoded.normals,
      'absent must stay absent — a zero-filled triple is a direction, not a gap',
    ).toBeUndefined();
  });

  it('transfers the normals buffer with the chunk', async () => {
    const decoded = await new PntsChunkDecoder().decode(
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
      META,
    );
    expect(chunkTransferables(decoded)).toContain(decoded.normals?.buffer);
  });

  it('lists no normals buffer for a chunk that has none', async () => {
    const decoded = await new PntsChunkDecoder().decode(makePnts(LOW_AND_HIGH), META);
    expect(chunkTransferables(decoded)).toEqual([decoded.positions.buffer]);
  });
});

describe('what the memory guard is charged', () => {
  it('charges twelve bytes a point for normals that are present', async () => {
    const withNormals = await new PntsChunkDecoder().decode(
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
      META,
    );
    const without = await new PntsChunkDecoder().decode(makePnts(LOW_AND_HIGH), META);
    expect(
      decodedChunkBytes(withNormals) - decodedChunkBytes(without),
      'an uncharged channel makes the byte budget lie about what is resident',
    ).toBe(3 * Float32Array.BYTES_PER_ELEMENT * withNormals.pointCount);
  });

  it('charges nothing for normals a chunk does not carry', async () => {
    const without = await new PntsChunkDecoder().decode(makePnts(LOW_AND_HIGH), META);
    expect(decodedChunkBytes(without)).toBe(
      without.pointCount * 3 * Float32Array.BYTES_PER_ELEMENT,
    );
  });
});

describe('painting a streaming node by its normals', () => {
  it('uses the static pipeline’s encoding, not the elevation ramp', async () => {
    const decoded = await new PntsChunkDecoder().decode(
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
      META,
    );
    expect(paint('normal', decoded)).toEqual([
      ...colorByNormal(decoded.normals!, decoded.pointCount),
    ]);
    // (0,0,1) → (128,128,255) and (1,0,0) → (255,128,128) under n = (n+1)/2.
    expect(paint('normal', decoded)).toEqual([128, 128, 255, 255, 128, 128]);
  });

  it('draws flat grey, never a height ramp, when the chunk states no normals', async () => {
    const decoded = await new PntsChunkDecoder().decode(makePnts(LOW_AND_HIGH), META);
    expect(
      paint('normal', decoded),
      'a height ramp under a Normal legend is a second reading wearing the first one’s label',
    ).toEqual(Array<number>(6).fill(UNSTATED_COLOUR_GREY));
  });
});

// ── the layer's answer ──────────────────────────────────────────────────────

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };
const TREE = parseTileset(
  JSON.stringify({
    asset: { version: '1.0' },
    geometricError: 100,
    root: {
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'ADD',
      content: { uri: 'root.pnts' },
      children: [{ boundingVolume: BOX, geometricError: 10, content: { uri: 'a.pnts' } }],
    },
  }),
);

const transport = (): TilesetTransport => ({
  fetchTilesetJson: async () => '{}',
  fetchTileBytes: async () => new ArrayBuffer(8),
});

function source(): TilesetStreamingSource {
  return new TilesetStreamingSource(
    'id',
    'A tileset',
    'https://host/data/tileset.json',
    transport(),
    TREE,
  );
}

/** Decode `bodies` through one layer's decoder and tell the source what it got. */
async function serve(
  s: TilesetStreamingSource,
  decoder: PntsChunkDecoder,
  bodies: readonly ArrayBuffer[],
): Promise<DecodedChunk[]> {
  const out: DecodedChunk[] = [];
  for (const body of bodies) {
    const decoded = await decoder.decode(body, META);
    s.noteDecodedChannels(decoded);
    out.push(decoded);
  }
  return out;
}

describe('the colour modes a tileset layer offers', () => {
  it('offers neither colour nor normals before a tile has been read', () => {
    const modes = source().availableColorModes();
    expect(
      modes,
      'a mode offered before anything was read is a promise about tiles nobody has seen',
    ).toEqual(['elevation']);
  });

  it('offers normals once a tile has stated them', async () => {
    const s = source();
    await serve(s, new PntsChunkDecoder(), [
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
    ]);
    expect(s.availableColorModes()).toContain('normal');
  });

  it('never offers normals for a tileset whose tiles carry none', async () => {
    const s = source();
    await serve(s, new PntsChunkDecoder(), [
      makePnts(LOW_AND_HIGH, { rgb: STATED_RGB }),
      makePnts(LOW_AND_HIGH, { rgb: STATED_RGB }),
    ]);
    expect(
      s.availableColorModes(),
      'a Normal chip on a layer with no normals resolves to something else and lies about it',
    ).not.toContain('normal');
  });

  it('offers no RGB mode for a tileset whose tiles state no colour', async () => {
    const s = source();
    await serve(s, new PntsChunkDecoder(), [makePnts(LOW_AND_HIGH), makePnts(LOW_AND_HIGH)]);
    expect(
      s.availableColorModes(),
      'an RGB chip that silently resolves to the elevation ramp is the same defect',
    ).not.toContain('rgb');
    expect(s.defaultColorMode()).toBe('elevation');
  });

  it('offers RGB, and defaults to it, once a tile has stated colour', async () => {
    const s = source();
    await serve(s, new PntsChunkDecoder(), [makePnts(LOW_AND_HIGH, { rgb: STATED_RGB })]);
    expect(s.availableColorModes()).toContain('rgb');
    expect(s.defaultColorMode()).toBe('rgb');
  });

  it('never offers intensity or classification, which the format cannot fill', async () => {
    const s = source();
    await serve(s, new PntsChunkDecoder(), [
      makePnts(LOW_AND_HIGH, { rgb: STATED_RGB, normals: STATED_NORMALS }),
    ]);
    expect(s.availableColorModes()).not.toContain('intensity');
    expect(s.availableColorModes()).not.toContain('classification');
  });
});

describe('the signal a layer raises when its offer moves', () => {
  it('fires once, when the first tile with points settles the answer', async () => {
    const s = source();
    const fired: string[][] = [];
    s.onColorModesChanged(() => fired.push([...s.availableColorModes()]));
    await serve(s, new PntsChunkDecoder(), [
      makePnts(LOW_AND_HIGH, { rgb: STATED_RGB, normals: STATED_NORMALS }),
      makePnts(LOW_AND_HIGH, { rgb: STATED_RGB, normals: STATED_NORMALS }),
      makePnts(LOW_AND_HIGH, { rgb: STATED_RGB, normals: STATED_NORMALS }),
    ]);
    expect(
      fired,
      'the answer settles on the first tile with points and never moves, so every ' +
        'later chunk would ask a surface to redraw the row it already has',
    ).toEqual([['rgb', 'elevation', 'normal']]);
  });

  it('stays silent when the answer settles without moving what is offered', async () => {
    const s = source();
    const fired: number[] = [];
    s.onColorModesChanged(() => fired.push(1));
    await serve(s, new PntsChunkDecoder(), [makePnts(LOW_AND_HIGH), makePnts(LOW_AND_HIGH)]);
    expect(s.availableColorModes()).toEqual(['elevation']);
    expect(fired, 'nothing a user can see changed').toEqual([]);
  });

  it('stays silent for a chunk with no points, which settles nothing', () => {
    const s = source();
    const fired: number[] = [];
    s.onColorModesChanged(() => fired.push(1));
    // Built rather than decoded: `parsePnts` refuses a zero POINTS_LENGTH, so
    // an empty chunk can only reach the fold from somewhere other than a tile
    // body. The fold ignores it either way, and the signal must too.
    s.noteDecodedChannels({
      pointCount: 0,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
    });
    expect(fired).toEqual([]);
    expect(s.availableColorModes()).toEqual(['elevation']);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const s = source();
    const fired: number[] = [];
    const off = s.onColorModesChanged(() => fired.push(1));
    off();
    await serve(s, new PntsChunkDecoder(), [
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
    ]);
    expect(fired).toEqual([]);
  });

  it('folds the answer even when a listener throws', async () => {
    const s = source();
    const seen: string[] = [];
    s.onColorModesChanged(() => {
      throw new Error('a panel blew up');
    });
    s.onColorModesChanged(() => seen.push('second'));
    await serve(s, new PntsChunkDecoder(), [
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
    ]);
    expect(
      s.availableColorModes(),
      'the notification rides the scheduler’s decode continuation: a throw there ' +
        'records a cleanly decoded node as failed and backs it off',
    ).toContain('normal');
    expect(seen).toEqual(['second']);
  });
});

describe('a tileset that mixes tiles with and without normals', () => {
  it('keeps the stated normals and draws the tiles without them flat', async () => {
    const decoder = new PntsChunkDecoder();
    const measured = await decoder.decode(
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
      META,
    );
    const plain = await decoder.decode(makePnts(LOW_AND_HIGH), META);

    expect(measured.normals).toBeDefined();
    expect(plain.normals, 'nothing is invented for the tile that states none').toBeUndefined();
    expect(paint('normal', plain)).toEqual(Array<number>(6).fill(UNSTATED_COLOUR_GREY));
    expect(decoder.normalsNotice).toBe(MIXED_TILE_NORMALS_KEPT_NOTICE);
  });

  it('withholds normals from a later tile when the first stated none', async () => {
    const decoder = new PntsChunkDecoder();
    await decoder.decode(makePnts(LOW_AND_HIGH), META);
    const measured = await decoder.decode(
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
      META,
    );
    expect(
      measured.normals,
      'the layer states it has no normals, so part of it must not carry them into ' +
        'the inspector, the profile and the export',
    ).toBeUndefined();
    expect(decoder.normalsNotice).toBe(MIXED_TILE_NORMALS_DROPPED_NOTICE);
  });

  it('never offers the normal mode for a layer that withheld them', async () => {
    const s = source();
    const decoder = new PntsChunkDecoder();
    await serve(s, decoder, [
      makePnts(LOW_AND_HIGH),
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
    ]);
    expect(s.availableColorModes()).not.toContain('normal');
  });

  it('raises the notice once, through the shell surface it was given', async () => {
    const said: string[] = [];
    const decoder = new PntsChunkDecoder({ onNormalsNotice: (m) => said.push(m) });
    await decoder.decode(makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }), META);
    expect(said, 'nothing has disagreed yet').toEqual([]);
    await decoder.decode(makePnts(LOW_AND_HIGH), META);
    await decoder.decode(makePnts(LOW_AND_HIGH), META);
    expect(said).toEqual([MIXED_TILE_NORMALS_KEPT_NOTICE]);
  });

  it('says nothing when every tile agrees', async () => {
    const decoder = new PntsChunkDecoder();
    await decoder.decode(makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }), META);
    await decoder.decode(makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }), META);
    expect(decoder.normalsNotice).toBeNull();
  });
});

describe('the normals consensus itself', () => {
  const fold = (...tiles: boolean[]) =>
    tiles.reduce(
      (state, hasNormals) => noteTileNormals(state, { pointCount: 2, hasNormals }),
      NO_TILE_DECODED_NORMALS,
    );

  it('settles on the first tile with points and never moves', () => {
    expect(fold(true, false, false).settled).toBe('normals');
    expect(fold(false, true, true).settled).toBe('no-normals');
  });

  it('counts every tile that disagreed', () => {
    expect(fold(true, false, false).disagreeing).toBe(2);
    expect(fold(true, true, true).disagreeing).toBe(0);
  });

  it('ignores an empty tile entirely', () => {
    expect(noteTileNormals(NO_TILE_DECODED_NORMALS, { pointCount: 0, hasNormals: true })).toBe(
      NO_TILE_DECODED_NORMALS,
    );
  });

  it('names which answer the layer kept', () => {
    expect(tilesetNormalsNotice(fold(true, false))).toBe(MIXED_TILE_NORMALS_KEPT_NOTICE);
    expect(tilesetNormalsNotice(fold(false, true))).toBe(MIXED_TILE_NORMALS_DROPPED_NOTICE);
    expect(tilesetNormalsNotice(fold(true, true))).toBeNull();
  });
});

const SNAPSHOT_OPTS = {
  origin: [0, 0, 0] as const,
  name: 'A tileset',
  sourceFormat: 'pnts' as const,
};

describe('the scheduler tells the source what each chunk carried', () => {
  it('reports every decoded chunk, so the layer answers from what it served', async () => {
    const fixture = buildSyntheticCopc({
      center: [0, 0, 0],
      halfsize: 128,
      nodes: [
        { key: [0, 0, 0, 0], pointCount: 200 },
        { key: [1, 0, 0, 0], pointCount: 100 },
      ],
    });
    const cloud = await StreamingPointCloud.open(
      new ArrayBufferRangeSource(fixture.buffer),
      'normals.copc.laz',
    );
    const served: (Float32Array | undefined)[] = [];
    // COPC states its channels in a header and so omits the hook; assigning one
    // here exercises the scheduler's side of the seam without a tileset
    // transport. Without this call a tileset layer never learns what its tiles
    // carried, and every per-tile colour mode stays unoffered for the session.
    (cloud as unknown as { noteDecodedChannels?: (c: DecodedChunk) => void }).noteDecodedChannels =
      (c) => served.push(c.normals);

    const decoder = {
      decode: (_bytes: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> =>
        Promise.resolve({
          pointCount: meta.pointCount,
          positions: new Float32Array(meta.pointCount * 3),
          normals: new Float32Array(meta.pointCount * 3).fill(1),
        }),
    };
    const scheduler = new StreamingScheduler(
      cloud,
      decoder,
      { onNodeReady: () => {}, onNodeEvicted: () => {} },
      streamingBudgets('balanced', false),
    );
    scheduler.update({ viewProjection: WIDE_VIEW, cameraPosition: [0, 0, 0] });
    for (let i = 0; i < 200; i++) {
      const s = scheduler.stats();
      if (s.queued === 0 && s.loading === 0) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(served.length, 'no decoded chunk was reported to the source').toBe(2);
    expect(served.every((n) => n?.length === 3 * 100 || n?.length === 3 * 200)).toBe(true);
  });
});

describe('the derived products that read the chunk', () => {
  it('reaches the resident snapshot only when every chunk carries normals', async () => {
    const decoder = new PntsChunkDecoder();
    const a = await decoder.decode(makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }), META);
    const b = await decoder.decode(makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }), META);
    const all = buildResidentSnapshot([a, b], SNAPSHOT_OPTS);
    expect(all?.normals).toBeDefined();
    expect([...(all?.normals ?? [])]).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0]);

    const mixedDecoder = new PntsChunkDecoder();
    const measured = await mixedDecoder.decode(
      makePnts(LOW_AND_HIGH, { normals: STATED_NORMALS }),
      META,
    );
    const plain = await mixedDecoder.decode(makePnts(LOW_AND_HIGH), META);
    const partial = buildResidentSnapshot([measured, plain], SNAPSHOT_OPTS);
    expect(
      partial?.normals,
      'half a normals array would report a direction for points that state none',
    ).toBeUndefined();
  });
});
