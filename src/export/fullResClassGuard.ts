/**
 * fullResClassGuard.ts
 *
 * Refuse — rather than silently discard — a full-resolution export that would
 * drop in-session classification edits.
 *
 * Manual reclassification (swap / polygon / lasso) is applied to the LOADED,
 * display-resolution cloud and recorded by DISPLAY-POINT INDEX (see
 * classificationEditor.ts / classEditHistory.ts). A full-resolution export does
 * not convert that edited buffer: it re-decodes the original file from scratch
 * (decodeFull.ts / convertRunner.ts), so every edit is absent from the output.
 *
 * The display cloud is a stratified, jittered subsample of the source
 * (loadStride; see strideSample.ts), and the loader compacts out non-finite
 * points in sanitizeCloud.ts AFTER decoding. Because the display cloud carries
 * no stable source-record index, a display index cannot be mapped back to its
 * source record once any point has been excluded — and the audit forbids
 * substituting a coordinate-proximity remapping for that lost identity
 * (duplicate coordinates would make it ambiguous). Since an exact index
 * identity cannot be proven, the honest behaviour is to REFUSE the lossy
 * export and steer the user to the two paths that keep every edit:
 *
 *   1. Untick "convert at full resolution" — export the edited display cloud.
 *   2. Untick "Include classification" — export the full scan without classes.
 *
 * Pure data. No DOM, no three.js, no I/O — unit-tested in Node and shared by
 * the live export summary (exportSummary.ts) and the Export panel's write gate.
 */

/** The three facts that decide whether a full-res export is lossy. */
export interface FullResClassExportInput {
  /** User asked to convert at full resolution (re-decode the source). */
  readonly fullRes: boolean;
  /** The export will write the classification channel. */
  readonly includeClassification: boolean;
  /** The active cloud has in-session classification edits (display buffer). */
  readonly hasClassEdits: boolean;
}

/** Whether this exact combination would silently drop in-session class edits. */
export function fullResWouldDropClassEdits(input: FullResClassExportInput): boolean {
  return input.fullRes && input.includeClassification && input.hasClassEdits;
}

/**
 * The refusal wording. Names the real consequence and both lossless escapes;
 * never blames the user. Shared verbatim by the summary line and the panel so
 * the preview and the enforcement always say the same thing.
 */
export const FULL_RES_CLASS_EDITS_REFUSAL =
  'Full-resolution export re-decodes the original file and cannot carry your ' +
  'in-session classification edits. Untick "convert at full resolution" to ' +
  'export them at display resolution, or untick "Include classification" to ' +
  'export the full scan without them.';

/** A full-res export decision: allowed, or refused with a reason. */
export interface FullResClassExportDecision {
  readonly allowed: boolean;
  /** Present only when refused — the honest, actionable explanation. */
  readonly reason?: string;
}

/**
 * Decide whether a full-resolution export may proceed. Refused only for the
 * one lossy combination (full-res + classification + edits); every other
 * combination is allowed unchanged.
 */
export function evaluateFullResClassExport(
  input: FullResClassExportInput,
): FullResClassExportDecision {
  return fullResWouldDropClassEdits(input)
    ? { allowed: false, reason: FULL_RES_CLASS_EDITS_REFUSAL }
    : { allowed: true };
}
