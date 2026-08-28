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
import { parseLasHeader } from '../lasHeader';
import { LoadError } from '../loadErrors';

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
        {
          // Memory-admission gate, BEFORE any laz-perf decompression. The
          // scheduler admitted this node and reserved its memory on the
          // hierarchy point count (`meta.pointCount`), but an EPT laszip tile is
          // a complete LAZ file whose own LAS public header count drives the
          // decode allocation. Parsing the header is cheap (no decompression) and
          // catches the disagreement before the tile is handed to laz-perf — so a
          // header claiming 5,000,000 points against a hierarchy of 100 never
          // reaches the decoder or reserves its allocation. A disagreement is the
          // dataset contradicting itself, not a transport fault a re-fetch could
          // heal, so fail closed (permanent). The post-decode reconciliation
          // below stays as defense-in-depth for the pointCount the decoder
          // actually produced.
          const headerPointCount = parseLasHeader(chunk).pointCount;
          if (headerPointCount !== meta.pointCount) {
            throw new LoadError(
              'malformed-file',
              `malformed EPT dataset: laszip tile header declares ` +
                `${headerPointCount} points but its hierarchy entry declares ` +
                `${meta.pointCount}. The hierarchy count governs memory ` +
                `admission; refusing the tile before decompression.`,
            );
          }
          const decoded = await (this._laszipWorker
            ? this._laszipWorker.decodeTile(
                chunk, this._cloud.renderOrigin, signal, meta.rgbEightBit)
            : decodeEptLaszipTile(chunk, this._cloud.renderOrigin, meta.rgbEightBit));
          // The scheduler admitted this node — and reserved its memory — on the
          // HIERARCHY point count (`meta.pointCount`). But an EPT laszip tile is
          // a self-describing LAZ file whose own LAS header count drives the
          // decode allocation. When the two disagree, the header wins by default
          // and the memory-admission estimate is bypassed by that ratio: a
          // hierarchy of 100k against a header of 10M lets a tile 100x its
          // reservation through. A disagreement is not a transport fault a
          // re-fetch could heal — it is the dataset contradicting itself — so
          // fail closed (permanent) rather than trust the tile's own figure.
          if (decoded.pointCount !== meta.pointCount) {
            throw new LoadError(
              'malformed-file',
              `malformed EPT dataset: laszip tile declares ${decoded.pointCount} ` +
                `points but its hierarchy entry declares ${meta.pointCount}. The ` +
                `hierarchy count governs memory admission; refusing the tile.`,
            );
          }
          return decoded;
        }
      case 'zstandard':
        throw new Error(
          'EPT zstandard tile decode is not supported in this build. ' +
          'Convert the dataset to laszip with PDAL or Entwine to load it.',
        );
    }
  }
}
