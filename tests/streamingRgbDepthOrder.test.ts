/**
 * The colours a streamed COPC/EPT cloud ends up showing must not depend on
 * which node finishes decoding first. A 16-bit file whose first node to
 * arrive is very dark (every channel <= 255) used to pin the whole cloud to
 * 8-bit, so later bright nodes kept only their low byte; nodes decoded in
 * parallel before that first decision could also land in a different depth.
 */
import { describe, it, expect } from 'vitest';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import {
  decodeRecords,
  type ChunkDecoder,
  type ChunkDecodeMetadata,
  type DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

type Rgb = [number, number, number];

const WIDE = [1 / 256, 0, 0, 0, 0, 1 / 256, 0, 0, 0, 0, 1 / 256, 0, 0, 0, 0, 1];

/** PDRF 7 records (36 bytes) carrying the given colours, cycled to `n` points. */
function records(n: number, colours: Rgb[]): Uint8Array {
  const len = 36;
  const buf = new Uint8Array(n * len);
  const v = new DataView(buf.buffer);
  for (let i = 0; i < n; i++) {
    const p = i * len;
    const [r, g, b] = colours[i % colours.length];
    v.setInt32(p, i, true);
    v.setInt32(p + 4, i, true);
    v.setInt32(p + 8, i, true);
    v.setUint8(p + 14, 0x11);
    v.setUint16(p + 30, r, true);
    v.setUint16(p + 32, g, true);
    v.setUint16(p + 34, b, true);
  }
  return buf;
}

/**
 * A decoder that narrows colour with the real per-chunk rule. Nodes are told
 * apart by their (unique) point count; each one resolves after its own delay,
 * which fixes the arrival order.
 */
function decoderFor(colours: Map<number, Rgb[]>, delayMs: Map<number, number>): ChunkDecoder {
  return {
    decode(_chunk: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> {
      const n = meta.pointCount;
      const decoded = decodeRecords(records(n, colours.get(n)!), {
        pointDataRecordFormat: 7,
        pointRecordLength: 36,
        pointCount: n,
        scale: [0.01, 0.01, 0.01],
        offset: [0, 0, 0],
        renderOrigin: [0, 0, 0],
        rgbEightBit: meta.rgbEightBit,
      });
      return new Promise((resolve) => setTimeout(() => resolve(decoded), delayMs.get(n) ?? 0));
    },
  };
}

const COUNTS = [1000, 800, 600, 400, 300];

async function openCloud(): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 1000 },
      { key: [1, 0, 0, 0], pointCount: 800 },
      { key: [1, 1, 0, 0], pointCount: 600 },
      { key: [2, 0, 0, 0], pointCount: 400 },
      { key: [2, 1, 0, 0], pointCount: 300 },
    ],
  });
  return StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'rgb.copc.laz');
}

/** Stream until every node is resident; return the drawn colours per point count. */
async function streamColours(colours: Map<number, Rgb[]>, delayMs: Map<number, number>) {
  const cloud = await openCloud();
  const drawn = new Map<number, number[]>();
  const scheduler = new StreamingScheduler(
    cloud,
    decoderFor(colours, delayMs),
    {
      onNodeReady: (node, d) => drawn.set(node.record.pointCount, Array.from(d.rgb!.subarray(0, 9))),
      onNodeEvicted: (node) => drawn.delete(node.record.pointCount),
    },
    streamingBudgets('balanced', false),
  );
  for (let round = 0; round < 400; round++) {
    scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0 && drawn.size === COUNTS.length) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  return { drawn, eightBitPin: cloud.decodeMeta(cloud.octree.nodes()[0].record).rgbEightBit };
}

/** First nine narrowed channels of a node whose colours cycle through `c`. */
function expected(c: number[][]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) out.push(...c[i % c.length]);
  return out;
}

const DARK: Rgb[] = [[200, 150, 100], [0, 0, 0]];
const BRIGHT: Rgb[] = [[255 * 256, 128 * 256, 64 * 256], [65535, 65535, 65535], [0xab00, 0x1200, 0x8000]];
const MID: Rgb[] = [[30000, 20000, 10000]];

function sixteenBitFile(): Map<number, Rgb[]> {
  return new Map<number, Rgb[]>([[1000, DARK], [800, BRIGHT], [600, MID], [400, MID], [300, MID]]);
}

function checkSixteenBit(drawn: Map<number, number[]>): void {
  expect(drawn.size).toBe(5);
  // A dark node in a 16-bit file is near black: every channel's high byte is 0.
  expect(drawn.get(1000)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(drawn.get(800)).toEqual([255, 128, 64, 255, 255, 255, 171, 18, 128]);
  for (const n of [600, 400, 300]) expect(drawn.get(n)).toEqual(expected([[117, 78, 39]]));
}

describe('streamed RGB bit depth does not depend on arrival order', () => {
  it('16-bit file, dark node first', async () => {
    const delays = new Map([[1000, 0], [800, 30], [600, 30], [400, 30], [300, 30]]);
    const { drawn, eightBitPin } = await streamColours(sixteenBitFile(), delays);
    checkSixteenBit(drawn);
    expect(eightBitPin).toBe(false);
  });

  it('16-bit file, bright node first', async () => {
    const delays = new Map([[1000, 30], [800, 0], [600, 30], [400, 30], [300, 30]]);
    const { drawn, eightBitPin } = await streamColours(sixteenBitFile(), delays);
    checkSixteenBit(drawn);
    expect(eightBitPin).toBe(false);
  });

  it('16-bit file, dark node decoded in parallel and arriving after the proof', async () => {
    const delays = new Map([[1000, 40], [800, 0], [600, 5], [400, 5], [300, 5]]);
    const { drawn } = await streamColours(sixteenBitFile(), delays);
    checkSixteenBit(drawn);
  });

  const eightBitFile = (): Map<number, Rgb[]> =>
    new Map<number, Rgb[]>([
      [1000, [[10, 20, 30]]],
      [800, [[255, 128, 64]]],
      [600, [[1, 2, 3]]],
      [400, [[200, 200, 200]]],
      [300, [[0, 0, 0]]],
    ]);

  for (const [name, delays] of [
    ['8-bit file, root first', new Map([[1000, 0], [800, 20], [600, 20], [400, 20], [300, 20]])],
    ['8-bit file, root last', new Map([[1000, 30], [800, 0], [600, 5], [400, 10], [300, 15]])],
  ] as const) {
    it(name, async () => {
      const { drawn, eightBitPin } = await streamColours(eightBitFile(), delays);
      expect(drawn.size).toBe(5);
      expect(drawn.get(1000)).toEqual(expected([[10, 20, 30]]));
      expect(drawn.get(800)).toEqual(expected([[255, 128, 64]]));
      expect(drawn.get(600)).toEqual(expected([[1, 2, 3]]));
      expect(drawn.get(400)).toEqual(expected([[200, 200, 200]]));
      expect(drawn.get(300)).toEqual(expected([[0, 0, 0]]));
      expect(eightBitPin).toBeUndefined();
    });
  }
});

describe('the streaming source pins only 16-bit colour', () => {
  it('ignores an all-8-bit chunk and keeps a 16-bit decision', async () => {
    const cloud = await openCloud();
    const rec = cloud.octree.nodes()[0].record;
    cloud.noteDecodedRgbDepth(true);
    expect(cloud.decodeMeta(rec).rgbEightBit).toBeUndefined();
    cloud.noteDecodedRgbDepth(false);
    expect(cloud.decodeMeta(rec).rgbEightBit).toBe(false);
    cloud.noteDecodedRgbDepth(true);
    expect(cloud.decodeMeta(rec).rgbEightBit).toBe(false);
  });
});
