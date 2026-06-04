/**
 * types.ts — shared contracts for the point-cloud format converter.
 *
 * Pure data: no DOM, no three.js, no I/O. The converter reuses the existing
 * loaders (`parseBuffer`) to read a file into a `PointCloud`, applies an
 * optional CRS step (assign or reproject), then writes one of the supported
 * output formats. Everything here is deterministic and unit-testable.
 */

/** Output formats the converter can write. */
export type ConvertFormat = 'las' | 'laz' | 'xyz' | 'asc';

/** Human-readable labels + file extensions for each output format. */
export const CONVERT_FORMATS: Record<
  ConvertFormat,
  { label: string; ext: string; binary: boolean; available: boolean }
> = {
  las: { label: 'LAS', ext: 'las', binary: true, available: true },
  // LAZ *encoding* is not yet possible client-side — the bundled laz-perf
  // WASM is a decoder only. Surfaced honestly rather than silently dropped.
  laz: { label: 'LAZ', ext: 'laz', binary: true, available: false },
  xyz: { label: 'XYZ', ext: 'xyz', binary: false, available: true },
  asc: { label: 'ASC', ext: 'asc', binary: false, available: true },
};

/** How the converter should treat the coordinate reference system. */
export type CrsMode =
  /** Leave coordinates and any source CRS tag untouched. */
  | 'keep'
  /** Write the chosen EPSG into the output without moving points. */
  | 'assign'
  /** Transform every point from the source CRS to the target EPSG. */
  | 'reproject';

/** Options that drive a single conversion. */
export interface ConvertOptions {
  /** The output format to write. */
  readonly format: ConvertFormat;
  /** CRS handling. Defaults to `keep`. */
  readonly crsMode?: CrsMode;
  /**
   * Source EPSG. Used for `reproject` when the file carries no CRS of its
   * own (otherwise the file's detected CRS wins). Ignored for `keep`.
   */
  readonly sourceEpsg?: number | null;
  /** Target EPSG for `assign` (the tag to write) and `reproject` (the destination). */
  readonly targetEpsg?: number | null;
  /**
   * ASCII precision (decimal places) for XYZ / ASC. Defaults to 3 (mm).
   */
  readonly asciiPrecision?: number;
}

/** A single produced output file, ready to download. */
export interface ConvertedFile {
  /** Suggested filename including extension. */
  readonly filename: string;
  /** MIME type for the download. */
  readonly mime: string;
  /** The file bytes (binary formats) or UTF-8 text encoded to bytes. */
  readonly bytes: Uint8Array;
}

/** Severity of a line in the conversion log. */
export type LogLevel = 'info' | 'warn' | 'error';

/** One entry in a conversion's log. */
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
}

/** The outcome of converting one input cloud. */
export interface ConvertReport {
  /** Source filename. */
  readonly source: string;
  /** Whether a file was produced. */
  readonly ok: boolean;
  /** Points written (0 on failure). */
  readonly pointCount: number;
  /** The CRS handling actually applied, described for the log. */
  readonly crsNote: string;
  /** Per-conversion log lines. */
  readonly log: ReadonlyArray<LogEntry>;
}
