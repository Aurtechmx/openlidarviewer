/**
 * types.ts — shared contracts for the point-cloud format converter.
 *
 * Pure data: no DOM, no three.js, no I/O. The converter reuses the existing
 * loaders (`parseBuffer`) to read a file into a `PointCloud`, applies an
 * optional CRS step (assign or reproject), then writes one of the supported
 * output formats. Everything here is deterministic and unit-testable.
 */

import type { TransformProvenance } from './transformProvenance';
import type { CrsInfo } from '../io/crs';
import type { ResolvedCrs } from '../geo/CoordinateTypes';

/** Output formats the converter can write. */
export type ConvertFormat = 'las14' | 'las' | 'laz' | 'xyz' | 'asc';

/** Human-readable labels + file extensions for each output format. */
export const CONVERT_FORMATS: Record<
  ConvertFormat,
  { label: string; ext: string; binary: boolean; available: boolean }
> = {
  // LAS 1.4 (point formats 6/7) leads because it is the converter's default:
  // modern consumers all read 1.4 and the extended records keep the full
  // 8-bit classification. LAS 1.2 stays as an explicit legacy-tool choice —
  // its 5-bit classification field clamps classes above 31.
  las14: { label: 'LAS 1.4', ext: 'las', binary: true, available: true },
  las: { label: 'LAS 1.2', ext: 'las', binary: true, available: true },
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
   * Source EPSG. Used for `reproject` when there is no resolved or detected CRS
   * (a genuinely code-less scan the user tags by hand). Ignored for `keep`.
   */
  readonly sourceEpsg?: number | null;
  /**
   * The RESOLVED source CRS from the CRS authority (CrsService), honouring any
   * user override. When provided it is authoritative: `cloud.metadata.crs` is
   * treated as source-declared provenance only and is NOT consulted for the
   * conversion's source CRS, so a rejected or local override can never resurrect
   * the file's declared CRS into the output or a reprojection (blocker #2D).
   * `undefined` = no resolver in play (the pure convert path), which falls back
   * to the detected metadata. A resolved value with a null `epsg` is a local /
   * code-less frame — honoured as "no CRS", never back-filled from metadata.
   * Carries the full resolved CRS (epsg, WKT, horizontal + vertical units and
   * datum, name), so the output's CRS record, `.prj` WKT and unit metadata all
   * describe the resolved CRS rather than mixing a resolved EPSG with the
   * declared WKT/units (blocker 2).
   */
  readonly resolvedSourceCrs?: CrsInfo | ResolvedCrs | null;
  /** Target EPSG for `assign` (the tag to write) and `reproject` (the destination). */
  readonly targetEpsg?: number | null;
  /**
   * ASCII precision (decimal places) for XYZ / ASC. Defaults to 3 (mm).
   */
  readonly asciiPrecision?: number;
  /**
   * When true, the classification channel is omitted from the output (written
   * as class 0). The honesty guard for a derived/heuristic classification the
   * user does not want to ship as if it were authoritative.
   */
  readonly omitClassification?: boolean;
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
  /**
   * Machine-readable provenance of the coordinate transform, present only in
   * `reproject` mode (the sole mode that runs `reprojectGlobal`) and on every
   * reproject outcome — applied, approximate, or skipped. It carries the
   * transform's accuracy (`accuracyMetres`), datum families, and source epoch.
   * Previously the reproject path discarded this; keeping it lets a consumer
   * read the transform's honest accuracy without parsing the log prose, and
   * complements the caveat now embedded in the deliverable itself.
   */
  readonly provenance?: TransformProvenance | null;
}
