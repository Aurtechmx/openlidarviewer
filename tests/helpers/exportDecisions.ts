/**
 * exportDecisions.ts — granted export decisions for tests that build one by hand.
 *
 * A decision states the claim set it was granted over, so every literal repeats
 * the same four fields. These builders keep the repetition in one place and
 * name the two constituent sets the shipping artifacts carry: a contour
 * deliverable holds the geometry and the surface it was cut from, a DTM raster
 * holds the surface alone.
 */

import type { ScientificExportDecision } from '../../src/export/exportManifest';

/** What a contour deliverable contains: the geometry and the grid under it. */
export const CONTOUR_CLAIMS: readonly string[] = ['CONTOURS', 'DTM'];
/** What a bare-earth raster contains. */
export const DTM_CLAIMS: readonly string[] = ['DTM'];

export function validatedDecision(
  claimIds: readonly string[] = CONTOUR_CLAIMS,
  caveats: readonly string[] = [],
): ScientificExportDecision {
  return { status: 'validated', badge: 'Internal validation', caveats, claimIds };
}

export function exploratoryDecision(
  claimIds: readonly string[] = CONTOUR_CLAIMS,
  caveats: readonly string[] = [],
): ScientificExportDecision {
  return { status: 'exploratory', badge: 'Exploratory', watermark: 'EXPLORATORY', caveats, claimIds };
}
