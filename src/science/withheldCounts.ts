/**
 * withheldCounts.ts — how a consumer states what the Withheld exclusion did.
 *
 * `withheldPolicy.ts` decides which points a computation reads; this is the
 * record a result carries of that decision: points offered, Withheld left
 * out, points read. Kept apart from the policy so a consumer in the eager
 * shell can report counts without pulling the policy's other helpers in.
 *
 * Pure: no DOM, no cloud.
 */
/**
 * A flags channel, or `undefined` when there is none a caller can index.
 *
 * A channel whose length disagrees with the point count describes some other
 * set of points (the terrain gather applies the same rule), so it is treated
 * as absent rather than read with a shifted index.
 */
export function alignedFlags(
  flags: ArrayLike<number> | null | undefined,
  pointCount: number,
): ArrayLike<number> | undefined {
  return flags != null && flags.length === pointCount ? flags : undefined;
}

/**
 * What a consumer read, with the Withheld exclusion accounted for.
 *
 * `withheldExcluded` is `'unknown'` whenever any source the consumer read had
 * no flags channel: a voxel-reduced cloud, a decoder that never produced
 * flags. Zero would say "there were none", which nobody checked. The points
 * that WERE flagged are still excluded; `analysedPoints` is always the exact
 * count the computation read.
 */
export interface WithheldReadCounts {
  /** Points offered to the consumer before the exclusion. */
  readonly sourcePoints: number;
  /** Withheld points left out, or 'unknown' when flags were missing on a source. */
  readonly withheldExcluded: number | 'unknown';
  /** Points the computation read. */
  readonly analysedPoints: number;
}

/** Assemble {@link WithheldReadCounts} from a walk's tallies. */
export function withheldReadCounts(
  sourcePoints: number,
  excluded: number,
  everySourceFlagged: boolean,
): WithheldReadCounts {
  return {
    sourcePoints,
    withheldExcluded: everySourceFlagged ? excluded : 'unknown',
    analysedPoints: sourcePoints - excluded,
  };
}

/** One line for a report row or a CSV/PDF provenance field. */
export function describeWithheldRead(c: WithheldReadCounts): string {
  const excluded =
    c.withheldExcluded === 'unknown' ? 'unknown (no flags on a source)' : String(c.withheldExcluded);
  return `${c.analysedPoints} of ${c.sourcePoints} analysed; Withheld excluded: ${excluded}`;
}

