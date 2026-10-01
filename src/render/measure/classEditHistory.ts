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
 * Pure data. The Viewer owns the live `Uint8Array` classification buffer and
 * calls these helpers to capture an edit and to replay prev/next on undo/redo.
 */

import type { ClassState } from '../../model/PointCloud';

/** The points one edit changed: parallel arrays, all the same length. */
export interface ClassDelta {
  /** Indices of the points whose class changed. */
  readonly indices: Uint32Array;
  /** Class code BEFORE the edit, aligned to {@link indices}. */
  readonly prev: Uint8Array;
  /** Class code AFTER the edit, aligned to {@link indices}. */
  readonly next: Uint8Array;
  /**
   * Provenance before and after, for a whole-scan edit (clear, derive,
   * restore) that also moves where the codes came from. Undo restores [0],
   * redo re-applies [1].
   */
  readonly prov?: readonly [ClassState, ClassState];
}

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
  const src = dir === 'undo' ? delta.prev : delta.next;
  const idx = delta.indices;
  for (let i = 0; i < idx.length; i++) buf[idx[i]] = src[i];
}

/**
 * A bounded undo/redo stack of classification deltas for one cloud. Pushing a
 * new edit clears the redo branch (standard linear-history semantics); the
 * oldest edit is evicted once `limit` is exceeded.
 */
export class ClassEditHistory {
  private readonly _undo: ClassDelta[] = [];
  private readonly _redo: ClassDelta[] = [];
  private readonly _limit: number;

  constructor(limit = 50) {
    this._limit = Math.max(1, Math.floor(limit));
  }

  /** Record a committed edit. Clears the redo branch. */
  push(delta: ClassDelta): void {
    this._undo.push(delta);
    if (this._undo.length > this._limit) this._undo.shift();
    this._redo.length = 0;
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
  prov?: readonly [ClassState, ClassState],
): ClassDelta | null {
  const before = buf.slice();
  edit();
  let delta = diffClassification(before, buf);
  // A provenance move is an edit even when no code changed (clearing a scan
  // that was already all class 1), so Undo can still step back over it.
  if (prov) delta = { ...(delta ?? { indices: new Uint32Array(0), prev: new Uint8Array(0), next: new Uint8Array(0) }), prov };
  if (delta) history.push(delta);
  return delta;
}

/** The cloud surface a recorded class edit reads and moves. */
export interface ClassEditTarget {
  readonly classification?: Uint8Array;
  readonly classificationProvenance: ClassState | 'none';
  setClassificationState(state: ClassState): void;
}

/**
 * Record one in-place edit of `cloud`'s classification. `to` marks a
 * whole-scan replace (clear, derive, restore) that also moves the codes'
 * provenance, recorded on the delta so undo/redo move it back exactly.
 * Null without a classification or when nothing changed.
 */
export function recordClassEdit(
  history: ClassEditHistory,
  cloud: ClassEditTarget,
  edit: (buf: Uint8Array) => void,
  to?: ClassState,
): ClassDelta | null {
  const buf = cloud.classification;
  if (!buf) return null;
  const from = cloud.classificationProvenance as ClassState;
  // Moved BEFORE the edit: the first move off the source keeps a copy of the
  // codes as they are now, which the edit is about to overwrite.
  if (to) cloud.setClassificationState(to);
  return recordEdit(history, buf, () => edit(buf), to && [from, to]);
}

/** Undo or redo one recorded edit on `cloud`, codes and provenance together. */
export function stepClassEdit(history: ClassEditHistory, cloud: ClassEditTarget, dir: 'undo' | 'redo'): ClassDelta | null {
  const buf = cloud.classification;
  const d = buf ? history[dir](buf) : null;
  if (d?.prov) cloud.setClassificationState(d.prov[dir === 'undo' ? 0 : 1]);
  return d;
}
