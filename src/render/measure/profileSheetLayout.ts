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

// ─────────────────────────────────────────────────────────────────────────────
// The maximum-grade callout
// ─────────────────────────────────────────────────────────────────────────────

/** A point in page coordinates (y up). */
export interface SheetPoint {
  readonly x: number;
  readonly y: number;
}

/** The plot frame in page coordinates (y up). */
export interface SheetFrame {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface CalloutPlacementRequest {
  /** The steepest pair's midpoint. */
  readonly point: SheetPoint;
  /** The widest text line, and the height of the stacked lines, in points. */
  readonly labelW: number;
  readonly labelH: number;
  readonly frame: SheetFrame;
  /** The profile's vertices in page coordinates; null breaks the line at a gap. */
  readonly line: ReadonlyArray<SheetPoint | null>;
}

/** Where the callout's shoulder and label sit. */
export interface CalloutPlacement {
  /** +1 puts the label to the right of the point, -1 to the left. */
  readonly sx: 1 | -1;
  /** +1 puts the shoulder above the point, -1 below it. */
  readonly sy: 1 | -1;
  readonly elbowX: number;
  readonly elbowY: number;
  /** Left edge of the label text. */
  readonly textX: number;
  /** The label's bounding box. */
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** True when the box lies inside the frame and clear of the profile line. */
  readonly clear: boolean;
}

/** Air kept between the label box and the frame, and between it and the line. */
const CALLOUT_FRAME_MARGIN = 4;
const CALLOUT_LINE_MARGIN = 3;

/** Whether the polyline passes through `box` grown by `pad`. */
export function lineCrossesBox(
  line: ReadonlyArray<SheetPoint | null>,
  box: { x0: number; y0: number; x1: number; y1: number },
  pad: number,
): boolean {
  const x0 = box.x0 - pad;
  const x1 = box.x1 + pad;
  const y0 = box.y0 - pad;
  const y1 = box.y1 + pad;
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  for (let i = 0; i < line.length; i++) {
    const a = line[i];
    if (a == null) continue;
    if (inside(a.x, a.y)) return true;
    const b = line[i + 1];
    if (b == null) continue;
    // Sampled at a pitch below the box margin, so a steep segment cannot step
    // over a box edge between two samples.
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (inside(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return true;
    }
  }
  return false;
}

/**
 * Choose where the maximum-grade label goes.
 *
 * The point of the callout sits on the profile line by construction, and the
 * steepest place on a section is usually also its highest or lowest, so the
 * label has to be placed rather than assumed: a label set up and to the right
 * of the point is crossed by the line whenever the section keeps climbing
 * that way. Candidates are tried nearest first, on the preferred side first,
 * and the first whose box is inside the frame and clear of the line wins.
 * When none is clear the nearest one inside the frame is used and `clear` is
 * false, so the failure is visible to a test rather than silently drawn over.
 */
export function placeCalloutLabel(req: CalloutPlacementRequest): CalloutPlacement {
  const { point, labelW, labelH, frame, line } = req;
  const m = CALLOUT_FRAME_MARGIN;
  const build = (sx: 1 | -1, sy: 1 | -1, dx: number, dy: number): CalloutPlacement => {
    const elbowX = point.x + sx * dx;
    const elbowY = point.y + sy * dy;
    const textX = sx > 0 ? elbowX + 4 : elbowX - labelW - 4;
    const box = { x0: textX, y0: elbowY + 2, x1: textX + labelW, y1: elbowY + 2 + labelH };
    const inFrame =
      box.x0 >= frame.left + m && box.x1 <= frame.right - m &&
      box.y0 >= frame.bottom + m && box.y1 <= frame.top - m;
    return {
      sx, sy, elbowX, elbowY, textX, box,
      clear: inFrame && !lineCrossesBox(line, box, CALLOUT_LINE_MARGIN),
    };
  };
  const roomRight = point.x + 32 + labelW + 8 <= frame.right;
  const upFirst = point.y + 46 <= frame.top;
  // Every offset on a grid, nearest first, with a small penalty for the side
  // that is not preferred. A line that climbs through the usual spots leaves a
  // clear region only some distance off, which a handful of fixed offsets can
  // miss.
  const candidates: Array<{ sx: 1 | -1; sy: 1 | -1; dx: number; dy: number; cost: number }> = [];
  for (const sx of [1, -1] as const) {
    for (const sy of [1, -1] as const) {
      const penalty = (sx > 0 === roomRight ? 0 : 24) + (sy > 0 === upFirst ? 0 : 12);
      for (let dx = 32; dx <= 360; dx += 12) {
        for (let dy = 20; dy <= 220; dy += 8) {
          candidates.push({ sx, sy, dx, dy, cost: Math.hypot(dx, dy) + penalty });
        }
      }
    }
  }
  candidates.sort((p, q) => p.cost - q.cost);
  let firstInFrame: CalloutPlacement | null = null;
  for (const c of candidates) {
    const placed = build(c.sx, c.sy, c.dx, c.dy);
    if (placed.clear) return placed;
    if (firstInFrame == null && !boxOutsideFrame(placed, frame)) firstInFrame = placed;
  }
  return firstInFrame ?? build(roomRight ? 1 : -1, upFirst ? 1 : -1, 32, 34);
}

/** True when the placement's box is outside the frame (so it cannot be a fallback). */
function boxOutsideFrame(c: CalloutPlacement, frame: SheetFrame): boolean {
  const m = CALLOUT_FRAME_MARGIN;
  return !(
    c.box.x0 >= frame.left + m && c.box.x1 <= frame.right - m &&
    c.box.y0 >= frame.bottom + m && c.box.y1 <= frame.top - m
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet wording that is computed rather than written
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CRS string with its code stated once. A resolved frame arrives as
 * "EPSG:26913 - NAD83 / UTM zone 13N (EPSG:26913)" when the CRS name already
 * carries its code; the label is the name followed by the code, once:
 * "NAD83 / UTM zone 13N (EPSG:26913)". Anything not in that shape is kept.
 */
export function crsDisplayLabel(crs: string | null | undefined): string | null {
  if (crs == null || crs.trim() === '') return null;
  const m = /^\s*(EPSG:\d+)\s*[-–—]\s*(.+?)\s*$/.exec(crs);
  if (!m) return crs.trim();
  const code = m[1];
  const name = m[2];
  return name.includes(code) ? name : `${name} (${code})`;
}

/**
 * The scale statement's vertical clause. Below 1 the vertical scale is the
 * smaller drawing, so the relief is drawn flatter than the run: a compression,
 * said with its consequence, and never under the word exaggeration.
 */
export function verticalScaleStatement(vex: number): string {
  return Math.round(vex * 10) / 10 < 1
    ? `Vertical compression ${vex.toFixed(1)}:1, slopes look flatter than they are`
    : `Vertical exaggeration ${vex.toFixed(1)}:1`;
}

/** A title-block value fitted into its 30 pt row: the lines, their size and baselines below the row top. */
export interface FittedValue {
  readonly lines: readonly string[];
  readonly size: number;
  readonly first: number;
  readonly step: number;
}

/**
 * Fit a value that must never be cut. One line, shrunk from `maxSize` down to
 * `minSize`; then two lines at `minSize`; then three at 6.5 pt. The baselines
 * stay inside the row, clear of the label above and the rule below, and a last
 * line that still does not fit is clipped with a mark rather than dropped.
 */
export function fitTitleValue(
  value: string,
  maxW: number,
  maxSize: number,
  minSize: number,
  text: {
    width: (t: string, size: number) => number;
    wrap: (t: string, size: number) => string[];
    clip: (t: string, size: number) => string;
  },
): FittedValue {
  let size = maxSize;
  while (size > minSize && text.width(value, size) > maxW) size -= 0.5;
  if (text.width(value, size) <= maxW) return { lines: [value], size, first: 25, step: 0 };
  let lines = text.wrap(value, minSize);
  if (lines.length <= 2) return { lines, size: minSize, first: 19.5, step: 7.5 };
  lines = text.wrap(value, 6.5);
  if (lines.length > 3) lines = [...lines.slice(0, 2), text.clip(lines.slice(2).join(' '), 6.5)];
  return { lines, size: 6.5, first: 18, step: 5.2 };
}
