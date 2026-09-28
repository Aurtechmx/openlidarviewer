/**
 * analysisRowsFeed.ts — the last Analyse home statuses, published where they
 * are computed.
 *
 * `analysisRows` runs in the Analyse home's `refresh()` whenever Process
 * Studio or a panel changes. The home publishes each result here unchanged, so
 * a reader outside the home (the state strip's review count) reads the same
 * rows instead of computing them a second time.
 */

import type { AnalysisRow } from './analysisStatus';

let last: readonly AnalysisRow[] = [];
const listeners = new Set<() => void>();

/** Record the rows the home just computed. */
export function publishAnalysisRows(rows: readonly AnalysisRow[]): void {
  last = rows;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A failing reader never breaks the home's refresh.
    }
  }
}

/** The rows last published, or none before the home first refreshed. */
export function lastAnalysisRows(): readonly AnalysisRow[] {
  return last;
}

export function subscribeAnalysisRows(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
