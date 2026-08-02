/**
 * The annotation table printed on a map-drawing PDF makes a claim to whoever
 * reads the sheet, so the model that builds it carries the honesty rules and
 * this file pins them:
 *
 *  - COMPLETE means every annotation appears. Not every field — every row. A
 *    surveyor deliverable that silently omitted an annotation would be the
 *    selective-reporting failure the whole app avoids, so `rows.length` must
 *    always equal the annotation count.
 *  - The note is the one unbounded field. It is summarised to a cap, and when
 *    it is cut the row says so (`noteTruncated`), because a silent trim drops
 *    information the reader cannot tell is missing.
 *  - No coordinate is emitted. `Annotation.position` is local render-space, and
 *    printing it on a client deliverable would claim a surveyed location it does
 *    not have. The map shows where; the table describes what.
 *  - The header states the count, so a summarised table cannot be mistaken for
 *    a claim that nothing is hidden.
 */
import { describe, it, expect } from 'vitest';
import type { Annotation } from '../src/render/annotate/types';
import { buildAnnotationReport } from '../src/render/measure/annotationReportTable';

const ann = (over: Partial<Annotation>): Annotation => ({
  id: over.id ?? 'a',
  title: over.title ?? 'Title',
  note: over.note,
  type: over.type ?? 'note',
  createdAt: 0,
  updatedAt: 0,
  localPosition: over.localPosition ?? { x: 0, y: 0, z: 0 },
  ...over,
}) as Annotation;

describe('buildAnnotationReport', () => {
  it('emits one row per annotation, in order — nothing dropped', () => {
    const list = [ann({ id: '1', title: 'A' }), ann({ id: '2', title: 'B' }), ann({ id: '3', title: 'C' })];
    const report = buildAnnotationReport(list, {});
    expect(report.rows).toHaveLength(3);
    expect(report.rows.map((r) => r.title)).toEqual(['A', 'B', 'C']);
    expect(report.rows.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it('states the total count in the header', () => {
    expect(buildAnnotationReport([ann({}), ann({})], {}).header).toBe('Annotations (2)');
    expect(buildAnnotationReport([], {}).header).toBe('Annotations (0)');
  });

  it('summarises a long note and flags the cut', () => {
    const long = 'x'.repeat(300);
    const report = buildAnnotationReport([ann({ note: long })], { maxNoteChars: 40 });
    const row = report.rows[0]!;
    expect(row.noteTruncated).toBe(true);
    expect(row.note.length).toBeLessThanOrEqual(41); // cap + ellipsis
    expect(row.note.endsWith('…')).toBe(true);
  });

  it('does not flag a note that fits', () => {
    const report = buildAnnotationReport([ann({ note: 'short' })], { maxNoteChars: 40 });
    expect(report.rows[0]!.noteTruncated).toBe(false);
    expect(report.rows[0]!.note).toBe('short');
  });

  it('carries a missing note as an empty string, still a complete row', () => {
    const report = buildAnnotationReport([ann({ note: undefined })], {});
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.note).toBe('');
    expect(report.rows[0]!.noteTruncated).toBe(false);
  });

  it('never emits a coordinate or position field on a row', () => {
    const report = buildAnnotationReport([ann({ localPosition: { x: 517084, y: 4645003, z: 58 } })], {});
    const keys = Object.keys(report.rows[0]!);
    expect(keys).not.toContain('localPosition');
    expect(keys).not.toContain('position');
    expect(keys).not.toContain('x');
    expect(keys).not.toContain('easting');
    // and no row value stringifies the coordinate
    expect(JSON.stringify(report.rows[0])).not.toContain('517084');
  });

  it('carries the type so the row says what kind of thing it marks', () => {
    const report = buildAnnotationReport([ann({ type: 'warning' })], {});
    expect(report.rows[0]!.type).toBe('warning');
  });

  it('trims whitespace in title and note so blank-looking values do not masquerade as content', () => {
    const report = buildAnnotationReport([ann({ title: '  A  ', note: '  n  ' })], {});
    expect(report.rows[0]!.title).toBe('A');
    expect(report.rows[0]!.note).toBe('n');
  });
});
