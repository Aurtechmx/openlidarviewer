/**
 * svgSheetLayout.ts: the page size of a contour SVG sheet. The map keeps its
 * own scale; a frame or page too narrow for the north arrow, the legend, the
 * scale bar and the title is widened around it. A sheet with room keeps the
 * size and positions it always had.
 *
 * Text is measured by a character-count upper bound, because the sheet is built
 * without a font engine and the viewer may substitute any sans-serif.
 */

/** Smallest map frame, px: room for the north arrow beside the data. */
export const MIN_FRAME_W = 140;
export const MIN_FRAME_H = 72;
/** Widest a 10 px sans-serif character is taken to be, on average over a line, px. */
const CHAR_W = 6.2;
/** Clear space between the legend and the title block, px. */
const GAP = 24;
/** Where a legend label starts, right of its swatch, px. */
const LEGEND_TEXT_X = 42;
/** The scale bar is at least this long, px, so its three ticks stay apart. */
const MIN_BAR_PX = 60;

const textW = (lines: readonly string[]): number => lines.reduce((w, l) => Math.max(w, l.length * CHAR_W), 0);

export interface SvgSheetLayout {
  readonly frameW: number;
  readonly frameH: number;
  /** Left edge of the frame, centred when the page is wider than it. */
  readonly frameX: number;
  /** Data offset inside the frame, when the frame is larger than the data needs. */
  readonly padX: number;
  readonly padY: number;
  /** Page width. */
  readonly pageW: number;
  /** The title block goes under the legend, left aligned, instead of beside it. */
  readonly stacked: boolean;
}

/** Lay out a sheet whose map (with any padding) is `mapW` by `mapH` px. */
export function svgSheetLayout(p: {
  readonly mapW: number;
  readonly mapH: number;
  readonly margin: number;
  readonly legend: readonly string[];
  readonly title: readonly string[];
}): SvgSheetLayout {
  const frameW = Math.max(p.mapW, MIN_FRAME_W);
  const frameH = Math.max(p.mapH, MIN_FRAME_H);
  const legendW = LEGEND_TEXT_X + textW(p.legend);
  const titleW = textW(p.title);
  const stacked = frameW < legendW + GAP + titleW;
  // The bar is at most 2.5 times its shortest length, plus half of its end label.
  const inner = stacked ? Math.max(frameW, legendW, titleW, MIN_BAR_PX * 2.5 + 40) : frameW;
  return {
    frameW, frameH,
    frameX: p.margin + (inner - frameW) / 2,
    padX: (frameW - p.mapW) / 2,
    padY: (frameH - p.mapH) / 2,
    pageW: inner + p.margin * 2,
    stacked,
  };
}

/**
 * The ground distance a scale bar spans: `quarter` (a quarter of the map,
 * rounded down), or, when that is too short to label, the next 1, 2 or 5 step
 * that is long enough.
 */
export function scaleBarSpan(quarter: number, scale: number): number {
  if (!(scale > 0) || quarter * scale >= MIN_BAR_PX) return quarter;
  const need = MIN_BAR_PX / scale;
  const pow = 10 ** Math.floor(Math.log10(need));
  const n = need / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
