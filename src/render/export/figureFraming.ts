/**
 * figureFraming.ts
 *
 * Pure size/aspect planning for `Viewer.renderFigure` — the honest
 * custom-resolution export of the LIVE perspective view. Extracted as a leaf
 * module for the same reason as `orthoFraming.ts`: the equation the export's
 * honesty depends on ("the drawing buffer is EXACTLY the planned pixels, and
 * the camera is re-projected with EXACTLY the ratio of those pixels") must
 * be a unit-tested contract, not inline GPU-adjacent arithmetic.
 *
 * Why an explicit planner at all: the snapshot path can only copy the
 * on-screen drawing buffer, and its `supersample` option merely upscales the
 * 2-D composite — the points themselves stay at canvas resolution. A user
 * who asks for 2048 px must get 2048 px of actual rendered geometry, which
 * means a true offscreen re-render whose size and camera aspect come from
 * here.
 *
 * No three.js, no DOM — the Viewer applies the returned numbers.
 */

/** Output width when the caller requests no dimensions at all. */
export const DEFAULT_FIGURE_WIDTH_PX = 2048;

/**
 * Hard per-edge cap. 8192 sits inside every WebGPU/WebGL2 implementation's
 * guaranteed max texture size (the WebGPU default limit is 8192, WebGL2's
 * floor in practice is 8192 on anything that runs this app), so a planned
 * size never asks the renderer for a buffer the device must refuse.
 */
export const MAX_FIGURE_EDGE_PX = 8192;

/** The exact drawing-buffer size + camera aspect for one figure render. */
export interface FigureRenderPlan {
  readonly widthPx: number;
  readonly heightPx: number;
  /**
   * ALWAYS `widthPx / heightPx` of the actual output pixels — rounding the
   * derived edge shifts the ratio slightly off the live one, and projecting
   * with the live ratio onto the rounded buffer would lean vertical lines.
   */
  readonly aspect: number;
}

/** A requested dimension is usable when it is a finite number ≥ 0.5 (i.e.
 *  rounds to at least one pixel). */
function usable(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0.5;
}

/**
 * Plan the output size for a figure render.
 *
 *   - both edges requested → honoured exactly (rounded to whole pixels);
 *   - one edge requested   → the other derives from the live canvas aspect,
 *     so the figure frames what the user is looking at;
 *   - neither requested    → {@link DEFAULT_FIGURE_WIDTH_PX} at live aspect;
 *   - either edge over {@link MAX_FIGURE_EDGE_PX} → both scale down
 *     together, preserving the requested aspect;
 *   - any PRESENT-but-invalid edge (non-finite, rounds to zero, negative)
 *     → null. Rejecting loudly beats "helpfully" rendering some other size
 *     than the one asked for.
 *
 * A degenerate live canvas (zero-sized — e.g. a hidden tab) falls back to a
 * square aspect for the derived edge; the requested edge is still honoured.
 */
export function planFigureRender(
  requested: { readonly widthPx?: number; readonly heightPx?: number },
  live: { readonly widthPx: number; readonly heightPx: number },
): FigureRenderPlan | null {
  const reqW = requested.widthPx;
  const reqH = requested.heightPx;
  if (reqW !== undefined && !usable(reqW)) return null;
  if (reqH !== undefined && !usable(reqH)) return null;

  const liveAspect =
    live.widthPx > 0 && live.heightPx > 0 ? live.widthPx / live.heightPx : 1;

  let w: number;
  let h: number;
  if (usable(reqW) && usable(reqH)) {
    w = Math.round(reqW);
    h = Math.round(reqH);
  } else if (usable(reqW)) {
    w = Math.round(reqW);
    h = Math.round(reqW / liveAspect);
  } else if (usable(reqH)) {
    h = Math.round(reqH);
    w = Math.round(reqH * liveAspect);
  } else {
    w = DEFAULT_FIGURE_WIDTH_PX;
    h = Math.round(DEFAULT_FIGURE_WIDTH_PX / liveAspect);
  }

  // A derived edge can round to zero only when the aspect is extreme
  // (e.g. 1 px wide against a 10:1 canvas) — clamp it to the 1 px floor
  // rather than failing a request that was itself valid.
  w = Math.max(1, w);
  h = Math.max(1, h);

  // Scale down together so an oversize request keeps its aspect instead of
  // being clipped edge-per-edge into a different shape.
  const over = Math.max(w, h) / MAX_FIGURE_EDGE_PX;
  if (over > 1) {
    w = Math.max(1, Math.round(w / over));
    h = Math.max(1, Math.round(h / over));
  }

  return { widthPx: w, heightPx: h, aspect: w / h };
}
