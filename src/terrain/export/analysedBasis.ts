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
}

/** The basis for a scan as the capability model states it and the gather counted it. */
export function analysedBasisOf(facts: Pick<ScanFacts, 'coverage' | 'pointCount'>, analysedPointCount: number): AnalysedBasis {
  const declared = facts.pointCount != null && Number.isFinite(facts.pointCount) && facts.pointCount > 0 ? facts.pointCount : null;
  let loadStride: number | null = null;
  if (facts.coverage === 'sampled' && declared != null && analysedPointCount > 0) {
    const ratio = declared / analysedPointCount;
    const whole = Math.round(ratio);
    // A decimated read keeps every stride-th point, so the ratio is a whole
    // number up to the rounding of the last partial stride; anything else is
    // not a stride and is not reported as one.
    if (whole >= 2 && Math.abs(ratio - whole) * analysedPointCount <= 1) loadStride = whole;
  }
  return { analysedPointCount, declaredPointCount: declared, coverage: facts.coverage, loadStride };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The one sentence every artifact prints for the basis; 'unknown' when none was recorded. */
export function analysedBasisLine(b: AnalysedBasis | null | undefined): string {
  if (!b) return 'unknown';
  const of = b.declaredPointCount != null ? ` of ${fmt(b.declaredPointCount)}` : '';
  if (b.coverage === 'full') return `${fmt(b.analysedPointCount)}${of} points (full read)`;
  if (b.coverage === 'resident-only') {
    return `${fmt(b.analysedPointCount)}${of} points (resident streaming set); whole-dataset support not claimed`;
  }
  const stride = b.loadStride != null ? `, stride ${b.loadStride}` : '';
  return `${fmt(b.analysedPointCount)}${of} points (display sample${stride}); whole-dataset support not claimed`;
}
