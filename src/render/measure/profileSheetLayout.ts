/**
 * profileSheetLayout.ts
 *
 * Where things sit on the printed profile sheet. Pure arithmetic over text
 * widths and the plot's own x mapping: no pdf-lib, no page, no drawing. The
 * builder in `profilePdf.ts` draws what this module resolves, which is what
 * lets a test assert the geometry of the sheet without reading back a PDF.
 *
 * Two layout problems live here, and both are the same problem: text has a
 * width, and a layout that assumes a width instead of measuring one puts two
 * strings in the same place.
 *
 * THE STATION DATA BAND (the civil "guitarra") is the ruled block under the
 * section carrying, per station, the distance from the previous station, the
 * running chainage, and the height there. Its columns must land on the same x
 * the section's polyline was drawn at, so a reader can drop a vertical from
 * the curve to the figures. That is why the band takes the plot's mapping as
 * an argument rather than deriving a second one: two derivations of one
 * mapping are two chances to disagree.
 *
 * Stations are usually far denser than the band has room for, so the columns
 * are thinned by `fitAxisLabels` — the same fitter the on-screen axis uses,
 * which walks the strip and keeps a column only when the space it needs is
 * still free. The layout reports how many of how many survived so the sheet
 * can say so: a band that silently shows one station in nine looks like a
 * band that shows every station.
 *
 * THE SUMMARY VALUE COLUMN is placed at the widest label actually present
 * rather than at a fixed offset. A fixed offset is a guess about the widest
 * heading, and the headings are not fixed text: a height heading is whatever
 * `heightLabel` returns for the scan's vertical reference, and "Height (datum
 * unknown) min / max" is far wider than a heading written for a declared
 * datum. When the guess is wrong the value is drawn over the label and the
 * sheet states neither.
 */

import { fitAxisLabels } from './profileAxes';

/** Measures a string at the size it will be drawn, in points. */
export type MeasureText = (text: string) => number;

/** One station column of the data band. */
export interface StationBandColumn {
  /** Chainage of the station, metres (the sheet's own unit conversion is later). */
  readonly chainage: number;
  /** Page x of the column centre, points. Comes from the plot's mapping. */
  readonly x: number;
  /** Height at the station, metres. null at a gap. */
  readonly height: number | null;
  /**
   * Distance from the PREVIOUS SHOWN column, metres; null for the first.
   *
   * From the previous shown column and not the previous sample, because the
   * partial distances of a band must sum to the chainage printed beside them.
   * A partial measured to a station the band does not draw is a number the
   * reader cannot check against anything else on the sheet.
   */
  readonly partial: number | null;
}

/** The resolved band: which stations it draws, and how many it dropped. */
export interface StationBandLayout {
  readonly columns: readonly StationBandColumn[];
  /** Stations drawn. */
  readonly shown: number;
  /** Stations offered. `shown < total` means the band was thinned. */
  readonly total: number;
}

/** A station as the band needs it: where it is, and what it reads. */
export interface StationBandInput {
  readonly chainage: number;
  readonly height: number | null;
}

export interface StationBandRequest {
  readonly stations: readonly StationBandInput[];
  /** The plot's own chainage → page x mapping. Not re-derived here. */
  readonly mapX: (chainage: number) => number;
  /** Left edge of the plot area, points. */
  readonly plotLeft: number;
  /** Width of the plot area, points. */
  readonly plotW: number;
  /** Widest text the column will hold, per station, at its drawn size. */
  readonly widest: (station: StationBandInput) => string;
  /** Measures that text. */
  readonly measure: MeasureText;
  /** Font size the band cells are drawn at, points. */
  readonly fontSize: number;
}

/**
 * Resolve the band's columns against the plot's mapping.
 *
 * Stations with a non-finite chainage are dropped before the fit rather than
 * carried into it: a column at NaN has no place on the strip, and the fitter's
 * ordering would put it nowhere in particular.
 */
export function buildStationBand(req: StationBandRequest): StationBandLayout {
  const usable = req.stations.filter((s) => Number.isFinite(s.chainage));
  const total = usable.length;
  if (total === 0) return { columns: [], shown: 0, total: 0 };

  const pixels = usable.map((s) => req.mapX(s.chainage) - req.plotLeft);
  const labels = usable.map((s) => req.widest(s));
  // The fitter is given the strip in plot-local coordinates, which is the
  // frame `pixels` is already in. Ends are centred: a band column is drawn
  // centred on its tick, so an end column that would hang past the frame is
  // dropped rather than printed half outside the ruling.
  const keep = fitAxisLabels({
    labels,
    pixels,
    containerPx: req.plotW,
    fontPx: req.fontSize,
    extentPx: (label) => req.measure(label),
    ends: 'centred',
  });

  const columns: StationBandColumn[] = [];
  let previous: number | null = null;
  for (let i = 0; i < usable.length; i++) {
    if (!keep[i]) continue;
    const s = usable[i];
    columns.push({
      chainage: s.chainage,
      x: req.mapX(s.chainage),
      height: s.height,
      partial: previous == null ? null : s.chainage - previous,
    });
    previous = s.chainage;
  }
  return { columns, shown: columns.length, total };
}

/** A label/value pair as the summary block holds it. */
export interface SummaryRow {
  readonly label: string;
  readonly value: string;
}

export interface SummaryLayoutRequest {
  readonly rows: readonly SummaryRow[];
  /** Measures a label at the size and weight labels are drawn at. */
  readonly measureLabel: MeasureText;
  /** Measures a value at the size and weight values are drawn at. */
  readonly measureValue: MeasureText;
  /** Width of one half-width cell, points. */
  readonly cellW: number;
  /** Width of the full-width group, points. */
  readonly wideW: number;
  /** Clear space between a label and its value, points. */
  readonly gap: number;
}

export interface SummaryLayout {
  /** Rows that fit a half-width cell, in the input order. */
  readonly pairs: readonly SummaryRow[];
  /** Rows that did not, moved to the full-width group, in the input order. */
  readonly promoted: readonly SummaryRow[];
  /** Value x, as an offset from the cell's left edge. Shared by both columns. */
  readonly valueDx: number;
}

/**
 * Place the summary's value column, and move out the rows that cannot fit.
 *
 * The offset is one number for the whole block rather than per row, because
 * values that start at different x read as a ragged list rather than as a
 * column, and the block is scanned down its values.
 *
 * A row whose label and value together exceed the half-width cell is moved to
 * the full-width group rather than shortened. The alternatives were considered
 * and are worse here: shortening the label loses the qualification the label
 * exists to carry (`Height (datum unknown)` is not `Height`), and wrapping a
 * value inside a two-column grid pushes every later row down by a variable
 * amount, so the two columns stop sharing a baseline. The full-width group
 * already exists on this sheet for statements too long for a cell, so an
 * over-wide row joins the rows it belongs with.
 *
 * Removing a row can narrow the widest remaining label, which can let a row
 * that was over by a few points fit after all, so the fit is iterated to a
 * fixed point. The loop is bounded by the row count: each pass either removes
 * at least one row or stops.
 */
export function layoutSummaryRows(req: SummaryLayoutRequest): SummaryLayout {
  const gap = Math.max(0, req.gap);
  let kept = req.rows.slice();
  let valueDx = 0;
  for (let pass = 0; pass <= req.rows.length; pass++) {
    valueDx = 0;
    for (const r of kept) valueDx = Math.max(valueDx, req.measureLabel(r.label) + gap);
    const fits = kept.filter((r) => valueDx + req.measureValue(r.value) <= req.cellW);
    if (fits.length === kept.length) break;
    kept = fits;
  }
  // Recompute once more over the surviving set, so the offset is the widest
  // label that is actually drawn in a cell and not the widest one considered.
  valueDx = 0;
  for (const r of kept) valueDx = Math.max(valueDx, req.measureLabel(r.label) + gap);
  const keptSet = new Set(kept);
  const promoted = req.rows.filter((r) => !keptSet.has(r));
  // An empty block still needs a defined column, and a value that overruns
  // even the full-width group is clipped by the caller rather than moved
  // again: there is nowhere wider to move it to.
  return { pairs: kept, promoted, valueDx: Math.min(valueDx, req.cellW) };
}

/**
 * The value offset for the full-width group, measured the same way.
 *
 * Kept separate from the half-width offset on purpose: the two groups are read
 * as two blocks, and forcing the wide group to the cell's offset would either
 * indent it past its own widest label or crowd it against one.
 */
export function wideValueDx(
  rows: readonly SummaryRow[],
  measureLabel: MeasureText,
  gap: number,
  wideW: number,
): number {
  let dx = 0;
  for (const r of rows) dx = Math.max(dx, measureLabel(r.label) + Math.max(0, gap));
  return Math.min(dx, wideW);
}
