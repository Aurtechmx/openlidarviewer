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
 * Pure data — the comparison plus the refusal wording. No DOM, no I/O.
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
