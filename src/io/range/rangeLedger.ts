/**
 * rangeLedger.ts
 *
 * A byte ledger for ranged reads: it remembers which `[offset, offset + length)`
 * spans of a source were asked for, so a load can report how much it requested
 * and how much of the file that actually covers. Requesting the same span twice
 * counts twice against `requestedBytes` and once against `uniqueBytes`, and the
 * difference is the re-read.
 *
 * Pure: no DOM, no three.js, unit-tested in Node.
 */

/** What a ledger has seen so far. */
export interface RangeLedgerTotals {
  /** Calls to {@link RangeLedger.record}, including empty ones. */
  readonly requests: number;
  /** Sum of the requested lengths, re-reads included. */
  readonly requestedBytes: number;
  /** Bytes covered by the union of the requested spans, each counted once. */
  readonly uniqueBytes: number;
}

/** Records requested byte spans and reports their sum and their union. */
export interface RangeLedger {
  /** Note one requested span. Negative, non-finite, or empty spans add no bytes. */
  record(offset: number, length: number): void;
  /** Sum and union of everything recorded so far. */
  totals(): RangeLedgerTotals;
}

/**
 * Create an empty ledger. Recording is O(1); `totals()` sorts and merges the
 * recorded spans, so a report costs O(n log n) in the number of reads.
 */
export function createRangeLedger(): RangeLedger {
  const starts: number[] = [];
  const ends: number[] = [];
  let requests = 0;
  let requestedBytes = 0;

  return {
    record(offset: number, length: number): void {
      requests++;
      if (!Number.isFinite(offset) || !Number.isFinite(length)) return;
      if (offset < 0 || length <= 0) return;
      requestedBytes += length;
      starts.push(offset);
      ends.push(offset + length);
    },
    totals(): RangeLedgerTotals {
      const order = starts.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
      let uniqueBytes = 0;
      let openStart = 0;
      let openEnd = -1;
      for (const i of order) {
        if (openEnd < 0) {
          openStart = starts[i];
          openEnd = ends[i];
          continue;
        }
        // Sorted by start, so a span either extends the open run (overlapping
        // or exactly adjacent) or begins a new one.
        if (starts[i] <= openEnd) {
          if (ends[i] > openEnd) openEnd = ends[i];
          continue;
        }
        uniqueBytes += openEnd - openStart;
        openStart = starts[i];
        openEnd = ends[i];
      }
      if (openEnd >= 0) uniqueBytes += openEnd - openStart;
      return { requests, requestedBytes, uniqueBytes };
    },
  };
}
