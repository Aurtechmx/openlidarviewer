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

const RENDER_ORIGIN: [number, number, number] = [100, 200, 300];

function fakeChunk(): DecodedChunk {
  return { pointCount: 1 } as unknown as DecodedChunk;
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
    const chunk = new ArrayBuffer(16);
    const signal = new AbortController().signal;

    await decoder.decode(chunk, META, signal);

    expect(decodeTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, signal, undefined);
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('laszip + worker forwards the pinned dataset RGB bit-depth', async () => {
    const { client, decodeTile } = fakeWorker();
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), client);
    const chunk = new ArrayBuffer(16);

    await decoder.decode(chunk, META_RGB);

    expect(decodeTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, undefined, true);
  });

  test('laszip with no worker falls back to in-process decode', async () => {
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), null);
    const chunk = new ArrayBuffer(16);

    await decoder.decode(chunk, META);

    expect(decodeEptLaszipTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, undefined);
  });

  test('laszip in-process fallback forwards the pinned dataset RGB bit-depth', async () => {
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), null);
    const chunk = new ArrayBuffer(16);

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
