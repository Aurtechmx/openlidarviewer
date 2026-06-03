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
import { decodeEptLaszipTile } from './eptLaszipDecode';

export class EptChunkDecoder implements ChunkDecoder {
  private readonly _cloud: EptStreamingPointCloud;

  constructor(cloud: EptStreamingPointCloud) {
    this._cloud = cloud;
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
        // points and decoding is a few hundred microseconds.
        return this._cloud.decodeBinary(chunk, meta.pointCount);
      case 'laszip':
        // Full-tile laz-perf decode on the main thread.
        // EPT laszip tiles are complete LAZ files (each with its own LAS
        // header); the decoder reuses the cached laz-perf WASM module
        // and applies the per-tile scale/offset PLUS the EPT cloud's
        // render origin in Float64 before narrowing to Float32.
        return decodeEptLaszipTile(chunk, this._cloud.renderOrigin);
      case 'zstandard':
        throw new Error(
          'EPT zstandard tile decode is not supported in this build. ' +
          'Convert the dataset to laszip with PDAL or Entwine to load it.',
        );
    }
  }
}
