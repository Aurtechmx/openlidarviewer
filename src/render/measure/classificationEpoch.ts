/**
 * classificationEpoch.ts
 *
 * Honesty guard for manual classification editing.
 *
 * A manual reclassification silently changes every downstream number that reads
 * the class channel — terrain analysis, the full-cloud grade, derived-class
 * exports. If those results stay on screen looking current after an edit, the
 * tool is quietly lying. This tracks a per-cloud edit EPOCH: every class edit
 * (swap, polygon reclassify, undo, redo) bumps it. A derived result stamps the
 * epoch it was computed at; later, `isStale` reports whether a class edit has
 * invalidated it, so the caller can recompute it or caveat it ("based on an
 * edited classification") instead of presenting it as fresh.
 *
 * The stamp is also a portable provenance token: a report can record "grade
 * computed at classification epoch 3" and prove, later, whether the cloud has
 * been edited since.
 *
 * Pure data. The Viewer owns the live classification buffers and bumps the
 * epoch on each edit; analysis/report code stamps and checks.
 */

export class ClassificationEpochs {
  private readonly _epoch = new Map<string, number>();

  /** The cloud's current edit epoch (0 = never edited). */
  current(id: string): number {
    return this._epoch.get(id) ?? 0;
  }

  /** Record a classification edit on the cloud; returns the new epoch. */
  bump(id: string): number {
    const next = this.current(id) + 1;
    this._epoch.set(id, next);
    return next;
  }

  /**
   * Whether a result stamped at `stampedEpoch` has been invalidated by a later
   * edit. A result computed at the cloud's current epoch is fresh; once the
   * cloud advances past it, the result is stale.
   */
  isStale(id: string, stampedEpoch: number): boolean {
    return this.current(id) > stampedEpoch;
  }

  /** Forget a cloud's epoch (on removal) so the map doesn't leak. */
  forget(id: string): void {
    this._epoch.delete(id);
  }

  clear(): void {
    this._epoch.clear();
  }
}
