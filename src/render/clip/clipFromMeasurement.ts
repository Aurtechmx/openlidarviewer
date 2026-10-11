/**
 * clipFromMeasurement.ts — turn a completed Box measurement into a clip box.
 *
 * The Measurements panel offers "Use as clipping region" on a Box row. This is
 * the pure decision behind it: validate the measurement, check it belongs to
 * the scan being clipped, normalise its corners and build a keep-inside clip.
 *
 * Rules, in order:
 *   - the measurement must exist and be a Box with two finite corners;
 *   - ownership: when the measurement names an owning layer, that layer must be
 *     the active one. A measurement with no owner is accepted only while a
 *     single layer is open (the session's one origin is that layer's), because
 *     with several layers open nothing says which scan its corners belong to.
 *     Coordinates are never copied across datasets;
 *   - degenerate boxes are refused: a zero (or sub-epsilon) extent on ANY axis
 *     would clip everything away (keep-inside) or nothing (keep-outside), and
 *     neither is what the user drew;
 *   - the corners are normalised with `boxFromCorners`, so reversed corners give
 *     the same box.
 *
 * The result is an independent copy in the local render frame (the frame the
 * measurement and the clip share), with no unit conversion and no link back:
 * editing either afterwards never moves the other.
 *
 * Pure: no DOM, no three.js.
 */

import type { Vec3 } from '../measure/types';
import { boxFromCorners } from '../measure/geometry';
import type { ClipBox } from './clipBox';

/** The slice of a measurement this decision reads. */
export interface BoxMeasurementLike {
  readonly id: string;
  readonly kind: string;
  readonly points: readonly Vec3[];
  readonly owner?: { readonly layerId?: string };
}

/** Where the clip will be applied. */
export interface ClipTargetContext {
  /** Stable id of the active layer, or null when it has no proven identity. */
  readonly activeLayerId: string | null;
  /** Open layer count. */
  readonly layerCount: number;
}

/** Smallest extent (render units) a clip-box axis may have. */
export const MIN_CLIP_EXTENT = 1e-9;

export type ClipFromBoxResult =
  | { readonly ok: true; readonly clip: ClipBox }
  | { readonly ok: false; readonly reason: string };

const finite3 = (p: Vec3 | undefined): p is Vec3 =>
  !!p && p.length >= 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

/** Build a keep-inside, enabled clip from a Box measurement, or say why not. */
export function clipFromBoxMeasurement(
  m: BoxMeasurementLike | null | undefined,
  ctx: ClipTargetContext,
): ClipFromBoxResult {
  if (!m) return { ok: false, reason: 'That measurement no longer exists.' };
  if (m.kind !== 'box') return { ok: false, reason: 'Only a Box measurement can become a clipping region.' };
  const [a, b] = m.points;
  if (m.points.length < 2 || !finite3(a) || !finite3(b)) {
    return { ok: false, reason: 'This box has no valid corners to clip with.' };
  }
  if (ctx.layerCount < 1) return { ok: false, reason: 'Open a scan to clip.' };
  const ownerId = m.owner?.layerId;
  if (ownerId !== undefined) {
    if (ownerId !== ctx.activeLayerId) {
      return { ok: false, reason: 'This box was drawn on another scan. Switch to that scan to clip with it.' };
    }
  } else if (ctx.layerCount > 1) {
    return { ok: false, reason: 'This box does not say which scan it belongs to, so it cannot clip one of several open scans.' };
  }
  const box = boxFromCorners(a, b);
  for (let i = 0; i < 3; i++) {
    if (!(box.max[i] - box.min[i] > MIN_CLIP_EXTENT)) {
      return { ok: false, reason: `This box is flat along ${'XYZ'[i]}, so it cannot enclose any points.` };
    }
  }
  return {
    ok: true,
    clip: { box: { min: [...box.min], max: [...box.max] }, mode: 'keep-inside', enabled: true },
  };
}
