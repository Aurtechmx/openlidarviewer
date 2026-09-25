/**
 * withheldCountsJson.ts — reads a stored Withheld record back from a session.
 *
 * Lives beside the session parser rather than in `science/withheldCounts.ts`
 * so the eager shell, which reports counts, does not carry the reader.
 */
import type { WithheldReadCounts } from '../science/withheldCounts';

/**
 * Read {@link WithheldReadCounts} back from untrusted JSON, or `null`.
 *
 * Counts must be non-negative integers and agree with each other; anything
 * else is dropped rather than repaired, so a stored record cannot claim an
 * exclusion it does not add up to.
 */
export function parseWithheldReadCounts(v: unknown): WithheldReadCounts | null {
  if (v === null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
  const { sourcePoints, withheldExcluded, analysedPoints } = r;
  if (!count(sourcePoints) || !count(analysedPoints) || analysedPoints > sourcePoints) return null;
  if (withheldExcluded === 'unknown') return { sourcePoints, withheldExcluded, analysedPoints };
  if (!count(withheldExcluded) || withheldExcluded + analysedPoints !== sourcePoints) return null;
  return { sourcePoints, withheldExcluded, analysedPoints };
}
