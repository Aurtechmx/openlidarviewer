/**
 * profileSheetLayout.ts
 *
 * Where things sit on the printed profile sheet. Pure arithmetic over text
 * widths and the plot's own x mapping: no pdf-lib, no page, no drawing. The
 * builder in `profilePdf.ts` draws what this module resolves, which is what
 * lets a test assert the geometry of the sheet without reading back a PDF.
 *
 * One layout problem lives here: text has a width, and a layout that assumes a
 * width instead of measuring one puts two strings in the same place.
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
 * The sheet's other text blocks are ruled tables with fixed columns, which
 * need no such fitting: a column is placed once and every cell in it is
 * clipped to that width.
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
