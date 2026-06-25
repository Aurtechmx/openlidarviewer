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

    expect(decodeBinary).toHaveBeenCalledWith(expect.any(ArrayBuffer), 5);
    expect(decodeTile).not.toHaveBeenCalled();
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('laszip + worker routes to the worker, off the main thread', async () => {
    const { client, decodeTile } = fakeWorker();
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), client);
    const chunk = new ArrayBuffer(16);
    const signal = new AbortController().signal;

    await decoder.decode(chunk, META, signal);

    expect(decodeTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN, signal);
    expect(decodeEptLaszipTile).not.toHaveBeenCalled();
  });

  test('laszip with no worker falls back to in-process decode', async () => {
    const decoder = new EptChunkDecoder(fakeCloud('laszip'), null);
    const chunk = new ArrayBuffer(16);

    await decoder.decode(chunk, META);

    expect(decodeEptLaszipTile).toHaveBeenCalledWith(chunk, RENDER_ORIGIN);
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
