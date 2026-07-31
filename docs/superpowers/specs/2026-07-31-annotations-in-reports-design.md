# Annotations in reports

Annotations reach a session file and a KML export. They do not reach any of the
four PDF reports, and they do not reach the integrity report. A user places a marker, exports a terrain report, and the marker is not in it.

This design puts them in every report, as markers on the sheet and as a table,
and answers the question that decides whether a marker is honest.

## The constraint that shapes everything

`Annotation.position` is in local render-space, not CRS coordinates
(`src/render/annotate/types.ts:54`). A table can always print those numbers,
because they are exactly what they are once the frame is named.

A marker drawn on a map sheet cannot. It asserts a place, and a place needs a
transform.

`src/export/kmlExport.ts` already solved this. It takes an injected `toLonLat`
and its header records that the caller only offers KML "when the scan has a
known georeference". The transform is supplied from outside, and the decision
about whether one exists is made upstream.

This design follows that precedent rather than inventing a second one.

So:

- Table: always. Every report that carries annotations carries all of them.
- Markers: only where a real frame exists. No frame, no marker, and the sheet
  says so in the space where the markers would have been.

A scanner-local E57 with no declared CRS gets the full table in its own frame
and a stated reason for the absent markers. It does not get a pin placed from
an arbitrary origin. That is the same discipline as `blocked-external` in the
study vocabulary and `evidenceNote` in the exporters: record the boundary
instead of covering it.

## One contract, not four bolt-ons

The four PDF writers share nothing but a `pdf-lib` import. Adding annotations to
each one separately is how "also do E57" becomes a fourth job. It is also how
the COPC and EPT paths drifted apart earlier, costing a shipped defect.

`src/render/measure/annotationReportModel.ts`. Pure: no `pdf-lib`, no DOM.

```
buildAnnotationReport(
  annotations: readonly Annotation[],
  place: ((p: LocalPoint) => SheetPoint | null) | null,
): AnnotationReport
```

Returns:

- `rows`, one per annotation: index, title, note, type, position, and the
  linked measurement when there is one. Always populated.
- `frameLabel`, what the position columns mean: `"EPSG:32629"` or
  `"scan local frame"`. Never absent, never guessed.
- `marks`, sheet coordinates, present only when `place` was supplied and
  returned a point. An annotation outside the sheet extent yields no mark and
  is flagged on its row rather than clamped to an edge.
- `omittedReason`, the sentence a report prints when `marks` is empty and
  annotations exist.

The caller decides whether a transform exists. The model decides nothing about
honesty; it only refuses to invent.

## Layout

Gestalt, applied to the sheet rather than the app.

Common region. The table is a bounded section with its own rule and its own
caption, not more report body. A reader scanning for annotations should find a
block, not a paragraph.

Figure and ground. A marker over contour lines competes with them. Each
marker is a filled disc with a light halo in the sheet background colour, so a
dark pin on a dark line stays readable. Numbered, matching the on-screen
markers, so the sheet and the viewer agree.

Proximity and similarity in the panel. The new PDF button sits in the same
action row as "Clear all", because they act on the same set. They must not look
alike. "Clear all" destroys work and PDF does not, so: same size and shape,
different treatment. Two identical buttons side by side would say the actions
are equivalent, and one of them is not.

Continuity. Position columns are right-aligned and tabular-figure, so digits
line up down the column and a misplaced decimal is visible.

Typography is unchanged. The reports use `StandardFonts` and they read well;
this design adds a section to them, not a redesign of them.

## Where each report puts it

- `terrainReportPdf`: markers on the contour plan, table after the metrics.
- `mapSheetPdf`: markers in the map frame, table on the sheet margin, or a
  continuation page when the count exceeds the margin.
- `spaceReportPdf`: markers on the floor plan, table after the space metrics.
- `profilePdf`: annotations within the corridor only, as station offsets rather
  than plan positions. The sheet is a section; a plan position has no place
  on it.

## Testing

- The model with no transform yields every row and no marks.
- The model with a transform yields both, and an out-of-extent annotation is
  flagged rather than clamped.
- A report rendered with annotations and no frame contains the omission
  sentence. This is the assertion that keeps the honesty property from being
  quietly dropped.
- Row count equals annotation count in every report, so none can silently
  truncate.
- Assertions strip comments before matching source, per the false-green caught
  in `tests/measurePanelExpandAffordance.test.ts`.

## Not in this change

Session saving and the panel collapse toggles are the same panel and a
different problem. They get their own section once this lands.
