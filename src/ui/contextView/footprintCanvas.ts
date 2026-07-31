/**
 * footprintCanvas.ts
 *
 * The OFFLINE footprint renderer for Context View: scan footprint outlines and
 * an optional camera marker on a plain equirectangular projection, fitted to
 * the footprints' combined lon/lat bounds with 10% padding.
 *
 * This module draws with canvas strokes only. No tiles, no images, no fetch,
 * no network of any kind — it renders TODAY, before (and regardless of) any
 * tile-download consent. The lon/lat → pixel math lives in the exported
 * {@link projectToCanvas} so tests pin it without a canvas at all.
 */

import type { ContextFootprint } from '../../geo/context/index';

/** Combined lon/lat extent of a footprint set. */
export interface LonLatBounds {
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
}

/** Pixel size of the drawing surface. */
export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/** Optional camera marker: position + compass heading (null = unknown). */
export interface ContextCameraMarker {
  readonly position: readonly [number, number];
  readonly headingDeg: number | null;
}

/** Fraction of each axis span added as padding on EACH side of the fit. */
export const BOUNDS_PADDING = 0.1;

/** Stroke colour used when no computed style is available (stub/test DOM). */
export const FALLBACK_STROKE = '#5b8dbf';

/**
 * Project a WGS84 lon/lat onto a canvas of `size`, equirectangular, fitted to
 * `bounds` with {@link BOUNDS_PADDING} padding per side. Latitude grows
 * upward (north at the top). A degenerate axis (zero span — e.g. a single
 * point) centres on that axis rather than dividing by zero, so the result is
 * always finite.
 */
export function projectToCanvas(
  bounds: LonLatBounds,
  size: CanvasSize,
  lonLat: readonly [number, number],
): readonly [number, number] {
  const lonSpan = bounds.maxLon - bounds.minLon;
  const latSpan = bounds.maxLat - bounds.minLat;

  const x =
    lonSpan > 0
      ? ((lonLat[0] - (bounds.minLon - lonSpan * BOUNDS_PADDING)) /
          (lonSpan * (1 + 2 * BOUNDS_PADDING))) *
        size.width
      : size.width / 2;

  const y =
    latSpan > 0
      ? size.height -
        ((lonLat[1] - (bounds.minLat - latSpan * BOUNDS_PADDING)) /
          (latSpan * (1 + 2 * BOUNDS_PADDING))) *
          size.height
      : size.height / 2;

  return [x, y];
}

/**
 * Combined finite bounds of every ring vertex, or `null` when no finite
 * vertex exists (empty list, empty rings, or all-NaN coordinates).
 */
export function footprintBounds(
  footprints: readonly ContextFootprint[],
): LonLatBounds | null {
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let any = false;

  for (const fp of footprints) {
    for (const [lon, lat] of fp.ringLonLat) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      any = true;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  return any ? { minLon, maxLon, minLat, maxLat } : null;
}

/** Resolve the stroke colour from the canvas's computed style, else fallback. */
function strokeColor(canvas: HTMLCanvasElement): string {
  // `typeof` keeps this safe in stub environments with no getComputedStyle.
  if (typeof getComputedStyle === 'function') {
    try {
      const color = getComputedStyle(canvas).color;
      if (color) return color;
    } catch {
      // Recording-stub DOM: fall through to the constant.
    }
  }
  return FALLBACK_STROKE;
}

/**
 * Draw footprint outlines (and the camera marker, when given) onto `canvas`.
 * Returns `true` when something was drawn; an empty footprint list — or a
 * canvas with no usable 2d context — draws nothing and returns `false`.
 * Strictly offline: strokes only, no images, no tiles, no fetch.
 */
export function drawFootprints(
  canvas: HTMLCanvasElement,
  footprints: readonly ContextFootprint[],
  marker?: ContextCameraMarker,
): boolean {
  if (footprints.length === 0) return false;

  const bounds = footprintBounds(footprints);
  if (bounds === null) return false;

  const ctx =
    typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (ctx === null) return false;

  const size: CanvasSize = { width: canvas.width, height: canvas.height };
  const color = strokeColor(canvas);

  ctx.clearRect(0, 0, size.width, size.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;

  for (const fp of footprints) {
    if (fp.ringLonLat.length === 0) continue;
    ctx.beginPath();
    let started = false;
    for (const vertex of fp.ringLonLat) {
      const [x, y] = projectToCanvas(bounds, size, vertex);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.stroke();
  }

  if (marker) {
    const [mx, my] = projectToCanvas(bounds, size, marker.position);
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (marker.headingDeg !== null) {
      // Heading 0° = north (up on the canvas), clockwise.
      const rad = (marker.headingDeg * Math.PI) / 180;
      const len = 12;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + Math.sin(rad) * len, my - Math.cos(rad) * len);
      ctx.stroke();
    }
  }

  return true;
}
