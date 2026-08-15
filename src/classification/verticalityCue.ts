/**
 * verticalityCue.ts — a structural cue for the classifier, from the geometry
 * descriptors it already computes elsewhere but does not yet use.
 *
 * The frozen corpus shows the classifier confuses walls with vegetation
 * (walls-roofs macro-F1 ≈ 0.33) because it reads structure from per-cell
 * roughness, which cannot tell a planar wall from a rough bush. The eigen
 * descriptors in `geometryDescriptors` already separate them: a planar
 * neighbourhood that is near-vertical is a wall face, a planar near-horizontal
 * one is a roof or ground, and a low-planarity high-sphericity one scatters like
 * foliage. This turns those descriptors into a discrete label for an ambiguous
 * elevated point, so a caller computes it only where it matters (not per point).
 * Pure: descriptors in, a label out.
 */

import { descriptorsForNeighborhood, type GeoDescriptors } from './geometryDescriptors';

export type StructuralClass = 'planar-vertical' | 'planar-horizontal' | 'scatter' | 'ambiguous';

export interface VerticalityCueParams {
  /** Planarity at or above this reads as a planar surface. Default 0.5. */
  readonly planarityMin: number;
  /** Verticality at or above this makes a planar surface a wall face. Default 0.7. */
  readonly verticalityHigh: number;
  /** Verticality at or below this makes a planar surface horizontal. Default 0.3. */
  readonly verticalityLow: number;
  /** Sphericity at or above this (when not planar) reads as scatter. Default 0.25. */
  readonly sphericityScatter: number;
}

export const DEFAULT_VERTICALITY_CUE: VerticalityCueParams = {
  planarityMin: 0.5,
  verticalityHigh: 0.7,
  verticalityLow: 0.3,
  sphericityScatter: 0.25,
};

/** Label a neighbourhood's structure from its eigen descriptors. */
export function classifyStructure(
  d: GeoDescriptors,
  params: VerticalityCueParams = DEFAULT_VERTICALITY_CUE,
): StructuralClass {
  if (d.planarity >= params.planarityMin) {
    if (d.verticality >= params.verticalityHigh) return 'planar-vertical';
    if (d.verticality <= params.verticalityLow) return 'planar-horizontal';
    return 'ambiguous';
  }
  if (d.sphericity >= params.sphericityScatter) return 'scatter';
  return 'ambiguous';
}

/**
 * Compute descriptors for a neighbourhood and label its structure, or null when
 * the neighbourhood is degenerate (too few points, no eigen-decomposition).
 */
export function structureForNeighborhood(
  positions: Float32Array | ReadonlyArray<number>,
  ids: ReadonlyArray<number>,
  params: VerticalityCueParams = DEFAULT_VERTICALITY_CUE,
): StructuralClass | null {
  const d = descriptorsForNeighborhood(positions, ids);
  return d ? classifyStructure(d, params) : null;
}
