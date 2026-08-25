/**
 * FeatureExtractionService.ts — a callable entry over the feature cores.
 *
 * `extractBuildingFootprints` and `fitConductor` are complete, tested pure cores.
 * This service is the product-side entry: it runs them and returns DERIVED
 * CANDIDATES — not "detected buildings" — in a uniform, review-ready shape so a
 * candidate-review UI or a DerivedLayer can consume one thing. The evidence
 * language stays deliberately weak: these are candidates until a reviewer or
 * stronger evidence promotes them.
 *
 * TWO CONTRACTS THIS LAYER OWNS, both load-bearing:
 *
 * 1. UNITS. The cores measure in whatever unit their input carries — the grid's
 *    cell size and the point coordinates are SOURCE units, not metres (the
 *    terrain pipeline's own `cellSizeM` is likewise source units: it is
 *    `0.25 / metresPerUnit`). A field called `areaM2` fed from a foot or degree
 *    CRS would therefore be a number labelled m² that is not m². So a candidate
 *    always carries its SOURCE-unit measure, and the metric twin is present only
 *    when the linear unit is KNOWN — `null` otherwise, never a guess. This is the
 *    same fail-closed rule the rest of the metric surface follows.
 *
 * 2. IDENTITY. A candidate's id is derived from its own GEOMETRY (a quantised
 *    position), not from its index in a sorted list. An index is not stable: a
 *    re-run whose areas shift by a hair reorders the list, and a reviewer who
 *    accepted "building-3" would find that id now naming a different building.
 *    A geometry-derived id keeps naming the same thing across re-runs.
 *
 * Pure: geometry in, candidates out.
 */

import { extractBuildingFootprints, type BuildingPoint, type FootprintGrid } from './buildingFootprints';
import { fitConductor, type Vec3 } from './conductors';
import type { Pt2 } from './footprintTrace';
import {
  sourceUnits,
  toMetresIfKnown,
  raw,
  type LinearUnitScale,
} from '../units/units';

/** Shared by every candidate kind: what it is, and how far to trust it. */
interface CandidateBase {
  readonly id: string;
  /**
   * Deliberately weak. A candidate is a DERIVED proposal, never a detection —
   * promotion is a reviewer's act or a stronger evidence source's.
   */
  readonly confidence: 'derived';
}

export interface BuildingCandidate extends CandidateBase {
  readonly kind: 'building';
  /** Footprint area in the SOURCE horizontal unit, squared. Always present. */
  readonly areaSource: number;
  /** The same area in m², or null when the source unit is not known. */
  readonly areaM2: number | null;
  readonly cellCount: number;
  /**
   * The traced outer boundary, in the source frame the points arrived in (first
   * vertex not repeated). This is what a reviewer SEES and what a GeoJSON export
   * writes — a bounding box would be a rectangle, not a building.
   */
  readonly ring: readonly Pt2[];
  /** Source-unit centroid + bounds, in the frame the points arrived in. */
  readonly centroid: readonly [number, number];
  readonly bounds: readonly [number, number, number, number];
}

export interface ConductorCandidate extends CandidateBase {
  readonly kind: 'conductor';
  readonly linearity: number;
  /** Along-span length in SOURCE units. Always present. */
  readonly spanSource: number;
  /** The same span in metres, or null when the source unit is not known. */
  readonly spanM: number | null;
  /** Sag in SOURCE units, and its metric twin when the unit is known. */
  readonly sagSource: number;
  readonly sagM: number | null;
  /** Fit residual RMS in SOURCE units, and its metric twin when known. */
  readonly residualRmsSource: number;
  readonly residualRmsM: number | null;
  readonly pointCount: number;
}

/**
 * Quantise a coordinate pair into a stable identity token.
 *
 * The quantum is a fraction of the grid cell, so two runs that place the same
 * feature within a fraction of a cell agree on its id, while two genuinely
 * different features a cell apart never collide.
 */
function positionToken(x: number, y: number, quantum: number): string {
  const q = Number.isFinite(quantum) && quantum > 0 ? quantum : 1;
  const qx = Math.round(x / q);
  const qy = Math.round(y / q);
  return `${qx}_${qy}`;
}

/**
 * Extract building footprint candidates from occupied ground-plane points.
 *
 * `unit` converts the SOURCE horizontal unit to metres; pass `unknownUnit()`
 * when the file declares none, and every metric field comes back null rather
 * than pretending the source unit was metres.
 */
export function extractBuildingCandidates(
  points: readonly BuildingPoint[],
  grid: FootprintGrid,
  unit: LinearUnitScale,
): BuildingCandidate[] {
  // Half a cell: fine enough that two distinct footprints never share a token,
  // coarse enough that a re-run's sub-cell centroid drift keeps the same id.
  const quantum = grid.cellSizeM / 2;
  const seen = new Map<string, number>();
  return extractBuildingFootprints(points, grid).map((f) => {
    const token = positionToken(f.centroidX, f.centroidY, quantum);
    // A collision is possible in principle (two centroids inside one quantum);
    // suffix rather than overwrite, so two candidates can never share an id.
    const n = (seen.get(token) ?? 0) + 1;
    seen.set(token, n);
    const id = n === 1 ? `building-${token}` : `building-${token}-${n}`;
    const areaSource = f.areaM2; // core value: cells x cell^2, in SOURCE units^2
    return {
      id,
      kind: 'building',
      confidence: 'derived',
      areaSource,
      // Area is a SQUARE measure, so the scale applies twice — converting it
      // once would under-report by the unit factor.
      areaM2: unit.known ? areaSource * unit.metresPerUnit * unit.metresPerUnit : null,
      cellCount: f.cellCount,
      ring: f.ring,
      centroid: [f.centroidX, f.centroidY],
      bounds: [f.minX, f.minY, f.maxX, f.maxY],
    };
  });
}

/**
 * Fit a single conductor candidate to a set of points, or null when the points
 * are not linear enough to be a conductor span (the core's own gate).
 *
 * `up` is the frame's vertical axis, passed through to the core: sag is measured
 * along it, and span across the plane perpendicular to it. It is required for
 * the same reason `unit` is — assuming index 2 is up is the geometric twin of
 * assuming the source unit is metres.
 *
 * The id is derived from the span's own midpoint, so re-running over the same
 * span keeps the same candidate rather than minting a fresh one.
 */
export function extractConductorCandidate(
  points: readonly Vec3[],
  unit: LinearUnitScale,
  up: Vec3,
  minLinearity = 0.9,
): ConductorCandidate | null {
  const fit = fitConductor(points, up, minLinearity);
  if (!fit.ok) return null;
  const toM = (v: number): number | null => {
    const m = toMetresIfKnown(sourceUnits(v), unit);
    return m === null ? null : raw(m);
  };
  // Identity from the span's midpoint, quantised by a fraction of its own
  // length — scale-free, so it works for a 10 m span and a 400 m one alike.
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
  }
  cx /= points.length;
  cy /= points.length;
  const token = positionToken(cx, cy, fit.spanSource / 8 || 1);
  return {
    id: `conductor-${token}`,
    kind: 'conductor',
    confidence: 'derived',
    linearity: fit.linearity,
    spanSource: fit.spanSource,
    spanM: toM(fit.spanSource),
    sagSource: fit.sagSource,
    sagM: toM(fit.sagSource),
    residualRmsSource: fit.residualRmsSource,
    residualRmsM: toM(fit.residualRmsSource),
    pointCount: fit.n,
  };
}
