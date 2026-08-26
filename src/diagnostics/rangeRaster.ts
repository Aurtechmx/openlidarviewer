/**
 * rangeRaster.ts — an acquisition grid as pixels, without a DOM in sight.
 *
 * The workbench draws a frame's grid to a canvas. Everything that decides WHAT
 * a pixel is lives here, so it runs under Node and is tested there; the canvas
 * adapter above it only copies the bytes this module produces.
 *
 * TWO RULES SHAPE THE WHOLE MODULE.
 *
 * 1. ABSENT IS NOT A VALUE. A cell with no geometric range is painted in a
 *    colour that is not on the ramp at all, so it cannot be read as a short
 *    distance. The ramp's own near end is saturated; the absent swatch is
 *    deliberately desaturated and sits outside the ramp's hue path.
 *
 * 2. A DOWNSCALE MUST NOT COST CELL IDENTITY. A ten-million-cell grid is never
 *    expanded into a full-resolution bitmap on a repaint; the plan picks a
 *    display size no larger than the viewport asked for and samples the source.
 *    {@link sourceCellAt} is the exact inverse of that sampling, so a pointer
 *    over a display pixel names the SOURCE row and column it was drawn from,
 *    and the identity link that follows is about a real cell rather than a
 *    smoothed average of several.
 *
 * The sampling is nearest-cell, not an average, and that is a decision rather
 * than an economy. Averaging five cell states produces a state no cell is in,
 * and averaging a range across a depth discontinuity produces a distance
 * nothing was at. A dropped cell is honest; an invented one is not.
 */

import {
  CELL_STATES,
  CellState,
  cellIndexForRecord,
  cellIndexOf,
  type CellStateValue,
  type OrganizedRangeFrame,
} from '../model/OrganizedRange';

/** The two view modes this release ships. */
export type RangeRasterMode = 'validity' | 'range';

/** An RGB triple, each channel 0-255. */
export type Rgb = readonly [number, number, number];

/**
 * Per-state colours for the validity view.
 *
 * Five hues that also differ in lightness, so the five states stay separable
 * without relying on hue alone. The legend repeats every name in text, which is
 * what actually carries the meaning; the colours only make the pattern on the
 * grid visible.
 */
export const CELL_STATE_RGB: Readonly<Record<CellStateValue, Rgb>> = {
  [CellState.VALID_RETURN]: [86, 176, 132],
  [CellState.NO_RETURN]: [26, 38, 66],
  [CellState.SOURCE_INVALID]: [206, 86, 76],
  [CellState.NOT_DECODED]: [138, 138, 148],
  [CellState.SOURCE_RECORD_MISSING]: [176, 100, 190],
};

/**
 * The colour a cell with no finite geometric range is painted in the range
 * view. Desaturated and off the ramp on purpose: see rule 1 above.
 */
export const RANGE_ABSENT_RGB: Rgb = [72, 74, 82];

/** The near end of the range ramp. */
export const RANGE_NEAR_RGB: Rgb = [40, 62, 148];
/** The far end of the range ramp. */
export const RANGE_FAR_RGB: Rgb = [246, 226, 128];

/**
 * A display size and the source grid it was derived from.
 *
 * Both axes are scaled independently, which keeps the whole grid visible in the
 * box it is given rather than preserving the acquisition aspect ratio. A
 * scanner grid's aspect is a property of the instrument's sampling, not of the
 * scene, so stretching it distorts nothing measurable; cropping it would hide
 * cells, which does.
 */
export interface RasterPlan {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
}

/**
 * Choose a display size for a grid inside a box.
 *
 * Never larger than the source: a 12-column grid in a 400-pixel box draws 12
 * pixels and the adapter scales them up, rather than this module inventing 400
 * columns of duplicate data. Never smaller than one pixel per axis while the
 * source has any extent, so a grid always draws something.
 */
export function planRangeRaster(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): RasterPlan {
  const w = Math.max(0, Math.floor(sourceWidth));
  const h = Math.max(0, Math.floor(sourceHeight));
  if (w === 0 || h === 0) {
    return { sourceWidth: w, sourceHeight: h, displayWidth: 0, displayHeight: 0 };
  }
  const bw = Math.max(1, Math.floor(maxWidth));
  const bh = Math.max(1, Math.floor(maxHeight));
  return {
    sourceWidth: w,
    sourceHeight: h,
    displayWidth: Math.min(w, bw),
    displayHeight: Math.min(h, bh),
  };
}

/**
 * The SOURCE cell a display pixel was drawn from, or null when the pixel is
 * outside the raster.
 *
 * This is the inverse of the sampling {@link rasterizeRangeFrame} performs, and
 * the two must be read together: `column` is derived from the horizontal
 * display coordinate and the source WIDTH, `row` from the vertical coordinate
 * and the source HEIGHT. Swapping the pair produces a mapping that is correct
 * on a square grid and wrong on every other one, which is why the tests use a
 * non-square grid.
 */
export function sourceCellAt(
  plan: RasterPlan,
  displayX: number,
  displayY: number,
): { readonly row: number; readonly column: number } | null {
  const { displayWidth, displayHeight, sourceWidth, sourceHeight } = plan;
  if (displayWidth <= 0 || displayHeight <= 0) return null;
  const dx = Math.floor(displayX);
  const dy = Math.floor(displayY);
  if (dx < 0 || dy < 0 || dx >= displayWidth || dy >= displayHeight) return null;
  const column = Math.min(sourceWidth - 1, Math.floor((dx * sourceWidth) / displayWidth));
  const row = Math.min(sourceHeight - 1, Math.floor((dy * sourceHeight) / displayHeight));
  return { row, column };
}

/** The finite range extent a range view is normalised over. */
export interface RangeDomain {
  readonly min: number;
  readonly max: number;
}

/**
 * The finite geometric-range extent of a frame, or null when it has none.
 *
 * Null rather than a zero-width domain: a frame with no finite range has no
 * extent, and a caller must show no ramp rather than a ramp over nothing.
 */
export function rangeDomainOf(frame: OrganizedRangeFrame): RangeDomain | null {
  const ranges = frame.geometricRange;
  if (!ranges) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < ranges.length; i++) {
    const v = ranges[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : { min, max };
}

/** Linear interpolation between the ramp ends, at `t` clamped to 0..1. */
export function rangeRampRgb(t: number): Rgb {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(RANGE_NEAR_RGB[0] + (RANGE_FAR_RGB[0] - RANGE_NEAR_RGB[0]) * k),
    Math.round(RANGE_NEAR_RGB[1] + (RANGE_FAR_RGB[1] - RANGE_NEAR_RGB[1]) * k),
    Math.round(RANGE_NEAR_RGB[2] + (RANGE_FAR_RGB[2] - RANGE_NEAR_RGB[2]) * k),
  ];
}

/**
 * The colour one cell takes in one mode.
 *
 * The range branch checks finiteness FIRST and answers with the absent swatch,
 * so an absent range can never travel through the ramp arithmetic and come out
 * as the ramp's near end — which is what would make a cell with no return read
 * as a distance of zero.
 */
export function cellRgb(
  frame: OrganizedRangeFrame,
  index: number,
  mode: RangeRasterMode,
  domain: RangeDomain | null,
): Rgb {
  if (mode === 'validity') {
    const state = frame.cellState[index] as CellStateValue;
    return CELL_STATE_RGB[state] ?? CELL_STATE_RGB[CellState.NOT_DECODED];
  }
  const ranges = frame.geometricRange;
  if (!ranges || !domain) return RANGE_ABSENT_RGB;
  const v = ranges[index];
  if (!Number.isFinite(v)) return RANGE_ABSENT_RGB;
  const span = domain.max - domain.min;
  return rangeRampRgb(span <= 0 ? 0 : (v - domain.min) / span);
}

/** A rasterised frame: RGBA bytes at the plan's display size. */
export interface RangeRaster {
  readonly plan: RasterPlan;
  readonly pixels: Uint8ClampedArray;
  /** The domain the range view was normalised over; null in validity mode. */
  readonly domain: RangeDomain | null;
}

/**
 * Rasterise a frame at the plan's display size.
 *
 * Allocation is `displayWidth * displayHeight * 4` and never the source cell
 * count, which is the whole point of the plan: a 10 000 by 1 000 grid drawn
 * into a 600 by 400 box costs 960 KB, not 40 MB, on every repaint.
 */
export function rasterizeRangeFrame(
  frame: OrganizedRangeFrame,
  mode: RangeRasterMode,
  plan: RasterPlan,
  domain: RangeDomain | null = null,
): RangeRaster {
  const { displayWidth: dw, displayHeight: dh } = plan;
  const pixels = new Uint8ClampedArray(Math.max(0, dw * dh * 4));
  const active = mode === 'range' ? (domain ?? rangeDomainOf(frame)) : null;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const cell = sourceCellAt(plan, dx, dy);
      const p = (dy * dw + dx) * 4;
      if (!cell) {
        pixels[p + 3] = 0;
        continue;
      }
      const rgb = cellRgb(frame, cellIndexOf(cell.row, cell.column, frame.width), mode, active);
      pixels[p] = rgb[0];
      pixels[p + 1] = rgb[1];
      pixels[p + 2] = rgb[2];
      pixels[p + 3] = 255;
    }
  }
  return { plan, pixels, domain: active };
}

/**
 * The display pixel a SOURCE cell is drawn at, or null when the cell is outside
 * the grid. The forward direction of {@link sourceCellAt}, used to mark the
 * cell an inspected display record belongs to.
 *
 * A downscale maps many cells onto one pixel, so this answers WHERE the cell is
 * shown and never claims the pixel shows only that cell.
 */
export function displayPixelOf(
  plan: RasterPlan,
  row: number,
  column: number,
): { readonly x: number; readonly y: number } | null {
  const { sourceWidth, sourceHeight, displayWidth, displayHeight } = plan;
  if (row < 0 || column < 0 || row >= sourceHeight || column >= sourceWidth) return null;
  if (displayWidth <= 0 || displayHeight <= 0) return null;
  return {
    x: Math.min(displayWidth - 1, Math.floor((column * displayWidth) / sourceWidth)),
    y: Math.min(displayHeight - 1, Math.floor((row * displayHeight) / sourceHeight)),
  };
}

/**
 * The grid cell a display record was decoded from, as a row and column, or null
 * when this frame produced no such record.
 *
 * The search itself is {@link cellIndexForRecord}, in the model, because which
 * array can answer for which record is a fact about the frame's own storage and
 * not about drawing. This wrapper only turns a cell index into the row and
 * column a raster addresses.
 *
 * Searching `cellToRecord` alone was wrong for a multi-return cell: that array
 * keeps one record per cell, so the second return of a pulse resolved to null
 * here while `returnsForCell` listed it, and the pointer that landed on the
 * cell could not be inverted from the record the inspector was showing.
 */
export function cellForRecord(
  frame: OrganizedRangeFrame,
  record: number,
): { readonly row: number; readonly column: number } | null {
  const i = cellIndexForRecord(frame, record);
  if (i === null) return null;
  return { row: Math.floor(i / frame.width), column: i % frame.width };
}

/** Every state in value order, re-exported so a legend needs one import. */
export const RASTER_CELL_STATES = CELL_STATES;
