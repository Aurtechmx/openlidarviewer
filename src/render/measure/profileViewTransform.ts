/**
 * profileViewTransform.ts
 *
 * The viewport transform for a 2D profile cross-section: data space
 * (chainage, height) to screen space and back, fit, pan, zoom about a
 * cursor, and vertical exaggeration.
 *
 * Pure. No DOM, no canvas, no renderer. Everything here is a value.
 *
 * Vertical exaggeration is a ratio between two physical scales, so it can
 * only be stated when both axes can be expressed in the same physical unit.
 * A profile's horizontal and vertical units can differ, and either can be
 * unknown. When one is unknown the view still works, and the ratio is
 * reported as null rather than as 1.
 */

/** Metres per data unit on each axis. Null where the scale is unknown. */
export interface ProfileUnitContext {
  readonly horizontalToMetres: number | null;
  readonly verticalToMetres: number | null;
}

/** The drawable area, in CSS pixels, and the backing store ratio. */
export interface ProfileViewport {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

/** Data-space extent to be shown. */
export interface ProfileDataBounds {
  readonly minChainage: number;
  readonly maxChainage: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/**
 * `fit` scales each axis independently to the viewport and claims no ratio.
 * `ve` holds a true vertical exaggeration and requires both unit scales.
 */
export type ProfileScaleMode =
  | { readonly kind: 'fit' }
  | { readonly kind: 've'; readonly ratio: number };

/** A resolved view: what sits at the centre, and the scale of each axis. */
export interface ProfileView {
  readonly centreChainage: number;
  readonly centreHeight: number;
  /** CSS pixels per chainage unit. Always > 0. */
  readonly pxPerChainage: number;
  /** CSS pixels per height unit. Always > 0. */
  readonly pxPerHeight: number;
}

/**
 * The smallest span a degenerate axis is given.
 *
 * A section whose returns share one height has a zero height span, and
 * dividing the viewport by it yields infinity. One unit of span puts such a
 * section on a readable axis instead of an empty one.
 */
export const MIN_DATA_SPAN = 1e-6;

/** Scale change per zoom step. */
export const ZOOM_STEP = 1.2;

const MIN_PX_PER_UNIT = 1e-12;
const MAX_PX_PER_UNIT = 1e12;

function finite(v: number): boolean {
  return Number.isFinite(v);
}

function clampScale(v: number): number {
  if (!finite(v) || v <= 0) return MIN_PX_PER_UNIT;
  return Math.min(MAX_PX_PER_UNIT, Math.max(MIN_PX_PER_UNIT, v));
}

function spanOf(min: number, max: number): number {
  const s = max - min;
  if (!finite(s) || s <= MIN_DATA_SPAN) return MIN_DATA_SPAN;
  return s;
}

/** True when a true vertical exaggeration can be stated for these units. */
export function canStateExaggeration(units: ProfileUnitContext): boolean {
  const h = units.horizontalToMetres;
  const v = units.verticalToMetres;
  return h != null && v != null && finite(h) && finite(v) && h > 0 && v > 0;
}

/**
 * The view's vertical exaggeration, or null when it cannot be stated.
 *
 * Pixels per metre on each axis is the axis scale divided by the metres in
 * one of its data units. The exaggeration is the vertical figure over the
 * horizontal one.
 */
export function viewExaggeration(
  view: ProfileView,
  units: ProfileUnitContext,
): number | null {
  if (!canStateExaggeration(units)) return null;
  const h = units.horizontalToMetres!;
  const v = units.verticalToMetres!;
  const pxPerMetreX = view.pxPerChainage / h;
  const pxPerMetreY = view.pxPerHeight / v;
  if (!finite(pxPerMetreX) || pxPerMetreX <= 0) return null;
  const ratio = pxPerMetreY / pxPerMetreX;
  return finite(ratio) ? ratio : null;
}

/**
 * Fit `bounds` into `viewport`.
 *
 * Under `fit` each axis takes the viewport independently. Under `ve` both
 * axes take one base scale chosen so the whole extent still fits, so holding
 * a ratio never crops an extreme.
 *
 * Returns null when the mode asks for an exaggeration the units cannot
 * support, so a caller must handle that rather than receive a view whose
 * ratio is a fiction.
 */
export function fitProfileView(
  bounds: ProfileDataBounds,
  viewport: ProfileViewport,
  mode: ProfileScaleMode,
  units: ProfileUnitContext,
): ProfileView | null {
  const w = finite(viewport.width) && viewport.width > 0 ? viewport.width : 1;
  const hgt = finite(viewport.height) && viewport.height > 0 ? viewport.height : 1;

  const minC = finite(bounds.minChainage) ? bounds.minChainage : 0;
  const maxC = finite(bounds.maxChainage) ? bounds.maxChainage : 0;
  const minH = finite(bounds.minHeight) ? bounds.minHeight : 0;
  const maxH = finite(bounds.maxHeight) ? bounds.maxHeight : 0;

  const spanC = spanOf(minC, maxC);
  const spanH = spanOf(minH, maxH);
  const centreChainage = (minC + maxC) / 2;
  const centreHeight = (minH + maxH) / 2;

  if (mode.kind === 'fit') {
    return {
      centreChainage,
      centreHeight,
      pxPerChainage: clampScale(w / spanC),
      pxPerHeight: clampScale(hgt / spanH),
    };
  }

  if (!canStateExaggeration(units)) return null;
  const ratio = mode.ratio;
  if (!finite(ratio) || ratio <= 0) return null;
  const mPerC = units.horizontalToMetres!;
  const mPerH = units.verticalToMetres!;

  // pxPerHeight = ratio * pxPerChainage * mPerH / mPerC, so a vertical fit
  // implies a horizontal scale. Taking the smaller of that and the
  // horizontal fit keeps both extents inside the viewport.
  const fromWidth = w / spanC;
  const fromHeight = ((hgt / spanH) * mPerC) / (ratio * mPerH);
  const pxPerChainage = clampScale(Math.min(fromWidth, fromHeight));
  const pxPerHeight = clampScale((ratio * pxPerChainage * mPerH) / mPerC);
  return { centreChainage, centreHeight, pxPerChainage, pxPerHeight };
}

/**
 * Data to screen, in CSS pixels from the top left of the drawable area.
 *
 * Height increases upward on screen, so the vertical term is negated.
 */
export function profileDataToScreen(
  view: ProfileView,
  viewport: ProfileViewport,
  chainage: number,
  height: number,
  out: Float64Array,
): void {
  out[0] = viewport.width / 2 + (chainage - view.centreChainage) * view.pxPerChainage;
  out[1] = viewport.height / 2 - (height - view.centreHeight) * view.pxPerHeight;
}

/** Screen to data. The inverse of {@link profileDataToScreen}. */
export function profileScreenToData(
  view: ProfileView,
  viewport: ProfileViewport,
  sx: number,
  sy: number,
  out: Float64Array,
): void {
  out[0] = view.centreChainage + (sx - viewport.width / 2) / view.pxPerChainage;
  out[1] = view.centreHeight - (sy - viewport.height / 2) / view.pxPerHeight;
}

/** Move the view by a screen-space delta. */
export function panProfileView(
  view: ProfileView,
  dxPx: number,
  dyPx: number,
): ProfileView {
  const dx = finite(dxPx) ? dxPx : 0;
  const dy = finite(dyPx) ? dyPx : 0;
  return {
    ...view,
    centreChainage: view.centreChainage - dx / view.pxPerChainage,
    centreHeight: view.centreHeight + dy / view.pxPerHeight,
  };
}

/**
 * Zoom about a screen anchor, keeping the data under that anchor fixed.
 *
 * Under `fit` both axes scale together, which preserves the aspect the fit
 * produced. Under `ve` both axes scale together as well, which is what keeps
 * the exaggeration constant through a zoom.
 */
export function zoomProfileViewAt(
  view: ProfileView,
  viewport: ProfileViewport,
  anchorX: number,
  anchorY: number,
  factor: number,
): ProfileView {
  if (!finite(factor) || factor <= 0) return view;
  const ax = finite(anchorX) ? anchorX : viewport.width / 2;
  const ay = finite(anchorY) ? anchorY : viewport.height / 2;

  const before = new Float64Array(2);
  profileScreenToData(view, viewport, ax, ay, before);
  const next: ProfileView = {
    ...view,
    pxPerChainage: clampScale(view.pxPerChainage * factor),
    pxPerHeight: clampScale(view.pxPerHeight * factor),
  };
  const after = new Float64Array(2);
  profileScreenToData(next, viewport, ax, ay, after);
  return {
    ...next,
    centreChainage: next.centreChainage + (before[0]! - after[0]!),
    centreHeight: next.centreHeight + (before[1]! - after[1]!),
  };
}

/** Scale a CSS-pixel measure to the canvas backing store. */
export function toDevicePixels(viewport: ProfileViewport, cssPx: number): number {
  const dpr =
    finite(viewport.devicePixelRatio) && viewport.devicePixelRatio > 0
      ? viewport.devicePixelRatio
      : 1;
  return cssPx * dpr;
}

/** The data-space rectangle the viewport currently shows. */
export function profileVisibleBounds(
  view: ProfileView,
  viewport: ProfileViewport,
): ProfileDataBounds {
  const halfC = viewport.width / 2 / view.pxPerChainage;
  const halfH = viewport.height / 2 / view.pxPerHeight;
  return {
    minChainage: view.centreChainage - halfC,
    maxChainage: view.centreChainage + halfC,
    minHeight: view.centreHeight - halfH,
    maxHeight: view.centreHeight + halfH,
  };
}
