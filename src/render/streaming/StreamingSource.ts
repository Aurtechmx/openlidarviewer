/**
 * StreamingSource.ts
 *
 * v0.3.2 Phase 3 — the format-agnostic streaming source interface.
 *
 * Today, the viewer streams from COPC files via {@link StreamingPointCloud};
 * tomorrow (v0.3.3), it will also stream from EPT (Entwine Point Tile)
 * pyramids. Both formats are octree-organised LAZ tile sets — they differ in
 * how the index is stored (a COPC VLR plus per-chunk records vs. an EPT
 * `ept.json` plus a separate hierarchy index), but the *runtime* shape the
 * scheduler / renderer / Viewer need is identical: a node store, a way to
 * read a node's compressed chunk, a way to describe how that chunk decodes,
 * a render origin, and a handful of counts and bounds.
 *
 * This file declares that runtime shape as an interface so the scheduler
 * never has to know which format it is streaming, and so v0.3.3 can add an
 * `EptStreamingSource` class without touching {@link StreamingScheduler},
 * {@link StreamingRenderer}, or the picking path.
 *
 * Pure — no DOM, no three.js — entirely a type/contract module.
 */

import type { Box6 } from '../../io/copc/copcTypes';
import type {
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../../io/copc/copcChunkDecode';
import type { StreamingNodeRecord } from '../../io/copc/copcTypes';
import type { StreamingOctree } from './StreamingOctree';
import type { NodeCounts } from './StreamingNodeStore';

/** The on-disk format a streaming source is backed by. */
export type StreamingSourceKind = 'copc' | 'ept';

/**
 * The format-agnostic streaming source.
 *
 * Implementations:
 *   • {@link StreamingPointCloud} — COPC (v0.3.0). Already conforms.
 *   • `EptStreamingSource` — EPT (v0.3.3). To be added.
 *
 * The interface is intentionally narrow: anything format-specific (the COPC
 * VLR, the EPT `ept.json`) is held by the concrete implementation and not
 * surfaced here. Callers that need to know which format is open inspect
 * {@link kind}.
 */
export interface StreamingSource {
  /** Which on-disk format is open. */
  readonly kind: StreamingSourceKind;
  /** Display name — the file or scan name surfaced in the UI. */
  readonly name: string;
  /** Render origin every node is recentred against (float64-stable). */
  readonly renderOrigin: [number, number, number];
  /** The runtime octree — nodes, state, scoring inputs. */
  readonly octree: StreamingOctree;
  /** Total points in the source — not the displayed (resident) count. */
  readonly sourcePointCount: number;
  /** Points currently uploaded to the GPU. */
  readonly residentPointCount: number;

  /** Live node counts by lifecycle state. */
  counts(): NodeCounts;
  /** The deepest octree level the hierarchy has revealed. */
  maxDepth(): number;
  /** The cloud's bounds in local (render) space — used to frame the camera. */
  localBounds(): Box6;
  /**
   * Read a node's compressed chunk. The implementation handles any format-
   * specific layout (COPC chunk record vs. EPT tile URL); callers only see
   * an `ArrayBuffer` they can transfer to the decode worker.
   */
  readNodeChunk(
    record: StreamingNodeRecord,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
  /**
   * The decode metadata for a node — point-record format, scale, offset,
   * etc. The scheduler hands this to the {@link ChunkDecoder} along with
   * the chunk bytes, and the worker uses it to produce a {@link DecodedChunk}.
   */
  decodeMeta(record: StreamingNodeRecord): ChunkDecodeMetadata;
}

// Re-export `DecodedChunk` so consumers that import `StreamingSource` need
// only one import for the decode-side type vocabulary.
export type { DecodedChunk };
