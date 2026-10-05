/**
 * terrainAccessExplain.ts — reader-facing sentences built from facts the
 * Terrain Access core already computed: which cost terms drove a route, why
 * no cell was eligible, and what each map bucket means. One label table for
 * the map states, so the legend and the cursor readout use the same words.
 *
 * Pure: no DOM, no three.js. Deterministic.
 */

import { MAP_COST_BUCKETS, type MapCellState, type NodeEligibility } from './traversabilityCost';
import type { CostContributor } from './routeDiagnostics';
import type { NodeBlockReason, TerrainAccessProfile } from './terrainAccessTypes';

/** The one name for each map state, shared by the legend and the cursor readout. */
export const TERRAIN_ACCESS_STATE_LABEL: Readonly<Record<MapCellState, string>> = Object.freeze({
  'low-cost': 'Low cost',
  'moderate-cost': 'Moderate cost',
  'high-cost': 'High cost',
  blocked: 'Blocked',
  unknown: 'No data',
});

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** What the low/moderate/high buckets mean, read from {@link MAP_COST_BUCKETS}. */
export function costBucketNote(): string {
  const low = pct(MAP_COST_BUCKETS.low);
  const moderate = pct(MAP_COST_BUCKETS.moderate);
  return `Cost is a cell's cheapest move, as extra cost over a flat, fully supported move of the same length: `
    + `low up to ${low}, moderate up to ${moderate}, high above ${moderate}.`;
}

/** Plain names for the route cost terms. */
export const COST_TERM_LABEL: Readonly<Record<CostContributor['term'], string>> = Object.freeze({
  'longitudinal-grade': 'grade along the route',
  'cross-slope': 'cross slope',
  ruggedness: 'ruggedness',
  step: 'step height',
  support: 'weak terrain support',
});

/**
 * The one or two terms that explain most of a route's extra cost, from
 * `RouteDiagnostics.dominantCostContributors` (already sorted, largest
 * first). A second term is named only when it adds a non-zero share.
 */
export function costDriversSentence(contributors: readonly CostContributor[]): string {
  const nonZero = contributors.filter((c) => c.total > 0);
  if (nonZero.length === 0) return 'Cost is distance alone: every move was flat and fully supported.';
  const names = nonZero.slice(0, 2).map((c) => COST_TERM_LABEL[c.term]);
  return `Cost driven mostly by: ${names.join(', then ')}.`;
}

const countText = (n: number): string => n.toLocaleString('en-US');

function reasonClause(reason: NodeBlockReason, profile: TerrainAccessProfile, one: boolean): string {
  const be = one ? 'is' : 'are';
  switch (reason) {
    case 'no-data': return one ? 'has no elevation' : 'have no elevation';
    case 'outside-roi': return `${be} outside the region of interest`;
    case 'low-confidence': return `${be} below terrain confidence ${profile.minimumTerrainConfidence}`;
    case 'ruggedness': return `${one ? 'exceeds' : 'exceed'} the ruggedness limit ${profile.maxRuggedness}`;
    case 'obstruction': return `${one ? 'carries' : 'carry'} an above-ground obstruction`;
    case 'vehicle-width': return `${be} too close to a blocked cell for the ${profile.vehicleWidth} m vehicle width`;
  }
}

/**
 * Count `eligibility.reason` across cells and name the most common one with
 * its count, e.g. "12,000 cells are below terrain confidence 50". Null when
 * no cell carries a reason. Ties go to the reason seen first.
 */
export function topBlockReasonSentence(eligibility: NodeEligibility, profile: TerrainAccessProfile): string | null {
  const counts = new Map<NodeBlockReason, number>();
  for (const r of eligibility.reason) {
    if (r == null) continue;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let top: NodeBlockReason | null = null;
  let topCount = 0;
  for (const [reason, n] of counts) {
    if (n > topCount) {
      top = reason;
      topCount = n;
    }
  }
  if (top == null) return null;
  const one = topCount === 1;
  const noun = one ? 'cell' : 'cells';
  return `${countText(topCount)} ${noun} ${reasonClause(top, profile, one)}.`;
}
