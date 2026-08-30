/**
 * featureExtractionInput.ts — turn a loaded cloud into feature-extraction input.
 *
 * The feature cores (building footprints, conductor fit) take plain geometry, not
 * a PointCloud. This is the one place that reads a cloud's classified points and
 * shapes them for `FeatureExtractionService`, so the UI mount that reviews the
 * candidates never learns what a PointCloud is.
 *
 * WHAT IT READS, AND WHY THAT IS HONEST TO CARRY FORWARD. Building points are the
 * points a classifier marked ASPRS class 6; wire points, class 14. That
 * classification may be the file's own or one the viewer DERIVED heuristically —
 * a weaker basis — so `classificationIsDerived` travels with the input and the
 * review surface states which it was. A candidate built on derived classes is a
 * candidate about a guess, and the surface must not hide that.
 *
 * FRAME. The cloud's positions are its recentred (render-local) buffer. Both
 * cores are translation-invariant — the footprint grid anchors on the points'
 * own bounds, the conductor fit works from their covariance — so the recentred
 * frame is exactly what they need and no origin shift is applied. The horizontal
 * pair is chosen by the up axis: (x, y) for a Z-up source, (x, z) for a Y-up one,
 * so a footprint is measured in the ground plane and not a wall.
 *
 * Returns null when the cloud carries neither building nor wire points: there is
 * nothing to extract and the launcher should not appear.
 */

import type { PointCloud } from '../model/PointCloud';
import type { BuildingPoint, FootprintGrid } from '../features/buildingFootprints';
import type { Vec3 } from '../features/conductors';
import { knownUnit, unknownUnit, type LinearUnitScale } from '../units/units';
import { defaultCellSizeForSpacing } from '../render/densityColors';
import { isZUpFormat } from '../io/sniffFormat';

/** ASPRS classification codes the feature cores consume. */
const ASPRS_BUILDING = 6;
const ASPRS_WIRE_CONDUCTOR = 14;

export interface FeatureExtractionInput {
  readonly buildingPoints: readonly BuildingPoint[];
  readonly buildingGrid: FootprintGrid;
  readonly conductorPoints: readonly Vec3[];
  readonly unit: LinearUnitScale;
  /** The frame's vertical axis, for the conductor sag/span split. */
  readonly up: Vec3;
  /**
   * True when the classification these points came from was DERIVED by the
   * viewer's heuristic rather than read from the file. The review surface states
   * it: a candidate over derived classes is a candidate about a guess.
   */
  readonly classificationIsDerived: boolean;
}

/** Nominal point spacing in source units, from a horizontal bbox and count. */
function nominalSpacing(
  minH1: number,
  maxH1: number,
  minH2: number,
  maxH2: number,
  n: number,
): number {
  const area = Math.max(0, maxH1 - minH1) * Math.max(0, maxH2 - minH2);
  if (!(area > 0) || n < 1) return 1;
  return Math.sqrt(area / n);
}

/**
 * The cloud's linear unit as a conversion scale, or unknown.
 *
 * KNOWN only when a CRS is actually present AND declares a usable linear unit: a
 * MISSING crs must read as unknown, not as metres. Guarding on `linearUnit` alone
 * would let a null crs pass as known (the fail-open trap the measurement surface
 * has hit before), so the crs presence and the positive factor are both checked.
 */
function unitOf(cloud: PointCloud): LinearUnitScale {
  const crs = cloud.metadata?.crs;
  if (crs != null && crs.linearUnit !== 'unknown' && crs.linearUnitToMetres > 0) {
    return knownUnit(crs.linearUnitToMetres);
  }
  return unknownUnit();
}

/**
 * Build feature-extraction input from a cloud's classified points, or null when
 * it carries none. The linear unit for the candidates' metric twins is derived
 * from the cloud's own CRS, fail-closed to unknown when none is declared.
 */
export function buildFeatureExtractionInput(
  cloud: PointCloud | null | undefined,
): FeatureExtractionInput | null {
  if (!cloud) return null;
  const classification = cloud.classification;
  const positions = cloud.positions;
  if (!classification || positions.length === 0) return null;
  const unit = unitOf(cloud);

  const zUp = isZUpFormat(cloud.sourceFormat);
  // The second horizontal axis by up axis; the first is always x.
  const h2i = zUp ? 1 : 2;

  const buildingPoints: BuildingPoint[] = [];
  const conductorPoints: Vec3[] = [];
  let minH1 = Infinity;
  let maxH1 = -Infinity;
  let minH2 = Infinity;
  let maxH2 = -Infinity;

  const n = Math.min(classification.length, positions.length / 3);
  for (let i = 0; i < n; i++) {
    const code = classification[i];
    if (code !== ASPRS_BUILDING && code !== ASPRS_WIRE_CONDUCTOR) continue;
    const b = i * 3;
    const x = positions[b];
    const y = positions[b + 1];
    const z = positions[b + 2];
    if (code === ASPRS_BUILDING) {
      const h1 = x;
      const h2 = h2i === 1 ? y : z;
      buildingPoints.push({ x: h1, y: h2 });
      if (h1 < minH1) minH1 = h1;
      if (h1 > maxH1) maxH1 = h1;
      if (h2 < minH2) minH2 = h2;
      if (h2 > maxH2) maxH2 = h2;
    } else {
      conductorPoints.push([x, y, z]);
    }
  }

  if (buildingPoints.length === 0 && conductorPoints.length === 0) return null;

  const spacing = nominalSpacing(minH1, maxH1, minH2, maxH2, buildingPoints.length);
  const cellSizeSource = defaultCellSizeForSpacing(spacing);
  const buildingGrid: FootprintGrid = {
    originX: Number.isFinite(minH1) ? minH1 : 0,
    originY: Number.isFinite(minH2) ? minH2 : 0,
    cellSizeSource,
  };

  return {
    buildingPoints,
    buildingGrid,
    conductorPoints,
    unit,
    up: zUp ? [0, 0, 1] : [0, 1, 0],
    classificationIsDerived: cloud.classificationIsDerived,
  };
}
