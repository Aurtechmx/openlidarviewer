/**
 * las14Check.ts — the LAS 1.4 availability check shared by the Export panel
 * and the batch converter.
 *
 * A panel calls `run` whenever the CRS an export would write changes. The
 * check loads `convert/las14Availability` on demand and hands its answer to
 * `apply`: null when LAS 1.4 can carry the CRS, otherwise the reason. Only
 * the latest request's answer is applied, so a slow load cannot overwrite a
 * newer choice. A failed load applies null: the check is a convenience, and
 * the export or the file's row still states the reason.
 */

import type { Las14Request } from '../convert/las14Availability';
import { loadLas14Availability } from '../lazyChunks';

export interface Las14Check {
  /** Check `request`, or clear the block at once when no EPSG code is in play (null). */
  run(request: Las14Request | null): void;
  /** Settles when the latest check has been applied. */
  settled(): Promise<void>;
}

export function createLas14Check(apply: (block: string | null) => void): Las14Check {
  let seq = 0;
  let latest: Promise<void> = Promise.resolve();
  return {
    run(request) {
      const mine = ++seq;
      if (request == null) {
        apply(null);
        latest = Promise.resolve();
        return;
      }
      latest = loadLas14Availability().then(({ las14Availability }) => {
        if (mine !== seq) return;
        const a = las14Availability(request);
        apply(a.ok ? null : a.message);
      }, () => {
        if (mine === seq) apply(null);
      });
    },
    settled: () => latest,
  };
}

/**
 * The format after the LAS 1.4 block changes. A block moves a LAS 1.4 choice
 * to LAS 1.2 and records that it did; clearing the block moves back only a
 * format this rule moved, never one the user picked.
 */
export function formatAfterLas14Block<F extends string>(
  format: F | 'las' | 'las14',
  block: string | null,
  autoSwitched: boolean,
): { format: F | 'las' | 'las14'; autoSwitched: boolean } {
  if (block != null && format === 'las14') return { format: 'las', autoSwitched: true };
  if (block == null && autoSwitched && format === 'las') return { format: 'las14', autoSwitched: false };
  return { format, autoSwitched };
}
