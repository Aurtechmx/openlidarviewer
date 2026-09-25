/**
 * PointCloudSource.ts
 *
 * The abstraction `LocalFileSource` implements for a file the user picked or
 * dropped locally. Streaming and heavy sources converge on `StreamingSource`
 * instead (src/render/streaming/StreamingSource.ts): `StreamingPointCloud`
 * for COPC, `EptStreamingPointCloud` for EPT, `TilesetStreamingSource` for
 * 3D Tiles, and `OlvTileSource` / `PreviewCloudSource` for heavy loading.
 *
 * `metadata()` is the cheap preflight: enough to tell the user what the source
 * is and how it will load, with no body decode. `load()` runs the full decode.
 * Splitting the two is what lets the UI show a confident "PTX scan detected,
 * large-file optimization enabled" summary before committing to the load.
 *
 * `LocalFileSource` is the only implementation; `main.ts` is the sole caller
 * that constructs one. Referenced elsewhere by loadFile.ts and
 * preloadSummary.ts (the `SourceMetadata` type), and by range/RangeSource.ts,
 * which contrasts it with the streaming/range path. embedConfig.ts also
 * references it, but that file's own `?copc=` comment is itself stale: COPC
 * and EPT resolve through HttpRangeSource/StreamingSource in main.ts's
 * handleRemoteUrl, never through this abstraction.
 *
 * Pure types — no DOM, no three.js.
 */

import type { SourceFormat } from './sniffFormat';
import type { LoadResult, LoadCallbacks, LoadOptions } from './loadFile';

/**
 * Where a point cloud comes from. Always `'local-file'` in practice.
 * `url` and `copc` were a v0.3 plan that streaming sources
 * (`StreamingSource`) implement instead.
 */
export type SourceType = 'local-file' | 'url' | 'copc';

/** The cheap preflight result — what a source is, before any body decode. */
export interface SourceMetadata {
  /** Detected format. */
  format: SourceFormat;
  /** Human-readable format label, e.g. "PTX scan". */
  label: string;
  /** Source size in bytes. */
  byteSize: number;
  /** Point count, when the format reveals one before decoding (LAS/LAZ/PTS). */
  estimatedPointCount?: number;
  /** One-line description of the chosen load strategy, when known. */
  loadModeSummary?: string;
  /**
   * A pre-decode caution shown before the (expensive) parse — e.g. a large
   * non-LAS file that decodes fully in memory and may spike RAM. Undefined when
   * there is nothing to warn about.
   */
  warning?: string;
}

/**
 * A point-cloud origin. Implementations decode into the same `PointCloud`
 * regardless of where the bytes came from.
 */
export interface PointCloudSource {
  /** Unused: `LocalFileSource` is the only implementer and always returns `'local-file'`. */
  type(): SourceType;
  /** Cheap preflight: format, size, and (when known) point count + load mode. */
  metadata(options?: LoadOptions): Promise<SourceMetadata>;
  /** Decode the source fully into a `PointCloud`. */
  load(callbacks?: LoadCallbacks, options?: LoadOptions): Promise<LoadResult>;
}
