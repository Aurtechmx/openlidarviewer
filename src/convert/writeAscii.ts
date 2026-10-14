/**
 * writeAscii.ts — XYZ and ASC text writers for the converter.
 *
 * Both write global coordinates one point per line. XYZ stays
 * round-trippable with the existing `loadXyz` reader (3 or 6 columns: x y z
 * and optional r g b). ASC writes x y z plus intensity when present, with a
 * short comment header that records the CRS so the georeference travels with
 * the file even though ASCII has no formal CRS slot.
 *
 * Pure data — no DOM.
 */

import type { GlobalPoints } from './globalPoints';
import { ATTR_COLOUR_INVALID, ATTR_INTENSITY_INVALID } from '../model/PointCloud';
import { singleLine } from '../export/safeText';
import { StringLineSink, Utf8ChunkSink, type LineSink } from '../io/textChunks';

function fmt(v: number, precision: number): string {
  return v.toFixed(precision);
}

/**
 * Decimals for the HORIZONTAL axes. Three is millimetres in a projected CRS and
 * about 110 m in a geographic one, so a reprojected WGS84 export was snapping
 * every point to a lattice roughly 55 m across. Seven decimals is ~1.1 cm at the
 * equator, the survey convention — and the same rule `src/io/exporters.ts` and
 * `src/convert/writeLas.ts` already apply. Z is unaffected: a height is a linear unit even
 * when the horizontal frame is degrees.
 */
function horizontalPrecision(precision: number, geographic?: boolean): number {
  // max, not a swap: a caller asking for MORE decimals must not be reduced.
  return geographic === true ? Math.max(precision, 7) : precision;
}

/**
 * The `# datum-transform:` header comment an APPROXIMATE reproject stamps into
 * an ASCII file, or null when there is nothing to disclose. Mirrors the LAS
 * Text Area Description VLR: a degenerate/identity datum leg is proj4's honest
 * best-effort, but the metres-to-tens-of-metres approximation must ride WITH
 * the coordinates, not stay in the UI report. The caller supplies the full
 * note (e.g. `APPROXIMATE — …`); ASCII text is UTF-8, so its glyphs are kept
 * verbatim (unlike the 7-bit LAS VLR).
 */
function datumTransformComment(note: string | null | undefined): string | null {
  const t = note?.trim();
  return t ? `# datum-transform: ${singleLine(t)}` : null;
}

/** The `# crs:` comment both ASCII writers put in their header. */
export function crsComment(epsg: number | null | undefined, crsName: string | null | undefined): string {
  if (epsg != null) return `# crs: EPSG:${epsg}`;
  if (crsName) return `# crs: ${singleLine(crsName)}`;
  return '# crs: none recorded (coordinates unchanged from the source)';
}

type XyzCrs = { readonly epsg?: number | null; readonly crsName?: string | null };

/** Emit the XYZ file, one line at a time, to `sink`. The single place its rows are formatted. */
function emitXyz(
  sink: LineSink,
  g: GlobalPoints,
  precision: number,
  geographic: boolean | undefined,
  datumNote: string | null | undefined,
  provenance: readonly string[] | null | undefined,
  crs: XyzCrs | undefined,
): void {
  if (crs) {
    sink.line('# OpenLiDARViewer XYZ export');
    sink.line(crsComment(crs.epsg, crs.crsName));
  }
  const note = datumTransformComment(datumNote);
  if (note) sink.line(note);
  for (const l of provenance ?? []) sink.line(`# ${singleLine(l)}`);
  const c = g.colors;
  const h = horizontalPrecision(precision, geographic);
  for (let i = 0; i < g.count; i++) {
    const base = `${fmt(g.x[i], h)} ${fmt(g.y[i], h)} ${fmt(g.z[i], precision)}`;
    if (c) {
      // A colour the source flags invalid is unavailable, not a measured value.
      sink.line(g.attributeInvalid && (g.attributeInvalid[i] & ATTR_COLOUR_INVALID) !== 0
        ? `${base} nan nan nan`
        : `${base} ${c[i * 3]} ${c[i * 3 + 1]} ${c[i * 3 + 2]}`);
    } else {
      sink.line(base);
    }
  }
}

/**
 * Write space-delimited `x y z` (+ `r g b` when the cloud has colour). A
 * non-empty `datumNote` prepends a `# datum-transform:` comment; `loadXyz`
 * skips `#` lines, so the note never corrupts the point list. When `crs` is
 * given, a product line and a `# crs:` line open the file. Every line, the
 * last included, ends in a newline; nothing written is an empty string.
 */
export function writeXyz(
  g: GlobalPoints,
  precision = 3,
  geographic?: boolean,
  datumNote?: string | null,
  provenance?: readonly string[] | null,
  crs?: XyzCrs,
): string {
  const sink = new StringLineSink();
  emitXyz(sink, g, precision, geographic, datumNote, provenance, crs);
  return sink.text();
}

/** {@link writeXyz} as UTF-8 byte chunks, so a large cloud never builds one huge string. */
export function writeXyzBytes(
  g: GlobalPoints,
  precision = 3,
  geographic?: boolean,
  datumNote?: string | null,
  provenance?: readonly string[] | null,
  crs?: XyzCrs,
  chunkChars?: number,
): Uint8Array {
  const sink = new Utf8ChunkSink(chunkChars);
  emitXyz(sink, g, precision, geographic, datumNote, provenance, crs);
  return sink.bytes();
}

export interface AscOptions {
  precision?: number;
  crsName?: string | null;
  epsg?: number | null;
  /** True when the output frame is geographic (lon/lat degrees). */
  geographic?: boolean;
  /**
   * Full APPROXIMATE-datum note (e.g. `APPROXIMATE — …`) for a reproject whose
   * datum leg is only best-effort. Emitted as a `# datum-transform:` comment
   * beside the `# crs:` line; absent/empty ⇒ no line (the exact path stays
   * byte-clean).
   */
  datumNote?: string | null;
  /** Provenance lines (software, source file and SHA-256, CRS origin, point basis, class edits), each written as a `#` comment. */
  provenance?: readonly string[] | null;
}

/** Emit the ASC file, one line at a time, to `sink`. The single place its rows are formatted. */
function emitAsc(sink: LineSink, g: GlobalPoints, opts: AscOptions): void {
  const precision = opts.precision ?? 3;
  const h = horizontalPrecision(precision, opts.geographic);
  const hasI = g.intensity != null;
  sink.line('# OpenLiDARViewer ASC export');
  sink.line(crsComment(opts.epsg, opts.crsName));
  const datumComment = datumTransformComment(opts.datumNote);
  if (datumComment) sink.line(datumComment);
  for (const l of opts.provenance ?? []) sink.line(`# ${singleLine(l)}`);
  sink.line(`# columns: x y z${hasI ? ' intensity' : ''}`);

  const it = g.intensity;
  for (let i = 0; i < g.count; i++) {
    const base = `${fmt(g.x[i], h)} ${fmt(g.y[i], h)} ${fmt(g.z[i], precision)}`;
    sink.line(it ? `${base} ${g.attributeInvalid && (g.attributeInvalid[i] & ATTR_INTENSITY_INVALID) !== 0 ? 'nan' : it[i]}` : base);
  }
}

/**
 * Write ASC: a `# crs:` / `# columns:` comment header, then `x y z`
 * (+ `intensity` when present). The header lets a reader recover the CRS that
 * ASCII otherwise can't carry.
 */
export function writeAsc(g: GlobalPoints, opts: AscOptions = {}): string {
  const sink = new StringLineSink();
  emitAsc(sink, g, opts);
  return sink.text();
}

/** {@link writeAsc} as UTF-8 byte chunks, so a large cloud never builds one huge string. */
export function writeAscBytes(g: GlobalPoints, opts: AscOptions = {}, chunkChars?: number): Uint8Array {
  const sink = new Utf8ChunkSink(chunkChars);
  emitAsc(sink, g, opts);
  return sink.bytes();
}
