/**
 * clipBox.ts
 *
 * The pure region logic behind a clipping box ("show only the points inside
 * this box" / "hide the points inside this box"). It is the data-and-math core
 * that the live GPU clip (`clipGpu.ts`), the kept-point counts and the export
 * scope build on; keeping it pure means the keep/cull decision is
 * unit-testable and the clip STATE is serialisable, so a clip survives in a
 * shared `.olvsession` recipe. The box is edited on the Clip page (numeric
 * bounds, or a Box drawn on the scan) and drawn in the scene as an outline.
 *
 * Reuses the existing axis-aligned {@link BoxBounds} + {@link pointInBox} so a
 * clip box and a Box measurement share one geometry definition (no second,
 * drifting notion of "a box").
 *
 * Pure data: no DOM, no three.js, no GPU. Deterministic.
 */

import type { Vec3 } from '../measure/types';
import { type BoxBounds, pointInBox } from '../measure/geometry';

/**
 * How the box partitions the cloud:
 *   - `keep-inside`  — render only points INSIDE the box (an isolation slice).
 *   - `keep-outside` — render only points OUTSIDE the box (a cut-away / hole).
 */
export type ClipMode = 'keep-inside' | 'keep-outside';

/** A clipping box: its region, its mode, and whether it is currently active. */
export interface ClipBox {
  readonly box: BoxBounds;
  readonly mode: ClipMode;
  /** When false the clip is dormant — every point is kept (`clipKeepsPoint` ⇒ true). */
  readonly enabled: boolean;
}

/** A dormant clip over the given box (default `keep-inside`, disabled). */
export function makeClipBox(box: BoxBounds, mode: ClipMode = 'keep-inside'): ClipBox {
  return { box, mode, enabled: false };
}

/**
 * Whether a single point SURVIVES the clip (is rendered). A disabled clip keeps
 * everything; otherwise `keep-inside` keeps points in the box and `keep-outside`
 * keeps points outside it. Box faces are inclusive (see {@link pointInBox}).
 */
export function clipKeepsPoint(clip: ClipBox, p: Vec3): boolean {
  if (!clip.enabled) return true;
  const inside = pointInBox(p, clip.box);
  return clip.mode === 'keep-inside' ? inside : !inside;
}

/**
 * A per-point keep mask (`1` = rendered, `0` = clipped) over an interleaved
 * x/y/z buffer. A disabled clip yields an all-ones mask. Linear pass; intended
 * for inspection-scale buffers and as the reference the GPU path is verified
 * against, not per-frame culling.
 */
export function clipMaskArray(clip: ClipBox, positions: Float32Array): Uint8Array {
  const n = (positions.length / 3) | 0;
  const mask = new Uint8Array(n);
  if (!clip.enabled) {
    mask.fill(1);
    return mask;
  }
  const keepInside = clip.mode === 'keep-inside';
  const { min, max } = clip.box;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const inside =
      x >= min[0] && x <= max[0] &&
      y >= min[1] && y <= max[1] &&
      z >= min[2] && z <= max[2];
    const keep = keepInside ? inside : !inside;
    mask[i] = keep ? 1 : 0;
  }
  return mask;
}

/** The clip's kept-point count for one layer, as the viewer reports it per layer. */
export interface ClipLayerCount {
  readonly id: string;
  /** Whether the layer is drawn; the count also covers the active layer when hidden. */
  readonly visible: boolean;
  readonly kept: number;
  readonly total: number;
}

/**
 * Sum per-layer counts into what the Clip page shows: the active layer's own
 * kept/total (what an export writes) and, when several layers are drawn, the
 * figure over all of them. Null when the active layer was not counted.
 */
export function sumClipCounts(
  layers: readonly ClipLayerCount[],
  activeId: string | null,
): { kept: number; total: number; visible: { kept: number; total: number; scans: number } | null } | null {
  const active = layers.find((l) => l.id === activeId);
  if (!active) return null;
  const shown = layers.filter((l) => l.visible);
  const visible = shown.length > 1
    ? { kept: shown.reduce((a, l) => a + l.kept, 0), total: shown.reduce((a, l) => a + l.total, 0), scans: shown.length }
    : null;
  return { kept: active.kept, total: active.total, visible };
}

/** How many points of an interleaved x/y/z buffer the clip keeps (renders). */
export function countKept(clip: ClipBox, positions: Float32Array): number {
  const n = (positions.length / 3) | 0;
  if (!clip.enabled) return n;
  const keepInside = clip.mode === 'keep-inside';
  const { min, max } = clip.box;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    if (x < min[0] || x > max[0]) {
      if (!keepInside) kept++;
      continue;
    }
    const y = positions[i * 3 + 1];
    if (y < min[1] || y > max[1]) {
      if (!keepInside) kept++;
      continue;
    }
    const z = positions[i * 3 + 2];
    if (z < min[2] || z > max[2]) {
      if (!keepInside) kept++;
      continue;
    }
    if (keepInside) kept++;
  }
  return kept;
}

/**
 * A pick predicate that also refuses points the clip hides, so a click, a
 * double-click focus, a hover probe or a measurement vertex can never land on a
 * point the user cannot see. `positions` is the buffer the pick scans and
 * `offset` its translation into the clip's frame (the layer placement; zero for
 * a streaming node). Returns `inner` untouched when no clip is active, so the
 * all-visible hot path makes no per-point call.
 */
export function clipPickAccept(
  clip: ClipBox | null | undefined,
  positions: ArrayLike<number>,
  offset: readonly [number, number, number],
  inner?: (index: number) => boolean,
): ((index: number) => boolean) | undefined {
  if (!clip?.enabled) return inner;
  const { min, max } = clip.box;
  const keepInside = clip.mode === 'keep-inside';
  const [dx, dy, dz] = offset;
  // Inlined (no tuple per point): a pick may ask this of many points.
  return (i: number): boolean => {
    if (inner !== undefined && !inner(i)) return false;
    const x = positions[i * 3] + dx;
    const y = positions[i * 3 + 1] + dy;
    const z = positions[i * 3 + 2] + dz;
    const inside = x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
    return keepInside ? inside : !inside;
  };
}

/** A scan's extent along its up axis, in the clip's frame. */
export interface VerticalExtent {
  /** Index of the up axis in a Vec3: 2 for Z-up scans, 1 for Y-up. */
  readonly axis: 0 | 1 | 2;
  readonly min: number;
  readonly max: number;
}

/** The extent of `bounds` ([minx, miny, minz, maxx, maxy, maxz]) along `axis`, or null with no bounds. */
export function verticalExtentOf(
  bounds: readonly number[] | null | undefined,
  axis: 1 | 2,
): VerticalExtent | null {
  return bounds ? { axis, min: bounds[axis], max: bounds[3 + axis] } : null;
}

/**
 * The region to frame for a keep-inside clip: the clip's box trimmed to the
 * data (a flat box is given the scan's height plus a margin, which would
 * otherwise frame empty space). Null for no clip, an Outside clip, no data or a
 * box that misses the data.
 */
export function clipFrameBounds(
  clip: ClipBox | null | undefined,
  data: readonly number[] | null | undefined,
): { min: Vec3; max: Vec3 } | null {
  if (!clip?.enabled || clip.mode !== 'keep-inside' || !data) return null;
  const min: Vec3 = [Math.max(clip.box.min[0], data[0]), Math.max(clip.box.min[1], data[1]), Math.max(clip.box.min[2], data[2])];
  const max: Vec3 = [Math.min(clip.box.max[0], data[3]), Math.min(clip.box.max[1], data[4]), Math.min(clip.box.max[2], data[5])];
  return max[0] > min[0] && max[1] > min[1] && max[2] > min[2] ? { min, max } : null;
}
