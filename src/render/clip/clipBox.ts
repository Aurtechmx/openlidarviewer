/**
 * clipBox.ts
 *
 * The pure region logic behind a clipping box ("show only the points inside
 * this box" / "hide the points inside this box"). It is the data-and-math core
 * that the live GPU clip shader and the drag gizmo build on; keeping it pure
 * means the keep/cull decision is unit-testable and — crucially — the clip
 * STATE is serialisable, so a clip survives in a shared `.olvsession` recipe
 * even though the interactive gizmo is a browser-only layer.
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
    mask[i] = (keepInside ? inside : !inside) ? 1 : 0;
  }
  return mask;
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
    if (x < min[0] || x > max[0]) { if (!keepInside) kept++; continue; }
    const y = positions[i * 3 + 1];
    if (y < min[1] || y > max[1]) { if (!keepInside) kept++; continue; }
    const z = positions[i * 3 + 2];
    if (z < min[2] || z > max[2]) { if (!keepInside) kept++; continue; }
    if (keepInside) kept++;
  }
  return kept;
}
