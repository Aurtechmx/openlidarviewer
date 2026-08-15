/**
 * FeatureExtractionService.ts — a callable entry over the feature cores.
 *
 * `extractBuildingFootprints` and `fitConductor` are complete, tested pure cores
 * with no caller outside their tests. This service is the product-side entry:
 * it runs them and returns DERIVED CANDIDATES — not "detected buildings" — in a
 * uniform, review-ready shape (stable id, area/span, confidence marked derived)
 * so a candidate-review UI or a DerivedLayer can consume one thing. The evidence
 * language stays deliberately weak: these are candidates until a reviewer or
 * stronger evidence promotes them. Pure: geometry in, candidates out.
 */

import { extractBuildingFootprints, type BuildingPoint, type FootprintGrid } from './buildingFootprints';
import { fitConductor, type Vec3 } from './conductors';

export interface BuildingCandidate {
  readonly id: string;
  readonly kind: 'building';
  readonly confidence: 'derived';
  readonly areaM2: number;
  readonly cellCount: number;
  readonly centroid: readonly [number, number];
  readonly bounds: readonly [number, number, number, number];
}

export interface ConductorCandidate {
  readonly id: string;
  readonly kind: 'conductor';
  readonly confidence: 'derived';
  readonly linearity: number;
  readonly spanM: number;
  readonly sagM: number;
  readonly residualRms: number;
  readonly pointCount: number;
}

/** Extract building footprint candidates from occupied ground-plane points. */
export function extractBuildingCandidates(
  points: readonly BuildingPoint[],
  grid: FootprintGrid,
): BuildingCandidate[] {
  return extractBuildingFootprints(points, grid).map((f, i) => ({
    id: `building-${i + 1}`,
    kind: 'building',
    confidence: 'derived',
    areaM2: f.areaM2,
    cellCount: f.cellCount,
    centroid: [f.centroidX, f.centroidY],
    bounds: [f.minX, f.minY, f.maxX, f.maxY],
  }));
}

/**
 * Fit a single conductor candidate to a set of points, or null when the points
 * are not linear enough to be a conductor span (the core's own gate).
 */
export function extractConductorCandidate(
  points: readonly Vec3[],
  minLinearity = 0.9,
): ConductorCandidate | null {
  const fit = fitConductor(points, minLinearity);
  if (!fit.ok) return null;
  return {
    id: 'conductor-1',
    kind: 'conductor',
    confidence: 'derived',
    linearity: fit.linearity,
    spanM: fit.spanM,
    sagM: fit.sagM,
    residualRms: fit.residualRms,
    pointCount: fit.n,
  };
}
