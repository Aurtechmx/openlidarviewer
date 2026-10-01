/**
 * classEditHistory.ts
 *
 * Delta-based undo/redo for in-place classification edits.
 *
 * A manual class-edit session (swap a bucket, repaint a polygon, repeat) needs
 * real multi-step undo — not the single coalesced snapshot the first cut shipped
 * with. Storing a full copy of the classification buffer per edit would cost
 * O(N) bytes *per step*; on a 50 M-point cloud that's 50 MB an edit. Instead,
 * each edit records only the points it actually changed — `{index, prev, next}`
 * — so a deep history costs bytes proportional to the EDITS, not the cloud.
 *
 * A whole-scan step (clear, derive, restore) changes nearly every point, where
 * that sparse form would cost six bytes a point. It keeps one dense byte per
 * point instead: the codes that are not live, swapped with the live buffer on
 * each undo and redo. The history also holds a byte budget, so repeated
 * whole-scan steps on a large scan drop the oldest steps rather than grow
 * without bound.
 *
 * Pure data. The Viewer owns the live `Uint8Array` classification buffer and
 * calls these helpers to capture an edit and to replay prev/next on undo/redo.
 */

import type { ClassMark, ClassState } from '../../model/PointCloud';

/** Bytes the undo history of one cloud may hold before its oldest steps drop. */
export const CLASS_HISTORY_MAX_BYTES = 128e6;

/**
 * The points one edit changed: parallel arrays, all the same length. A
 * whole-scan step (`prov` set) leaves `indices` and `next` empty and keeps
 * every point's code in `prev`.
 */
export interface ClassDelta {
  /** Indices of the points whose class changed. */
  readonly indices: Uint32Array;
  /**
   * Class code BEFORE the edit, aligned to {@link indices}. On a whole-scan
   * step, one code per point: the codes that are not live, swapped with the
   * live buffer on each undo and redo.
   */
  readonly prev: Uint8Array;
  /** Class code AFTER the edit, aligned to {@link indices}. */
  readonly next: Uint8Array;
  /**
   * Provenance before and after a whole-scan edit (clear, derive, restore),
   * which also moves where the codes came from. Undo puts back [0], redo [1].
   */
  readonly prov?: readonly [ClassMark, ClassMark];
}

const deltaBytes = (d: ClassDelta): number => d.indices.byteLength + d.prev.byteLength + d.next.byteLength;

/**
 * Diff two equal-length classification buffers into a {@link ClassDelta}, or
 * `null` when nothing changed (so no-op edits never enter the history).
 * Throws on a length mismatch — a delta across differently sized buffers would
 * corrupt the wrong points on replay.
 */
export function diffClassification(
  before: Uint8Array,
  after: Uint8Array,
): ClassDelta | null {
  if (before.length !== after.length) {
    throw new Error('classification length mismatch');
  }
  let n = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) n++;
  if (n === 0) return null;
  const indices = new Uint32Array(n);
  const prev = new Uint8Array(n);
  const next = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      indices[k] = i;
      prev[k] = before[i];
      next[k] = after[i];
      k++;
    }
  }
  return { indices, prev, next };
}

function applyDelta(buf: Uint8Array, delta: ClassDelta, dir: 'undo' | 'redo'): void {
  if (delta.prov) {
    // Dense: swap, so `prev` then holds the codes this step took off the buffer.
    const held = delta.prev;
    for (let i = 0; i < held.length; i++) { const c = buf[i]; buf[i] = held[i]; held[i] = c; }
    return;
  }
  const src = dir === 'undo' ? delta.prev : delta.next;
  const idx = delta.indices;
  for (let i = 0; i < idx.length; i++) buf[idx[i]] = src[i];
}

/**
 * A bounded undo/redo stack of classification deltas for one cloud. Pushing a
 * new edit clears the redo branch (standard linear-history semantics); the
 * oldest edit is evicted once `limit` edits or `maxBytes` bytes are exceeded.
 * The newest edit always stays, however large, so it can be undone.
 */
export class ClassEditHistory {
  private readonly _undo: ClassDelta[] = [];
  private readonly _redo: ClassDelta[] = [];
  private readonly _limit: number;
  private readonly _maxBytes: number;

  constructor(limit = 50, maxBytes = CLASS_HISTORY_MAX_BYTES) {
    this._limit = Math.max(1, Math.floor(limit));
    this._maxBytes = maxBytes;
  }

  /** Record a committed edit. Clears the redo branch. */
  push(delta: ClassDelta): void {
    this._undo.push(delta);
    this._redo.length = 0;
    let bytes = this.bytes;
    while (this._undo.length > 1 && (this._undo.length > this._limit || bytes > this._maxBytes)) {
      bytes -= deltaBytes(this._undo.shift()!);
    }
  }

  /** Bytes the recorded edits hold, undo and redo branches together. */
  get bytes(): number {
    let n = 0;
    for (const d of this._undo) n += deltaBytes(d);
    for (const d of this._redo) n += deltaBytes(d);
    return n;
  }

  get canUndo(): boolean {
    return this._undo.length > 0;
  }

  get canRedo(): boolean {
    return this._redo.length > 0;
  }

  /** Number of edits that can still be undone. */
  get depth(): number {
    return this._undo.length;
  }

  /**
   * Undo the most recent edit against `buf` (restores each point's `prev`).
   * Returns the delta applied, or `null` when there's nothing to undo.
   */
  undo(buf: Uint8Array): ClassDelta | null {
    const d = this._undo.pop();
    if (!d) return null;
    applyDelta(buf, d, 'undo');
    this._redo.push(d);
    return d;
  }

  /**
   * Redo the most recently undone edit against `buf` (re-applies `next`).
   * Returns the delta applied, or `null` when there's nothing to redo.
   */
  redo(buf: Uint8Array): ClassDelta | null {
    const d = this._redo.pop();
    if (!d) return null;
    applyDelta(buf, d, 'redo');
    this._undo.push(d);
    return d;
  }

  clear(): void {
    this._undo.length = 0;
    this._redo.length = 0;
  }
}

/**
 * Snapshot → run the in-place `edit` → diff → push the resulting delta.
 * Returns the delta recorded (or `null` for a no-op edit). The transient
 * before-snapshot is discarded after the diff, so only the delta is retained.
 */
export function recordEdit(
  history: ClassEditHistory,
  buf: Uint8Array,
  edit: () => void,
): ClassDelta | null {
  const before = buf.slice();
  edit();
  const delta = diffClassification(before, buf);
  if (delta) history.push(delta);
  return delta;
}

/** The cloud surface a recorded class edit reads and moves. */
export interface ClassEditTarget {
  readonly classification?: Uint8Array;
  classMark: ClassMark;
  setClassificationState(state: ClassState, method?: string, before?: Uint8Array): void;
}

const NO_INDICES = new Uint32Array(0);
const NO_CODES = new Uint8Array(0);

/**
 * Record one in-place edit of `cloud`'s classification. `to` marks a
 * whole-scan replace (clear, derive, restore) that also moves the codes'
 * provenance, with `method` naming the classifier behind derived codes. The
 * provenance moves only after `edit` returns, so a throwing edit records
 * nothing; the step keeps the marks before and after so undo and redo move
 * them back exactly. Null without a classification or when nothing changed.
 */
export function recordClassEdit(
  history: ClassEditHistory,
  cloud: ClassEditTarget,
  edit: (buf: Uint8Array) => void,
  to?: ClassState,
  method?: string,
): ClassDelta | null {
  const buf = cloud.classification;
  if (!buf) return null;
  if (!to) return recordEdit(history, buf, () => edit(buf));
  const from = cloud.classMark;
  const before = buf.slice();
  edit(buf);
  cloud.setClassificationState(to, method, before);
  // Recorded even when no code changed (clearing a scan that was already all
  // class 1): the provenance moved, and Undo has to step back over that.
  const delta: ClassDelta = { indices: NO_INDICES, prev: before, next: NO_CODES, prov: [from, cloud.classMark] };
  history.push(delta);
  return delta;
}

/** Undo or redo one recorded edit on `cloud`, codes and provenance together. */
export function stepClassEdit(history: ClassEditHistory, cloud: ClassEditTarget, dir: 'undo' | 'redo'): ClassDelta | null {
  const buf = cloud.classification;
  const d = buf ? history[dir](buf) : null;
  if (d?.prov) cloud.classMark = d.prov[dir === 'undo' ? 0 : 1];
  return d;
}
