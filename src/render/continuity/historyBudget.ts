/**
 * historyBudget.ts
 *
 * What the accumulation history costs in GPU memory, and which formats it needs
 * rather than which are easiest to ask for.
 *
 * Three surfaces have to persist between frames: the colour built up so far,
 * the depth it was built at, and how much support each pixel has. Reaching for
 * a 32-bit float for all three is the path of least resistance and the reason a
 * history buffer turns into hundreds of megabytes on a 4K panel, which on a
 * laptop is the difference between a feature and a browser tab that gets killed.
 *
 * Eight bits a channel is enough for the colour here, and that follows from the
 * sweep being short. A photographic accumulator folding hundreds of frames into
 * one buffer needs the headroom, because rounding at each step compounds. This
 * sweep is four phases, each pixel takes a handful of contributions, and the
 * error stays below what an 8-bit display can show. If the phase count ever
 * grew into the hundreds the choice would have to be revisited, which is the
 * one thing worth remembering about it.
 *
 * Depth is the surface that cannot be economised. The merge rule compares
 * depths as a ratio across a scene that may span metres to kilometres, and a
 * half float carries about three decimal digits, so it would collapse exactly
 * the distinctions the rule is there to draw.
 *
 * Pure arithmetic: no GPU, no allocation. It sizes a buffer, it does not make
 * one. Display only.
 */

/** A texture format the history can use, with its cost per pixel. */
export interface HistoryFormat {
  readonly label: string;
  readonly bytesPerPixel: number;
}

/** Accumulated colour. Four 8-bit channels. */
export const COLOR_RGBA8: HistoryFormat = { label: 'rgba8unorm', bytesPerPixel: 4 };

/** Accumulated colour at half precision, for a sweep long enough to need it. */
export const COLOR_RGBA16F: HistoryFormat = { label: 'rgba16float', bytesPerPixel: 8 };

/** History depth. Full float, because the merge rule compares depths as a ratio. */
export const DEPTH_R32F: HistoryFormat = { label: 'r32float', bytesPerPixel: 4 };

/** Per-pixel support. A count that saturates long before 255. */
export const SUPPORT_R8: HistoryFormat = { label: 'r8unorm', bytesPerPixel: 1 };

/** The surfaces the history keeps. */
export interface HistoryLayout {
  readonly colour: HistoryFormat;
  readonly depth: HistoryFormat;
  readonly support: HistoryFormat;
}

/** The layout this ships with: the smallest that does not lose a distinction. */
export const CONSERVATIVE_LAYOUT: HistoryLayout = {
  colour: COLOR_RGBA8,
  depth: DEPTH_R32F,
  support: SUPPORT_R8,
};

/** Everything at full float, for comparison rather than for use. */
export const FLOAT_LAYOUT: HistoryLayout = {
  colour: { label: 'rgba32float', bytesPerPixel: 16 },
  depth: DEPTH_R32F,
  support: { label: 'r32float', bytesPerPixel: 4 },
};

/** Bytes one pixel of history costs under a layout. */
export function bytesPerPixel(layout: HistoryLayout): number {
  return layout.colour.bytesPerPixel + layout.depth.bytesPerPixel + layout.support.bytesPerPixel;
}

/**
 * Bytes the history costs for a backing store of this size.
 *
 * `widthPx` and `heightPx` are device pixels, so the device pixel ratio is
 * already in them. That is the figure that matters: a 1440p panel at a ratio of
 * two allocates more than a 4K panel at one, and quoting the CSS size would
 * understate it by four.
 */
export function historyBytes(
  widthPx: number,
  heightPx: number,
  layout: HistoryLayout = CONSERVATIVE_LAYOUT,
): number {
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return 0;
  const w = Math.max(0, Math.floor(widthPx));
  const h = Math.max(0, Math.floor(heightPx));
  return w * h * bytesPerPixel(layout);
}

/**
 * Whether a history of this size is worth allocating at all.
 *
 * A ceiling rather than a target. Past it the field should decline and leave the
 * renderer drawing source samples, which is the behaviour the failure path wants
 * anyway: no history is a worse picture, a history that will not fit is a lost
 * context.
 */
export const HISTORY_BYTES_CEILING = 256 * 1024 * 1024;

/** Whether the history fits the ceiling at this size. */
export function historyFits(
  widthPx: number,
  heightPx: number,
  layout: HistoryLayout = CONSERVATIVE_LAYOUT,
  ceiling: number = HISTORY_BYTES_CEILING,
): boolean {
  return historyBytes(widthPx, heightPx, layout) <= ceiling;
}
