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
  /**
   * Points left out of the analysed set because they are flagged Withheld.
   * Absent when none were. They are accounted for, not missing.
   */
  readonly withheldExcludedCount?: number;
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
  withheldExcludedCount?: number,
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
    ...((withheldExcludedCount ?? 0) > 0 ? { withheldExcludedCount } : {}),
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
  const how = b.coverage === 'partial' ? 'truncated file' : b.coverage === 'resident-only'
    ? (r ? `analysed subsample of the ${set}, ${fmt(r)} resident` : set)
    : `display sample${b.loadStride != null ? `, stride ${b.loadStride}` : ''}`;
  return `${fmt(b.analysedPointCount)}${of} points (${how}); whole-dataset support not claimed`;
}

/**
 * Whether the analysed points are a sample of the source: a coverage other
 * than a full read, or points missing for a reason other than Withheld
 * exclusion (analysed plus Withheld-excluded is fewer than the source
 * declares). A null basis states nothing and is not treated as a sample.
 */
export function isSampledBasis(b: AnalysedBasis | null | undefined): boolean {
  if (!b) return false;
  if (b.coverage !== 'full') return true;
  return b.declaredPointCount != null
    && b.analysedPointCount + (b.withheldExcludedCount ?? 0) < b.declaredPointCount;
}

/**
 * The one decision on whether a USGS density reference floor may be printed:
 * the strongest floor cleared, or null when the figure is on a sample (the
 * grid reports a sampled extent, or the analysed basis is not a full read).
 * The panel, the fitness badge, the sheet and the provenance all print this.
 */
export function densityReferenceFloorFor(
  floors: readonly string[] | null | undefined,
  basis: AnalysedBasis | null | undefined,
  coverageMode?: string | null,
): string | null {
  if (coverageMode === 'sampled' || isSampledBasis(basis)) return null;
  return floors?.[0] ?? null;
}

/** Shown in place of the density reference when the figure is on a sample. */
export const DENSITY_REF_SAMPLE_NOTE = 'not stated on a sample';

/** Status shown when the terrain surface was rebuilt from a Withheld-aware re-decode of the source. */
export const WITHHELD_RECOVERY_STATUS =
  'Points flagged Withheld were excluded from this surface. The display was reduced to fit the point budget, '
  + 'so the surface was rebuilt by re-decoding the source file at that budget and taking every Nth point. '
  + 'It is still a sample of the points, not every point.';
