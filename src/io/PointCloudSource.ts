/**
 * PointCloudSource.ts
 *
 * The abstraction a whole-file point-cloud origin implements — today that is
 * the local dropped or picked file (`LocalFileSource`).
 *
 * `metadata()` is the cheap preflight: enough to tell the user what the source
 * is and how it will load, with no body decode. `load()` runs the full decode.
 * Splitting the two is what lets the UI show a confident "PTX scan detected,
 * large-file optimization enabled" summary before committing to the load.
 *
 * Ships exactly one implementation — `LocalFileSource`. Remote streaming
 * (COPC, EPT) shipped on its own path — `RangeSource` / `StreamingHost` —
 * rather than through this seam, so no remote loading is implemented here.
 *
 * Pure types — no DOM, no three.js.
 */

import type { SourceFormat } from './sniffFormat';
import type { LoadResult, LoadCallbacks, LoadOptions } from './loadFile';

/** Where a whole-file point cloud comes from. `url`/`copc` are reserved; the
 *  remote streaming path routes through `RangeSource`, not this type. */
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
  /** The kind of source — drives diagnostics. */
  type(): SourceType;
  /** Cheap preflight: format, size, and (when known) point count + load mode. */
  metadata(options?: LoadOptions): Promise<SourceMetadata>;
  /** Decode the source fully into a `PointCloud`. */
  load(callbacks?: LoadCallbacks, options?: LoadOptions): Promise<LoadResult>;
}
