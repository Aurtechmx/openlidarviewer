/**
 * streamingFiniteGuard.ts
 *
 * The finite-coordinate guard for STREAMING node decodes.
 *
 * `sanitizeCloud.ts` cleans file-loaded clouds, but by contract leaves
 * streaming (COPC / EPT) node buffers alone — each is decoded per node in a
 * worker and transferred zero-copy, so there is no central choke point to
 * filter them (sanitizeCloud.ts header, "Scope: the FILE-LOADING path only").
 * That left one gap: a malformed COPC/EPT header whose scale, offset, or render
 * origin is non-finite turns every point of every node into NaN, and an EPT
 * tile whose X/Y/Z attribute is stored as a float can carry a literal NaN in
 * its bytes. Either way NaN reaches `InstancedBufferAttribute` and the GPU with
 * nothing in between to catch it.
 *
 * A streaming node is the wrong granularity to silently drop points from — its
 * count is already accounted against the point budget and its buffer is
 * transferred whole — so the honest response is to REFUSE the node with a
 * structured error the scheduler already isolates and backs off (up to its
 * retry cap, then terminally). A refused node degrades to "that region didn't
 * load"; a NaN-poisoned one degrades to "nothing renders".
 *
 * Pure — no DOM, no three.js — so it runs inside the decode workers.
 */

import { LoadError } from './loadErrors';

/**
 * Refuse a node whose coordinate transform is outright non-finite (a NaN/Inf
 * scale, offset, or render origin). O(1) and cheap, so it runs up front to fail
 * a bad node before decoding it. It is NOT sufficient on its own: a transform
 * that is finite but extreme can still overflow `int32 · scale + offset` to
 * ±Infinity, so callers pair it with {@link assertFinitePositions} over the
 * finished buffer as the backstop.
 */
export function assertFiniteNodeTransform(
  scale: readonly [number, number, number],
  offset: readonly [number, number, number],
  renderOrigin: readonly [number, number, number],
): void {
  if (isFiniteTriple(scale) && isFiniteTriple(offset) && isFiniteTriple(renderOrigin)) {
    return;
  }
  throw new LoadError(
    'malformed-file',
    `A streaming node's coordinate transform carried a non-finite value ` +
      `(scale ${fmt(scale)}, offset ${fmt(offset)}, render origin ${fmt(renderOrigin)}). ` +
      `Decoding it would place every point at NaN, so the node is refused.`,
  );
}

/**
 * Refuse a node whose decoded positions contain a non-finite coordinate. Needed
 * where the SOURCE can carry a NaN that a finite transform cannot remove — an
 * EPT tile whose X/Y/Z attribute is stored as float32/float64. Scans with an
 * early exit, so a clean node (the common case) costs one linear read and a
 * poisoned one stops at the first bad value.
 */
export function assertFinitePositions(positions: Float32Array): void {
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      const point = Math.floor(i / 3);
      throw new LoadError(
        'malformed-file',
        `A streaming node decoded to a non-finite coordinate at point ${point}. ` +
          `Its source stored a NaN or ±Infinity, so the node is refused rather than drawn.`,
      );
    }
  }
}

function isFiniteTriple(t: readonly [number, number, number]): boolean {
  return Number.isFinite(t[0]) && Number.isFinite(t[1]) && Number.isFinite(t[2]);
}

function fmt(t: readonly [number, number, number]): string {
  return `[${t[0]}, ${t[1]}, ${t[2]}]`;
}
