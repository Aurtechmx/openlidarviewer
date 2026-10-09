import type { SpatialBlockResult } from './spatialBlockHoldout';

const REASON_TEXT = {
  'one-scored-block': 'only one block was scored',
  'bootstrap-disabled': 'the bootstrap was disabled',
  'no-residuals': 'no held-out points were scored',
} as const;

/**
 * The confidence-interval clause for a blocked hold-out RMSE, shown beside the
 * point RMSE. Returns the interval when one was computed, and an explicit
 * unavailable statement (with the reason) otherwise, so no endpoints are ever
 * printed for an interval that was not computed.
 */
export function blockedCiClause(
  blk: Pick<SpatialBlockResult, 'ciStatus' | 'ciUnavailableReason' | 'ciLow' | 'ciHigh' | 'ciLevel'>,
  fmt: (x: number) => string,
  sep = '-',
): string {
  if (blk.ciStatus === 'computed' && blk.ciLow !== null && blk.ciHigh !== null) {
    return `${Math.round(blk.ciLevel * 100)}% CI ${fmt(blk.ciLow)}${sep}${fmt(blk.ciHigh)}`;
  }
  const why = REASON_TEXT[blk.ciUnavailableReason ?? 'no-residuals'];
  return `Confidence interval unavailable: ${why}`;
}
