/**
 * classificationFilter.ts
 *
 * Drop already-classified non-ground returns (vegetation, buildings, noise)
 * before the ground filter runs, so the bare-earth DTM — and the contours
 * built from it — never anchor to canopy or rooftops. This honours the
 * classification a survey already carries (or that the user has assigned with
 * the lasso editor) instead of trusting the algorithm blind; SMRF then refines
 * the remainder.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainPoint } from '../TerrainContracts';

/**
 * ASPRS classes removed before ground filtering by default:
 *   3 low vegetation · 4 medium vegetation · 5 high vegetation
 *   6 building
 *   7 low noise · 18 high noise
 * Everything else — including 0/1 unclassified, 2 ground and 9 water — is kept
 * for SMRF to decide. (255 is the "no class channel" sentinel; never excluded.)
 */
export const NON_GROUND_CLASSES: readonly number[] = [3, 4, 5, 6, 7, 18];

export interface ClassificationFilterResult {
  /** The kept points (a new array; input is not mutated). */
  readonly points: TerrainPoint[];
  /** How many points were dropped. */
  readonly excludedCount: number;
  /** Count dropped per ASPRS class, for an honest summary. */
  readonly byClass: Readonly<Record<number, number>>;
}

/**
 * Keep every point whose classification is NOT in `excluded`. When no
 * classification is supplied, or it is not index-aligned with `points`,
 * everything is kept (the caller's behaviour is unchanged).
 */
export function excludeNonGroundClasses(
  points: ReadonlyArray<TerrainPoint>,
  classification: ReadonlyArray<number> | Uint8Array | null | undefined,
  excluded: ReadonlyArray<number> = NON_GROUND_CLASSES,
): ClassificationFilterResult {
  if (!classification || classification.length !== points.length || excluded.length === 0) {
    return { points: points.slice(), excludedCount: 0, byClass: {} };
  }
  const drop = new Set(excluded);
  const kept: TerrainPoint[] = [];
  const byClass: Record<number, number> = {};
  let excludedCount = 0;
  for (let i = 0; i < points.length; i++) {
    const c = classification[i];
    if (drop.has(c)) {
      excludedCount++;
      byClass[c] = (byClass[c] ?? 0) + 1;
    } else {
      kept.push(points[i]);
    }
  }
  return { points: kept, excludedCount, byClass };
}
