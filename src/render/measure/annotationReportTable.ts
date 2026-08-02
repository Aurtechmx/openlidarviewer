/**
 * annotationReportTable.ts
 *
 * The content model for the annotation table that the map-drawing PDFs
 * (mapSheet, space, terrain) print. Pure: no pdf-lib, no DOM. One model so the
 * three reports cannot drift apart — the same class of defect that let the EPT
 * path lose its tool dock, restated for report layout.
 *
 * What it decides is CONTENT, not layout. Every annotation becomes a row, in
 * order; the caller's drawing code decides where the rows go (a corner block, a
 * right column, a continuation page) and never whether an annotation appears.
 *
 * The honesty rules live here, and tests/annotationReportTable.test.ts pins
 * them:
 *   - complete: rows.length === annotations.length, always.
 *   - the note is summarised to a cap and a cut is flagged, never silent.
 *   - no coordinate is emitted: `position` is local render-space and printing
 *     it on a client deliverable claims a surveyed location it does not have.
 *   - the header states the count.
 */
import type { Annotation, AnnotationType } from '../annotate/types';

/** One printable row: a description, never a position. */
export interface AnnotationReportRow {
  /** 1-based, matches the reading order of the list. */
  readonly index: number;
  readonly type: AnnotationType;
  readonly title: string;
  /** Summarised note; empty when the annotation carries none. */
  readonly note: string;
  /** True when the note was cut to fit; the row shows an ellipsis. */
  readonly noteTruncated: boolean;
}

export interface AnnotationReport {
  /** e.g. "Annotations (4)" — the count so a summary cannot read as complete. */
  readonly header: string;
  readonly rows: readonly AnnotationReportRow[];
}

export interface AnnotationReportOptions {
  /**
   * Longest note printed before it is cut and flagged. A table cell cannot hold
   * a paragraph; the full text lives in the session export, which the sheet
   * points to. Default 120.
   */
  readonly maxNoteChars?: number;
}

const DEFAULT_MAX_NOTE = 120;

function summariseNote(raw: string | undefined, max: number): { note: string; noteTruncated: boolean } {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length <= max) return { note: trimmed, noteTruncated: false };
  // Cut to `max` and mark it. The ellipsis is the visible signal that there is
  // more, so a reader is never left thinking the printed text is the whole note.
  return { note: `${trimmed.slice(0, max)}…`, noteTruncated: true };
}

export function buildAnnotationReport(
  annotations: readonly Annotation[],
  options: AnnotationReportOptions,
): AnnotationReport {
  const max = options.maxNoteChars ?? DEFAULT_MAX_NOTE;
  const rows = annotations.map((a, i) => {
    const { note, noteTruncated } = summariseNote(a.note, max);
    return {
      index: i + 1,
      type: a.type,
      title: a.title.trim(),
      note,
      noteTruncated,
    } satisfies AnnotationReportRow;
  });
  return { header: `Annotations (${annotations.length})`, rows };
}
