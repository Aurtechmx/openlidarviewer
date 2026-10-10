/**
 * withheldCountsJson.ts — reads a stored Withheld record back from a session.
 *
 * Lives beside the session parser rather than in `science/withheldCounts.ts`
 * so the eager shell, which reports counts, does not carry the reader.
 */
import type { SourceReduction, WithheldReadCounts } from '../science/withheldCounts';

/** Read a stored source reduction back, or `undefined` when it is not usable. */
export function parseSourceReduction(v: unknown): SourceReduction | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const { mode, resident, declared } = v as Record<string, unknown>;
  if (mode !== 'voxel-centroids' && mode !== 'strided-records') return undefined;
  if (!Number.isSafeInteger(resident) || !Number.isSafeInteger(declared)) return undefined;
  if ((resident as number) < 0 || (declared as number) < 0) return undefined;
  // A reduction holds fewer points than the file declared, never more.
  if ((resident as number) > (declared as number)) return undefined;
  const { reducedSources, totalSources } = v as Record<string, unknown>;
  const mixed =
    Number.isSafeInteger(reducedSources) && Number.isSafeInteger(totalSources) &&
    (reducedSources as number) >= 1 && (reducedSources as number) < (totalSources as number)
      ? { reducedSources: reducedSources as number, totalSources: totalSources as number }
      : {};
  return { mode, resident: resident as number, declared: declared as number, ...mixed };
}

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
  const reduction = parseSourceReduction(r.reduction);
  const tail = reduction ? { reduction } : {};
  if (withheldExcluded === 'unknown') return { sourcePoints, withheldExcluded, analysedPoints, ...tail };
  if (!count(withheldExcluded) || withheldExcluded + analysedPoints !== sourcePoints) return null;
  return { sourcePoints, withheldExcluded, analysedPoints, ...tail };
}
