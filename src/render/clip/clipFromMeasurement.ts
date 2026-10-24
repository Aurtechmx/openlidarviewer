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
 *   - degenerate boxes are refused: a zero (or sub-epsilon) extent on either
 *     horizontal axis would clip everything away (keep-inside) or nothing
 *     (keep-outside), and neither is what the user drew;
 *   - a FLAT box is given a height. Two corners picked on the ground differ by
 *     centimetres in height, so the box they span is a slab a few centimetres
 *     thick and isolating it shows a 2D slice of the scan. When the box's
 *     height along the up axis is under {@link FLAT_BOX_FRACTION} of the scan's
 *     vertical range, the clip's height is the scan's whole vertical extent and
 *     the result says so (`heightExtended`). With no vertical extent supplied the
 *     decision falls back to refusing a box with a zero extent on any axis, so a
 *     truly degenerate box is never accepted. The measurement itself is never
 *     touched;
 *   - a FOOTPRINT box always takes the scan's full height. A box drawn with
 *     "Draw clipping box", or drawn looking straight down, is two clicks on
 *     whatever surface was under the cursor: its height is an accident of
 *     where those clicks landed, not a choice. The caller says so with
 *     `fullHeight`, and the result names the reason (`'footprint'`). A box
 *     measured on the Measure page keeps the height it was drawn with (unless
 *     flat), and an explicit Z typed on the Clip page afterwards is the user's;
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
import type { ClipBox, VerticalExtent } from './clipBox';

export type { VerticalExtent };

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
  /**
   * The scan's vertical extent along its up axis, in the clip's frame (the
   * project frame). Absent when unknown: only an exactly flat box is refused.
   */
  readonly vertical?: VerticalExtent | null;
  /** The box is a footprint (drawn to clip, or drawn looking straight down): use the scan's full height. */
  readonly fullHeight?: boolean;
}

/** A box thinner than this fraction of the scan's vertical range counts as flat. */
export const FLAT_BOX_FRACTION = 0.05;

/** Smallest extent (render units) a clip-box axis may have. */
export const MIN_CLIP_EXTENT = 1e-9;

export type ClipFromBoxResult =
  | {
      readonly ok: true;
      readonly clip: ClipBox;
      /**
       * Set when the box was given the scan's full height: the drawn height,
       * the one used, and why (a flat box, or a footprint drawn to clip).
       */
      readonly heightExtended?: HeightExtension;
    }
  | { readonly ok: false; readonly reason: string };

/** How a box's height was replaced by the scan's. */
export interface HeightExtension {
  readonly axis: 0 | 1 | 2;
  readonly drawn: number;
  readonly min: number;
  readonly max: number;
  readonly reason: 'flat' | 'footprint';
}

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
  const v = ctx.vertical && ctx.vertical.max > ctx.vertical.min ? ctx.vertical : null;
  const up = v ? v.axis : null;
  for (let i = 0; i < 3; i++) {
    // With a known vertical extent the height is judged below, not refused here.
    if (i === up) continue;
    if (!(box.max[i] - box.min[i] > MIN_CLIP_EXTENT)) {
      return { ok: false, reason: `This box is flat along ${'XYZ'[i]}, so it cannot enclose any points.` };
    }
  }
  const min: [number, number, number] = [...box.min];
  const max: [number, number, number] = [...box.max];
  let heightExtended: HeightExtension | undefined;
  if (v && up !== null) {
    const drawn = box.max[up] - box.min[up];
    const flat = drawn < (v.max - v.min) * FLAT_BOX_FRACTION;
    if (flat || ctx.fullHeight === true) {
      // A little margin so a rounding step never trims the top or bottom points.
      const pad = (v.max - v.min) * 0.01;
      min[up] = Math.min(box.min[up], v.min - pad);
      max[up] = Math.max(box.max[up], v.max + pad);
      heightExtended = { axis: v.axis, drawn, min: min[up], max: max[up], reason: ctx.fullHeight === true ? 'footprint' : 'flat' };
    }
  }
  const clip: ClipBox = { box: { min, max }, mode: 'keep-inside', enabled: true };
  return heightExtended ? { ok: true, clip, heightExtended } : { ok: true, clip };
}
