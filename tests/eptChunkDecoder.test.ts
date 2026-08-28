/**
 * tests/eptChunkDecoder.test.ts
 *
 * Dispatch tests for `EptChunkDecoder` — the routing layer the scheduler hands
 * tiles to. Verifies each `dataType` reaches the right backend:
 *   • binary  → in-process `decodeBinary` (no worker)
 *   • laszip + worker → the worker client (off the main thread)
 *   • laszip, no worker → in-process `decodeEptLaszipTile` fallback
 *   • zstandard → typed unsupported error
 * The decode core is mocked so these assert routing only, not laz-perf.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const decodeEptLaszipTile = vi.fn();
vi.mock('../src/io/ept/eptLaszipDecode', () => ({
  decodeEptLaszipTile: (...args: unknown[]) => decodeEptLaszipTile(...args),
}));

import { EptChunkDecoder } from '../src/io/ept/EptChunkDecoder';
import type { EptStreamingPointCloud } from '../src/render/streaming/EptStreamingPointCloud';
import type { EptLaszipWorkerClient } from '../src/io/ept/worker/eptLaszipWorkerClient';
import type { ChunkDecodeMetadata, DecodedChunk } from '../src/io/copc/copcChunkDecode';
import { lasHeaderBuffer } from './helpers/lasHeaderBytes';

const RENDER_ORIGIN: [number, number, number] = [100, 200, 300];

// The laszip path parses the tile's own LAS public header BEFORE decompression
// and refuses when its point count disagrees with the hierarchy count. A
// routing test therefore has to hand it a real header whose count matches
// META.pointCount (5); a 16-byte stand-in would trip the pre-decode gate before
// the routing assertion runs. The binary / zstandard / abort cases never reach
// the header parse, so they keep their tiny buffers.
const LAS_TILE_5 = lasHeaderBuffer(5);

// pointCount matches META.pointCount below: EptChunkDecoder now reconciles the
// decoded laszip tile's count against the hierarchy count and refuses a
// mismatch, so a routing mock must agree with the metadata it is dispatched
// with or it trips that guard before the routing assertion runs.
function fakeChunk(): DecodedChunk {
  return { pointCount: 5 } as unknown as DecodedChunk;
}

function fakeCloud(
  dataType: 'binary' | 'laszip' | 'zstandard',
  decodeBinary = vi.fn(() => fakeChunk()),
): EptStreamingPointCloud {
  return {
    dataType,
    renderOrigin: RENDER_ORIGIN,
    decodeBinary,
  } as unknown as EptStreamingPointCloud;
}

function fakeWorker(decodeTile = vi.fn(async () => fakeChunk())): {
  client: EptLaszipWorkerClient;
  decodeTile: ReturnType<typeof vi.fn>;
} {
  return { client: { decodeTile } as unknown as EptLaszipWorkerClient, decodeTile };
}

const META: ChunkDecodeMetadata = { pointCount: 5 } as unknown as ChunkDecodeMetadata;
/** Metadata carrying a pinned dataset-level RGB bit-depth decision. */
const META_RGB: ChunkDecodeMetadata = {
  pointCount: 5,
  rgbEightBit: true,
} as unknown as ChunkDecodeMetadata;

beforeEach(() => {
  decodeEptLaszipTile.mockReset();
  decodeEptLaszipTile.mockResolvedValue(fakeChunk());
});

describe('EptChunkDecoder dispatch', () => {
  test('binary path decodes in-process, never touching laszip backends', async () => {
    const decodeBinary = vi.fn(() => fakeChunk());
    const { client, decodeTile } = fakeWorker();
    const decoder = new EptChunkDecoder(fakeCloud('binary', decodeBinary), client);

    await decoder.decode(new ArrayBuffer(16), META);

    expect(decodeBinary).toHaveBeenCalledWith(expect.any(ArrayBuffer), 5, undefined);
    expect(decodeTile).not.toHaveBeenCalled();
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('binary path forwards the pinned dataset RGB bit-depth to the decoder', async () => {
    const decodeBinary = vi.fn(() => fakeChunk());
    const decoder = new EptChunkDecoder(fakeCloud('binary', decodeBinary), null);

    await decoder.decode(new ArrayBuffer(16), META_RGB);

    expect(decodeBinary).toHaveBeenCalledWith(expect.any(ArrayBuffer), 5, true);
  });

  test('laszip + worker routes to the worker, off the main thread', async () => {
    const { client, decodeTile } = fakeWorker();
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), client);
    const chunk = LAS_TILE_5;
    const signal = new AbortController().signal;

    await decoder.decode(chunk, META, signal);

    expect(decodeTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, signal, undefined);
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('laszip + worker forwards the pinned dataset RGB bit-depth', async () => {
    const { client, decodeTile } = fakeWorker();
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), client);
    const chunk = LAS_TILE_5;

    await decoder.decode(chunk, META_RGB);

    expect(decodeTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, undefined, true);
  });

  test('laszip with no worker falls back to in-process decode', async () => {
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), null);
    const chunk = LAS_TILE_5;

    await decoder.decode(chunk, META);

    expect(decodeEptLaszipTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, undefined);
  });

  test('laszip in-process fallback forwards the pinned dataset RGB bit-depth', async () => {
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), null);
    const chunk = LAS_TILE_5;

    await decoder.decode(chunk, META_RGB);

    expect(decodeEptLaszipTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, true);
  });

  test('an already-aborted signal throws before any decode runs', async () => {
    const { client, decodeTile } = fakeWorker();
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), client);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(decoder.decode(new ArrayBuffer(8), META, ctrl.signal)).rejects.toThrow(
      /abort/i,
    );
    expect(decodeTile).not.toHaveBeenCalled();
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('zstandard throws a typed unsupported error', async () => {
    const decoder = new EptChunkDecoder(fakeCloud('zstandard'), null);
    await expect(decoder.decode(new ArrayBuffer(8), META)).rejects.toThrow(
      /zstandard.*not supported/i,
    );
  });
});

describe('EptChunkDecoder pre-decode admission (Finding 5)', () => {
  // hierarchy count 100, header count 5,000,000: laz-perf must NEVER be invoked.
  const HIERARCHY_100: ChunkDecodeMetadata = {
    pointCount: 100,
  } as unknown as ChunkDecodeMetadata;
  const HEADER_5M = lasHeaderBuffer(5_000_000);

  test('worker path: a header count over the hierarchy count is refused before decode', async () => {
    const { client, decodeTile } = fakeWorker();
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), client);

    await expect(decoder.decode(HEADER_5M, HIERARCHY_100)).rejects.toThrow(
      /malformed EPT dataset.*5000000.*100/s,
    );
    // The decode entry point is never reached — memory is not admitted.
    expect(decodeTile).not.toHaveBeenCalled();
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('in-process path: a header count over the hierarchy count is refused before decode', async () => {
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), null);

    await expect(decoder.decode(HEADER_5M, HIERARCHY_100)).rejects.toThrow(
      /before decompression/,
    );
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('a header count that matches the hierarchy count passes the gate', async () => {
    // The decoded count must also agree so the post-decode reconciliation is
    // satisfied; this test isolates the pre-decode gate letting a valid tile
    // through to the decoder.
    const { client, decodeTile } = fakeWorker(
      vi.fn(async () => ({ pointCount: 100 }) as unknown as DecodedChunk),
    );
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), client);
    const tile = lasHeaderBuffer(100);

    await decoder.decode(tile, HIERARCHY_100);

    expect(decodeTile).toHaveBeenCalledTimes(1);
  });
});
