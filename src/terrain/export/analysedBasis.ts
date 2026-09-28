/**
 * analysedBasis.ts — how many points an analysis was built from, of how many
 * the source declares, and under which coverage.
 *
 * A leaf: types and two pure functions, so the app shell can build the basis
 * from the scan facts without loading the terrain-export chunk. The provenance
 * builder stamps it into every artifact and prints one line from it.
 */

import type { Coverage, ScanFacts } from '../../process/ProcessPlan';

export interface AnalysedBasis {
  /** Points the analysis was drawn from (the resident set for a display sample). */
  readonly analysedPointCount: number;
  /** Points the source declares, or null when the source states no total. */
  readonly declaredPointCount: number | null;
  /** The coverage the capability model saw for the same scan. */
  readonly coverage: Coverage;
  /** Decimation stride of a sampled read when the counts resolve one; else null. */
  readonly loadStride: number | null;
  /**
   * The format probe verdict the source was opened at
   * (`PointCloud.metadata.interpretationLevel`); null when the file opened on
   * its signature without a probe. Absent when the producing path did not
   * record it.
   */
  readonly interpretationLevel?: string | null;
  /**
   * Streaming only: points resident when the analysis ran, recorded when the
   * analysed set is a strided subsample of them. Absent otherwise.
   */
  readonly residentPointCount?: number;
}

/**
 * The basis for a scan: the coverage the capability model states, the points
 * the analysis read, and the total the SOURCE declares.
 *
 * `declaredPointCount` is passed separately because `ScanFacts.pointCount` is
 * the count the viewer holds, not the file's record count. On a display sample
 * those differ by the whole point of this line: reading the total off the facts
 * reported "2,899,049 of 2,899,049" for a 47,170,656-point tile, which states
 * nothing. Null when the source declares no total, which stays unstated.
 */
export function analysedBasisOf(
  facts: Pick<ScanFacts, 'coverage' | 'pointCount'>,
  analysedPointCount: number,
  declaredPointCount?: number | null,
  interpretationLevel?: string | null,
  residentPointCount?: number,
): AnalysedBasis {
  const stated = declaredPointCount ?? facts.pointCount;
  const declared = stated != null && Number.isFinite(stated) && stated > 0 ? stated : null;
  let loadStride: number | null = null;
  if (facts.coverage === 'sampled' && declared != null && analysedPointCount > 0 && declared > analysedPointCount) {
    const ratio = declared / analysedPointCount;
    const whole = Math.round(ratio);
    // A decimated read keeps every stride-th point, so the ratio is a whole
    // number up to the rounding of the last partial stride; anything else is
    // not a stride and is not reported as one.
    if (whole >= 2 && Math.abs(ratio - whole) * analysedPointCount <= 1) loadStride = whole;
  }
  return {
    analysedPointCount, declaredPointCount: declared, coverage: facts.coverage, loadStride,
    ...(interpretationLevel !== undefined ? { interpretationLevel } : {}),
    ...(facts.coverage === 'resident-only' && (residentPointCount ?? 0) > analysedPointCount ? { residentPointCount } : {}),
  };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The one sentence every artifact prints for the basis; 'unknown' when none was recorded. */
export function analysedBasisLine(b: AnalysedBasis | null | undefined): string {
  if (!b) return 'unknown';
  const of = b.declaredPointCount != null ? ` of ${fmt(b.declaredPointCount)}` : '';
  if (b.coverage === 'full') return `${fmt(b.analysedPointCount)}${of} points (full read)`;
  const set = 'resident streaming set';
  const r = b.residentPointCount;
  const how = b.coverage === 'resident-only'
    ? (r ? `analysed subsample of the ${set}, ${fmt(r)} resident` : set)
    : `display sample${b.loadStride != null ? `, stride ${b.loadStride}` : ''}`;
  return `${fmt(b.analysedPointCount)}${of} points (${how}); whole-dataset support not claimed`;
}
