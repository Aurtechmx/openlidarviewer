/**
 * StreamingSource.ts
 *
 * the format-agnostic streaming source interface.
 *
 * Today, the viewer streams from COPC files via {@link StreamingPointCloud};
 * It will also stream from EPT (Entwine Point Tile)
 * pyramids. Both formats are octree-organised LAZ tile sets — they differ in
 * how the index is stored (a COPC VLR plus per-chunk records vs. an EPT
 * `ept.json` plus a separate hierarchy index), but the *runtime* shape the
 * scheduler / renderer / Viewer need is identical: a node store, a way to
 * read a node's compressed chunk, a way to describe how that chunk decodes,
 * a render origin, and a handful of counts and bounds.
 *
 * This file declares that runtime shape as an interface so the scheduler
 * never has to know which format it is streaming, and so an EPT-flavoured
 * source can sit alongside the COPC one without touching
 * {@link StreamingScheduler}, {@link StreamingRenderer}, or the picking
 * path.
 *
 * Pure — no DOM, no three.js — entirely a type/contract module.
 */

import type { Box6 } from '../../io/copc/copcTypes';
import type {
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../../io/copc/copcChunkDecode';
import type { StreamingNodeRecord } from '../../io/copc/copcTypes';
import type { StreamingNode } from './StreamingNode';
import type { NodeCounts, StreamingNodeStore } from './StreamingNodeStore';

/**
 * The minimal public surface the scheduler / renderer / picking path read off
 * a streaming source's octree. Extracted as a structural interface so the
 * `EptOctree` satisfies it without inheriting from the COPC-specific
 * `StreamingOctree` class (which carries private fields that would force
 * nominal typing).
 *
 * Both `StreamingOctree` (COPC) and `EptOctree` (EPT) implement this surface.
 * New streaming formats only need to expose these two members.
 */
export interface StreamingOctreeView {
  /** The shared node store — generic across formats. */
  readonly store: StreamingNodeStore;
  /** Every known node in the octree. */
  nodes(): StreamingNode[];
}

/** The on-disk format a streaming source is backed by. */
export type StreamingSourceKind = 'copc' | 'ept';

/**
 * The format-agnostic streaming source.
 *
 * Implementations:
 *   • {@link StreamingPointCloud} — COPC.
 *   • `EptStreamingSource` — EPT.
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
  readonly octree: StreamingOctreeView;
  /** Total points in the source — not the displayed (resident) count. */
  readonly sourcePointCount: number;
  /** Points currently uploaded to the GPU. */
  readonly residentPointCount: number;

  /** Live node counts by lifecycle state. */
  counts(): NodeCounts;
  /** The deepest octree level the hierarchy has revealed. */
  maxDepth(): number;
  /**
   * The octree ROOT CUBE in local (render) space — equal-sided, used to frame
   * the camera. This is NOT the data extent: a 1000×1000×138 m scan has a
   * 1000³ cube, so `localBounds` over-reports the vertical (and any partial-
   * footprint) span. Use {@link dataBounds} for the true data extent, density,
   * and any figure shown to the user.
   */
  localBounds(): Box6;
  /**
   * The TIGHT data AABB in local (render) space — the real extent of the
   * points, from the LAS header (COPC) or `bounds.conforming` (EPT). This is
   * what "Width/Depth/Height", footprint area, and nominal density must use;
   * `localBounds` (the cube) would inflate them. Origin-shifted the same way as
   * `localBounds`, so the two are directly comparable.
   */
  dataBounds(): Box6;
  /**
   * The format-aware default initial colour mode for the cloud. COPC's
   * implementation looks at `metadata.header.hasRgb`; EPT's implementation
   * looks at the schema for Red/Green/Blue attributes. The Viewer reads
   * this off the StreamingSource so it doesn't need to peek at format-
   * specific metadata shapes.
   *
   * Returned values match the runtime's `ColorMode` enum: 'rgb' when the
   * format carries colour, else 'elevation'.
   */
  defaultColorMode(): 'rgb' | 'intensity' | 'elevation' | 'classification' | 'normal';
  /**
   * The colour modes the cloud can actually drive. The Viewer surfaces
   * these to the Inspector's "Color by" chip row so a cloud that lacks
   * (say) classification doesn't show a Class chip that produces a blank
   * recolour.
   */
  availableColorModes(): readonly ('rgb' | 'intensity' | 'elevation' | 'classification' | 'normal')[];
  /**
   * the source CRS, when the cloud carries projection metadata.
   * COPC clouds get this from the LAS VLRs the public-header parser walks
   * (see `src/io/crs.ts`); EPT clouds get it from `ept.json`'s `srs.wkt`
   * field. Returns `null` for clouds without a recoverable CRS — common
   * for raw drone EPTs or COPC files written without projection VLRs.
   * Surfaced in the Scan Intelligence panel + the scan-report card.
   */
  crs(): import('../../io/crs').CrsInfo | null;
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
  /**
   * Record the RGB bit-depth decision the first decoded chunk made, so the
   * source can hand it back through {@link ChunkDecodeMetadata.rgbEightBit} and
   * every later node narrows colour the same way. Both COPC and EPT implement
   * it — 16-bit RGB carries the 8-bit-in-low-byte ambiguity in both formats
   * (EPT's schema types the width, not the writer's use of it). Optional so a
   * future source without the ambiguity can omit it.
   */
  noteDecodedRgbDepth?(eightBit: boolean | undefined): void;
  /**
   * Release any resource the source holds open — a file handle, a range
   * reader, a decode worker. Called by the Viewer when the streaming cloud is
   * detached. Optional: a stateless source (a remote EPT over `fetch`) has
   * nothing to release and omits it; a COPC source closes its range reader.
   */
  close?(): Promise<void>;
}

// Re-export `DecodedChunk` so consumers that import `StreamingSource` need
// only one import for the decode-side type vocabulary.
export type { DecodedChunk };
