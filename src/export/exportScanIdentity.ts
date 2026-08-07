/**
 * exportScanIdentity.ts
 *
 * The identity check every export owes the user: the file that lands in
 * Downloads has to describe the scan the export was asked for.
 *
 * An export is not instantaneous. A full-resolution re-decode runs off-thread
 * for seconds, a contour regeneration rebuilds geometry, and even a "warm" lazy
 * `import()` yields the event loop. Nothing is disabled while that happens, so
 * the user can open another scan — or reclassify points — in the gap between
 * "what am I exporting" and "write the bytes". Every input read AFTER that gap
 * belongs to whatever is active now: the world origin, the CRS, the filename
 * stem. Pair those with geometry captured before it and the file is internally
 * inconsistent while reporting success.
 *
 * The codebase already answers this for async analysis: openScan.ts captures a
 * target id before its first await and drops the result when `activeId` moved
 * (openScan.ts:361), and terrainAnalysisRunner.ts re-checks the same id after
 * every await (terrainAnalysisRunner.ts:333-335). This is that rule carried to
 * the export boundary — capture the target before the first await, compare
 * before writing, and refuse rather than ship a file whose provenance is a
 * guess.
 *
 * KNOWN REACH: a streaming scan reports a null id, so swapping one streaming
 * scan for another is invisible to this comparison. That is the same blind spot
 * the runner's stale guard has, because both read the same shell identity;
 * closing it means giving streaming scans a stable id in the shell, which is a
 * change to the shell rather than to this rule.
 *
 * Effect-free: the comparison, the refusal wording, and the shared
 * load-snapshot-verify-write flow every scan-scoped export follows. Every side
 * effect is injected by the caller, so this module itself does no DOM, no I/O.
 */

/**
 * Whether two readings of "which scan is this" name the same target.
 *
 * A null id is a value, not "unknown" — the shell reports null for a streaming
 * scan, and that is the identity the terrain runner's own guard compares. If
 * null were treated as a wildcard the check would fail OPEN on exactly the path
 * where a mismatch is hardest to see, so null matches only null.
 */
export function sameExportTarget(a: string | null, b: string | null): boolean {
  return a === b;
}

/**
 * Refusal for a point-cloud export whose scan was swapped mid-flight. Names the
 * consequence (a file stamped with the wrong scan's frame) and the way forward,
 * in the voice of the full-res classification refusal it sits next to.
 */
export const EXPORT_SCAN_CHANGED_REFUSAL =
  'The active scan changed while this export was being prepared, so nothing was '
  + 'written — the file would have carried one scan\'s points under another scan\'s '
  + 'coordinate system and name. Select the scan you want and export again.';

/**
 * Refusal for a terrain deliverable built from an analysis that belongs to a
 * scan which is no longer active. Distinct wording from the mid-export race
 * above because this one is not a race at all: the result simply outlived its
 * scan (an additive open never clears it), so the user needs to re-run rather
 * than retry.
 */
export const TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL =
  'This terrain analysis was computed on a different scan than the one now '
  + 'active, so nothing was written — the contours, rasters and report would have '
  + 'been stamped with the active scan\'s origin, coordinate system and name. '
  + 'Re-run the analysis on this scan to export it.';

/**
 * Refusal for a `.olvsession` export whose active scan was swapped while the
 * session writer was loading. A session file embeds the scan's summary, origin,
 * CRS and unit alongside the measurements, annotations and saved views, so a
 * mid-load swap would pair one scan's coordinate frame with another scan's
 * contents. Non-alarming: nothing is lost, the user re-exports on the scan they
 * meant. Kept free of an em dash so it reads plainly at any width.
 */
export const SESSION_EXPORT_SCAN_CHANGED_REFUSAL =
  'The active scan changed while the session was being prepared, so it was not '
  + 'saved. The file would have paired one scan\'s coordinate frame with another '
  + 'scan\'s measurements and views. Select the scan you want and export the '
  + 'session again.';

/**
 * The moving parts of a scan-scoped export, injected so the load-then-snapshot
 * ordering and the identity backstop can be exercised in a Node test without the
 * shell. `D` is whatever {@link ScanScopedExportIo.load} resolves to (a bundle
 * of lazily imported writers), handed straight to {@link ScanScopedExportIo.serialize}.
 */
export interface ScanScopedExportIo<D> {
  /** The active scan id sampled when the export was requested (null = streaming). */
  readonly requestedScanId: string | null;
  /** Load the lazy writer(s). Runs to completion BEFORE the snapshot is taken. */
  load(): Promise<D>;
  /** Read ONE coherent snapshot of scan/viewer state and serialise it. No await inside. */
  serialize(deps: D): string;
  /** The active scan id now, re-read after serialising and before the write. */
  activeScanId(): string | null;
  /** Commit the serialised text (e.g. trigger the download). */
  write(text: string): void;
  /** Tell the user the export was refused. Called instead of {@link write} on a swap. */
  refuse(): void;
}

/**
 * Load the lazy dependencies first, let the caller take one coherent snapshot and
 * serialise it with no await in between, then write only when the scan the export
 * was requested for is still active. A scan opened while the writer loaded is
 * refused rather than written, so the file can never splice two scans. Returns
 * after the write OR the refusal, never both.
 */
export async function writeScanScopedExport<D>(io: ScanScopedExportIo<D>): Promise<void> {
  const deps = await io.load();
  const text = io.serialize(deps);
  if (!sameExportTarget(io.activeScanId(), io.requestedScanId)) {
    io.refuse();
    return;
  }
  io.write(text);
}
