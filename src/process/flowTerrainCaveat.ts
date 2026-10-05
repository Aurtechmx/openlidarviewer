/**
 * flowTerrainCaveat.ts
 *
 * Whether the terrain run behind a Flow Pulse result is usable, in the words
 * the Lab banner, the readiness checklist and the export README share. The
 * terrain quality gate's surface verdict decides it: a Blocked or Preview
 * surface still routes, but the result is an illustration, not a reading of
 * the ground. Pure and DOM-free.
 */

import type { DtmReadiness } from '../terrain/quality/dtmQualityGate';

/** The banner's lead sentence, shown above the Flow Pulse result card. */
export const FLOW_TERRAIN_BANNER = 'Terrain run not usable: read this as illustration only';

export interface FlowTerrainCaveat {
  /** The terrain quality gate's surface verdict, as the app names it. */
  readonly verdict: 'Blocked' | 'Preview';
  /** Interpolated cells as a whole-number percent of the covered surface. */
  readonly interpolatedPercent: number;
}

/** The two quality facts the caveat reads; `AnalyseContoursResult['quality']` carries both. */
export interface FlowTerrainQuality {
  readonly readiness: DtmReadiness;
  readonly interpolatedOfSurfaceRatio: number;
}

/** The caveat for a Blocked or Preview surface, or null for a ready one or none. */
export function flowTerrainCaveat(quality: FlowTerrainQuality | null | undefined): FlowTerrainCaveat | null {
  if (!quality || quality.readiness === 'ready') return null;
  const ratio = Number.isFinite(quality.interpolatedOfSurfaceRatio) ? quality.interpolatedOfSurfaceRatio : 0;
  return {
    verdict: quality.readiness === 'blocked' ? 'Blocked' : 'Preview',
    interpolatedPercent: Math.round(Math.min(1, Math.max(0, ratio)) * 100),
  };
}

/** The interpolated share as one clause, e.g. "99% of the ground surface is interpolated". */
export function interpolatedShareText(caveat: FlowTerrainCaveat): string {
  return `${caveat.interpolatedPercent}% of the ground surface is interpolated, not measured`;
}

/** The banner's full text: the lead sentence, the verdict and the interpolated share. */
export function flowTerrainBannerText(caveat: FlowTerrainCaveat): string {
  return `${FLOW_TERRAIN_BANNER}. Terrain verdict: ${caveat.verdict}; ${interpolatedShareText(caveat)}.`;
}
