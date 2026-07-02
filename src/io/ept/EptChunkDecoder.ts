/**
 * EptChunkDecoder.ts
 *
 * The EPT-aware `ChunkDecoder` the scheduler hands tiles to. Dispatches
 * on the source's `dataType`:
 *
 *   • `binary`    → in-process `decodeEptBinaryTile` (no worker round-trip).
 *                   The synthetic fixture + end-to-end tests exercise this
 *                   path.
 *   • `laszip`    → per-tile laz-perf decode (each EPT laszip tile is a
 *                   complete LAZ file with its own LAS header, not a raw
 *                   COPC chunk), reusing the cached laz-perf WASM module.
 *   • `zstandard` → not supported in this release.
 *
 * The decoder is constructed against a single `EptStreamingPointCloud` so it
 * knows the schema + render origin without re-fetching them per tile.
 *
 * Pure of three.js. Implements the same `ChunkDecoder` interface the COPC
 * pipeline uses so the scheduler stays format-agnostic.
 */

import type {
  ChunkDecodeMetadata,
  ChunkDecoder,
  DecodedChunk,
} from '../copc/copcChunkDecode';
import type { EptStreamingPointCloud } from '../../render/streaming/EptStreamingPointCloud';
import type { EptLaszipWorkerClient } from './worker/eptLaszipWorkerClient';
import { decodeEptLaszipTile } from './eptLaszipDecode';

export class EptChunkDecoder implements ChunkDecoder {
  private readonly _cloud: EptStreamingPointCloud;
  /**
   * Optional decode worker for the `laszip` path. When supplied, full-tile
   * laz-perf decode runs off the main thread; when absent (the binary path,
   * and Node unit tests), decode runs in-process via `decodeEptLaszipTile`.
   * Injected rather than self-created so the worker's lifetime is owned by
   * `main.ts` — one per session, like the COPC decode worker.
   */
  private readonly _laszipWorker: EptLaszipWorkerClient | null;

  constructor(
    cloud: EptStreamingPointCloud,
    laszipWorker: EptLaszipWorkerClient | null = null,
  ) {
    this._cloud = cloud;
    this._laszipWorker = laszipWorker;
  }

  async decode(
    chunk: ArrayBuffer,
    meta: ChunkDecodeMetadata,
    signal?: AbortSignal,
  ): Promise<DecodedChunk> {
    if (signal?.aborted) throw new Error('EPT decode aborted');
    switch (this._cloud.dataType) {
      case 'binary':
        // Synchronous schema-driven decode — keep on the main thread for
        // the binary path; tile sizes are typically tens-of-thousands of
        // points and decoding is a few hundred microseconds. The dataset-
        // level RGB bit-depth rides `meta.rgbEightBit` (pinned by the source
        // from the first decoded RGB tile) so every tile narrows identically.
        return this._cloud.decodeBinary(chunk, meta.pointCount, meta.rgbEightBit);
      case 'laszip':
        // Full-tile laz-perf decode. EPT laszip tiles are complete LAZ files
        // (each with its own LAS header); the decoder applies the per-tile
        // scale/offset PLUS the EPT cloud's render origin in Float64 before
        // narrowing to Float32. When a worker is wired, the decode runs off
        // the main thread (the tile buffer is transferred zero-copy); the
        // in-process path is the fallback for environments without a worker.
        // Both carry `meta.rgbEightBit` — the dataset-level colour decision.
        return this._laszipWorker
          ? this._laszipWorker.decodeTile(
              chunk, this._cloud.renderOrigin, signal, meta.rgbEightBit)
          : decodeEptLaszipTile(chunk, this._cloud.renderOrigin, meta.rgbEightBit);
      case 'zstandard':
        throw new Error(
          'EPT zstandard tile decode is not supported in this build. ' +
          'Convert the dataset to laszip with PDAL or Entwine to load it.',
        );
    }
  }
}
