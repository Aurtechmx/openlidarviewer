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

import type { Box6, StreamingNodeRecord } from '../../io/copc/copcTypes';
import type { CloudFrameProvenance } from '../../geo/frame/frameProvenance';
import type { SpatialFrame } from '../../geo/frame/spatialFrame';
import type { ChunkDecodeMetadata, DecodedChunk } from '../../io/copc/copcChunkDecode';
import type { PntsDecodeMetadata } from '../../io/tiles3d/pntsDecode';
import type { StreamingNode } from './StreamingNode';
import type { NodeCounts, StreamingNodeStore } from './StreamingNodeStore';

/**
 * The colour modes a streaming cloud can drive — shared by the source
 * contract and its COPC / EPT implementations.
 */
export type StreamingColorMode =
  | 'rgb'
  | 'intensity'
  | 'elevation'
  | 'classification'
  | 'normal';

/**
 * The minimal public surface the scheduler / renderer / picking path read off
 * a streaming source's octree. Extracted as a structural interface so the
 * `EptOctree` satisfies it without inheriting from the COPC-specific
 * `StreamingOctree` class (which carries private fields that would force
 * nominal typing).
 *
 * Both `StreamingOctree` (COPC) and `EptOctree` (EPT) implement this surface.
 * New streaming formats expose these members.
 */
export interface StreamingOctreeView {
  /** The shared node store — generic across formats. */
  readonly store: StreamingNodeStore;
  /** Every known node in the octree. */
  nodes(): StreamingNode[];
  /**
   * Whether the whole hierarchy index loaded with nothing dropped — no page/
   * file ceiling hit, no swallowed fetch failure, no skipped malformed entry.
   * false when any node is missing from the store, so a completeness-sensitive
   * consumer can refuse to overclaim (the full-cloud grade's "exact" label).
   * Distinct from a "walk finished" flag: a walk can finish having dropped
   * subtrees, which is exactly the silent under-report the grade must not make.
   */
  readonly isComplete: boolean;
  /**
   * Hierarchy errors recorded while loading the index (a ceiling hit, a fetch
   * failure, or a malformed entry). On the shared contract so a consumer can
   * report HOW MANY regions were dropped instead of leaving the count
   * write-only.
   */
  readonly errors: readonly string[];
}

/**
 * What a decoder is handed alongside a node's bytes.
 *
 * The scheduler never reads a field of this: it obtains it from the source and
 * passes it to the decoder the source was built with. So the union only has to
 * be wide enough for every body a source can serve. LAS metadata carries no
 * `format` field, which is what lets a decoder narrow with an `in` check
 * without a single existing metadata site changing.
 */
export type NodeDecodeMetadata = ChunkDecodeMetadata | PntsDecodeMetadata;

/** The on-disk format a streaming source is backed by. */
export type StreamingSourceKind = 'copc' | 'ept' | 'tiles' | '3dtiles';

/**
 * The name to show a user for a source kind. Kept beside the union so a new
 * kind cannot be added without deciding what the scan report calls it — the
 * report used to branch on `kind === 'ept'` and label everything else COPC,
 * which would have mislabelled a third format the moment one existed.
 */
export function streamingSourceLabel(kind: StreamingSourceKind): string {
  switch (kind) {
    case 'ept':
      return 'EPT (Entwine Point Tile)';
    case 'tiles':
      return 'OLV tile store (out-of-core index)';
    case '3dtiles':
      return '3D Tiles (point tiles)';
    case 'copc':
      return 'COPC (Cloud Optimized Point Cloud)';
  }
}

/**
 * The short format token for a source kind — what the PDF report's metadata
 * block prints beside a static cloud's `LAS` or `PLY`.
 */
export function streamingFormatToken(kind: StreamingSourceKind): string {
  switch (kind) {
    case 'ept':
      return 'EPT';
    case 'tiles':
      return 'OLV tiles';
    case '3dtiles':
      return '3D Tiles';
    case 'copc':
      return 'COPC';
  }
}

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
  /**
   * The stable shell id for this streaming session — non-null and distinct per
   * open, minted by {@link nextStreamingScanId}. A streaming scan never enters
   * the static cloud registry, so this is the only identity the export/terrain
   * scan-identity guards can compare to catch a streaming→streaming swap.
   */
  readonly id: string;
  /** Which on-disk format is open. */
  readonly kind: StreamingSourceKind;
  /** Display name — the file or scan name surfaced in the UI. */
  readonly name: string;
  /** Render origin every node is recentred against (float64-stable). */
  readonly renderOrigin: [number, number, number];
  /**
   * How a source coordinate becomes a render coordinate, and back.
   *
   * Every format streamed today recentres and does not rotate, so this is a
   * translated-cartesian frame built on {@link renderOrigin} and the two agree
   * exactly. A consumer that reconstructs a source coordinate should go through
   * the frame rather than adding the origin, because a source in a geocentric
   * frame needs a rotation that no offset can express, and the frame is where
   * that arrives. `frame.isTranslationOnly` is how a caller that cannot yet do
   * so refuses rather than reporting a coordinate off by hundreds of metres.
   */
  readonly frame: SpatialFrame;
  /**
   * What the SOURCE DOCUMENT established about the frame, as opposed to the
   * conversion {@link frame} performs.
   *
   * The two answer different questions. `frame` always exists, because every
   * source has to put its points somewhere; this says whether the document ever
   * stated which way is up. A 3D Tiles tileset with only a `box` bounding
   * volume declares nothing, so it records `basis: 'unknown'` and no vertical
   * reference, and the Scan Report can say so. Absent that record, a tileset
   * whose up axis was never established is indistinguishable from one whose
   * was: both recentre, both fit the camera, both draw.
   *
   * UNKNOWN IS A VALUE, NOT AN ABSENT ONE. A source that asked and could not
   * establish the frame records `basis: 'unknown'`. Omitting the property is a
   * different statement — "this source has not been taught to answer yet" —
   * and consumers must not read one as the other.
   *
   * Optional only because the COPC, EPT and OLV-tile sources predate it and
   * settling what those three declare is a separate question (a projected-CRS
   * COPC has a known up that this record's two-value basis cannot yet express).
   * `tests/streamingFrameProvenance.test.ts` holds the shrink-only list of
   * sources still omitting it, so a NEW source cannot join them silently.
   */
  readonly frameProvenance?: CloudFrameProvenance;
  /** The runtime octree — nodes, state, scoring inputs. */
  readonly octree: StreamingOctreeView;
  /**
   * Total points in the source, or `null` when the source cannot say.
   *
   * COPC reads it from the LAS header and EPT from `ept.json`, so both always
   * know. A 3D Tiles tileset generally does not: the hierarchy names content
   * URIs, not point totals, and the only way to a total is fetching every tile,
   * which is the one thing a streaming source must not do to open.
   *
   * Null is not zero, and the difference is the whole reason this is nullable.
   * Zero is a real answer meaning an empty source; null means the question has
   * no answer yet. A consumer that coerces one to the other reports an empty
   * scan, a density of zero, or a capture type inferred from a density that was
   * never measured. {@link residentPointCount} stays a number, because what is
   * on the GPU is always known.
   */
  readonly sourcePointCount: number | null;
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
  defaultColorMode(): StreamingColorMode;
  /**
   * The colour modes the cloud can actually drive. The Viewer surfaces
   * these to the Inspector's "Color by" chip row so a cloud that lacks
   * (say) classification doesn't show a Class chip that produces a blank
   * recolour.
   */
  availableColorModes(): readonly StreamingColorMode[];
  /**
   * Whether the source's OWN metadata establishes that its point records carry
   * GPS time — read before a single chunk is decoded, because the export panel
   * has to decide what to offer while the cloud is still filling in.
   *
   * Every implementation answers from something the document states, never from
   * the format's usual habits: COPC from the LAS header flag (its point format
   * is validated as 6/7/8, all of which carry the field), EPT from the
   * `ept.json` schema (X/Y/Z are the only required dimensions, so an EPT that
   * declares no `GpsTime` has none, whether its tiles are binary or laszip),
   * 3D Tiles from the format (a `pnts` tile has no GPS time to carry).
   *
   * Optional only because the OLV tile store predates it. Absent is not `false`
   * in meaning: it says this source has not been taught to answer, which is why
   * {@link streamingHasGpsTime} resolves it conservatively rather than callers
   * each picking a default. `tests/streamingGpsTimeClaim.test.ts` holds the
   * shrink-only list of sources still omitting it, so a NEW source cannot join
   * them silently.
   */
  hasGpsTime?(): boolean;
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
  decodeMeta(record: StreamingNodeRecord): NodeDecodeMetadata;
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
   * Record which measured channels a decoded chunk actually carried.
   *
   * COPC and EPT state their channels once, in a header or a schema, so both
   * omit this and answer {@link availableColorModes} from the document. A 3D
   * Tiles tileset states them PER TILE: whether it carries colour, or surface
   * normals, is not knowable until tiles have been read, and reading every tile
   * to find out is the one thing a streaming source must not do to open.
   *
   * So the answer is folded from what has actually been served. Before the
   * first chunk a source that needs this offers neither channel, because a mode
   * offered ahead of any tile is a promise about tiles nobody has seen; and it
   * never offers one that would resolve to a different channel underneath.
   */
  noteDecodedChannels?(chunk: DecodedChunk): void;
  /**
   * Release any resource the source holds open — a file handle, a range
   * reader, a decode worker. Called by the Viewer when the streaming cloud is
   * detached. Optional: a stateless source (a remote EPT over `fetch`) has
   * nothing to release and omits it; a COPC source closes its range reader.
   */
  close?(): Promise<void>;
}

/**
 * Whether a streaming cloud carries GPS time, as its own metadata states it.
 *
 * This is what the export panel offers a GPS time field on, and what the LAS
 * writers size their records against, so it is a claim about the data rather
 * than a hint. The shell used to answer it with a literal `true` on the grounds
 * that COPC mandates point format 6, 7 or 8. That holds for COPC and reaches
 * none of the other three: an EPT schema need only declare X, Y and Z, a laszip
 * EPT tile at PDRF 0 or 2 carries no GPS time, a `pnts` tile has none at all,
 * and an OLV tile store carries it only when the source it was built from did.
 *
 * A source that has not been taught {@link StreamingSource.hasGpsTime} resolves
 * to `false`, which is the conservative direction and not a claim of absence:
 * the panel declines to offer a field it cannot establish, rather than promising
 * a column the writer may have to fill with zeros. The cost of being wrong that
 * way is an unoffered field; the cost of the other way is an export whose GPS
 * time column is fabricated. Sources still in that position are listed in
 * `tests/streamingGpsTimeClaim.test.ts`, and the list is shrink-only.
 */
export function streamingHasGpsTime(source: StreamingSource): boolean {
  return source.hasGpsTime?.() === true;
}

// Re-export `DecodedChunk` so consumers that import `StreamingSource` need
// only one import for the decode-side type vocabulary.
export type { DecodedChunk } from '../../io/copc/copcChunkDecode';
