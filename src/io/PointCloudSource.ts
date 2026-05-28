/**
 * PointCloudSource.ts
 *
 * The abstraction every point-cloud origin implements — a local file today,
 * and (in v0.3) a remote file, a COPC dataset, or a range-request stream.
 *
 * `metadata()` is the cheap preflight: enough to tell the user what the source
 * is and how it will load, with no body decode. `load()` runs the full decode.
 * Splitting the two is what lets the UI show a confident "PTX scan detected,
 * large-file optimization enabled" summary before committing to the load.
 *
 * ships exactly one implementation — `LocalFileSource`. The interface is
 * the seam for v0.3 streaming; no remote loading is implemented here.
 *
 * Pure types — no DOM, no three.js.
 */

import type { SourceFormat } from './sniffFormat';
import type { LoadResult, LoadCallbacks, LoadOptions } from './loadFile';

/** Where a point cloud comes from. Extended in v0.3 (`url`, `copc`). */
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
}

/**
 * A point-cloud origin. Implementations decode into the same `PointCloud`
 * regardless of where the bytes came from.
 */
export interface PointCloudSource {
  /** The kind of source — drives diagnostics and v0.3 routing. */
  type(): SourceType;
  /** Cheap preflight: format, size, and (when known) point count + load mode. */
  metadata(options?: LoadOptions): Promise<SourceMetadata>;
  /** Decode the source fully into a `PointCloud`. */
  load(callbacks?: LoadCallbacks, options?: LoadOptions): Promise<LoadResult>;
}
