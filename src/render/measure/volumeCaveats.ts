/**
 * volumeCaveats.ts
 *
 * The clauses a volume figure must carry wherever it is printed: the live
 * measurement headline and the PDF report row build them here, so a figure
 * integrated over part of its footprint, or a preview, or a withheld result,
 * reads with the same caveats on every surface.
 *
 * Pure — no DOM, no three.js, no unit formatting of its own (the caller
 * passes its volume formatter for the cross-check figure).
 */

import { noiseExcludedClause } from '../../terrain/ground/classificationFilter';
import { reducedSampleClause, type VolumeRecord } from './types';

/** Interpolated share above which a volume figure is low confidence. */
export const LOW_CONFIDENCE_INTERPOLATED_FRACTION = 0.25;
/** Left-out share below which the "outside scan" clause is not shown. */
const EXCLUDED_FRACTION_SHOWN = 0.005;

/**
 * The caveat clauses that follow a volume's fill / cut / net figures, in the
 * headline's order: interpolated share (and low confidence), the share left
 * out as outside the scan, PREVIEW (with its reason when one is stated),
 * noise points excluded, and the reduced-sample notice. Empty clauses are
 * dropped; join with " · ".
 */
export function volumeCaveatClauses(v: VolumeRecord): string[] {
  const out: string[] = [];
  if (v.interpolatedFraction !== undefined) {
    out.push(`${(v.interpolatedFraction * 100).toFixed(0)}% interpolated` +
      (v.interpolatedFraction > LOW_CONFIDENCE_INTERPOLATED_FRACTION ? ' (low confidence)' : ''));
    if (v.excludedFraction !== undefined && v.excludedFraction > EXCLUDED_FRACTION_SHOWN) {
      out.push(`${(v.excludedFraction * 100).toFixed(0)}% outside scan, left out`);
    }
  }
  if (v.gridAuthority === 'preview') {
    out.push(v.gridAuthorityReason ? `PREVIEW (${v.gridAuthorityReason})` : 'PREVIEW');
  }
  const noise = noiseExcludedClause(v.withheld?.noiseExcluded);
  if (noise) out.push(noise);
  const reduced = reducedSampleClause(v.withheld);
  if (reduced) out.push(reduced);
  return out;
}

/** True when the record carries no fill / cut / net (a withheld grid figure). */
export function volumeFiguresWithheld(v: VolumeRecord): boolean {
  return v.fill === undefined || v.cut === undefined || v.net === undefined;
}

/**
 * The text that stands in for fill / cut / net when they are withheld: the
 * reason, and the point-sample cross-check when the record kept one.
 * `fmtVolume` formats a native-unit volume (render units³) for display.
 */
export function volumeWithheldClause(v: VolumeRecord, fmtVolume: (renderUnitsCubed: number) => string): string {
  const cc = v.crossCheck;
  const reason = v.gridAuthorityReason ? ` (${v.gridAuthorityReason})` : '';
  return `${cc ? 'grid ' : ''}volume withheld${reason}` +
    (cc ? ` · cut-fill cross-check net ${fmtVolume(Math.abs(cc.net))} ${cc.net < 0 ? 'cut' : 'fill'}` : '');
}
