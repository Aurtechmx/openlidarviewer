/**
 * contourGeometryProduct.ts
 *
 * The analytical vs cartographic geometry split (v0.5.9 spec §15/§16). Two
 * products come out of one contour set:
 *
 *  - ANALYTICAL isolines — the exact geometry of the generated raster surface.
 *    No smoothing, no displacement. This is what GIS/research exports carry.
 *  - CARTOGRAPHIC generalization — legible, simplified lines for presentation,
 *    derived FROM the analytical product and referencing its hash. This is what
 *    the PDF map carries. It is never labelled exact.
 *
 * Pure and deterministic. The analytical product is immutable under any
 * cartographic setting (the generalizer takes the analytical product as input
 * and returns a NEW product; it never mutates it), and the generalization is
 * per-feature, so separate features (and the gaps between them) are never
 * bridged.
 */

import type { ContourFeature } from '../contour/contourFeatureModel';
import { canonicalHash } from '../../canonicalHash';
import { raw, sourceUnits, toMetresIfKnown, type LinearUnitScale } from '../../units/units';

export type ContourGeometryRole = 'analytical-isoline' | 'cartographic-generalization';

/** Displacement + topology record for a generalization pass (spec §16.3). */
export interface ContourGeneralizationRecord {
  readonly methodId: string;
  readonly methodVersion: string;
  readonly toleranceSource: number;
  readonly toleranceMetres: number | null;
  readonly maxDisplacementSource: number;
  readonly p95DisplacementSource: number;
  readonly meanDisplacementSource: number;
  readonly topologyPreserved: boolean;
}

export interface ContourGeometryProduct {
  readonly role: ContourGeometryRole;
  readonly methodId: string;
  readonly methodVersion: string;
  /** Content hash of THIS product's geometry (elevation + coordinates). */
  readonly contentHash: string;
  /** The analytical product this was derived from; null for the analytical product. */
  readonly sourceAnalyticalHash: string | null;
  readonly features: readonly ContourFeature[];
  readonly generalization: ContourGeneralizationRecord | null;
}

/** True only for the exact analytical product — never for a generalization. */
export function isExactGeometry(p: ContourGeometryProduct): boolean {
  return p.role === 'analytical-isoline';
}

function hashFeatures(features: readonly ContourFeature[]): string {
  // Hash the geometry that defines the product: elevation + rounded coordinates.
  return canonicalHash(
    features.map((f) => ({
      v: f.value,
      c: f.closed,
      xy: f.coordinates.map(([x, y]) => [round(x), round(y)]),
    })),
  );
}
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Build the exact analytical product from the contour features. */
export function analyticalProduct(
  features: readonly ContourFeature[],
  method: { methodId?: string; methodVersion?: string } = {},
): ContourGeometryProduct {
  return {
    role: 'analytical-isoline',
    methodId: method.methodId ?? 'olv.contour.analytical',
    methodVersion: method.methodVersion ?? '1',
    contentHash: hashFeatures(features),
    sourceAnalyticalHash: null,
    features,
    generalization: null,
  };
}

export interface GeneralizeOptions {
  /** Base simplification tolerance, in the source (horizontal) unit. Must be > 0. */
  readonly toleranceSource: number;
  /** Horizontal unit scale (for the metre-equivalent of the tolerance). */
  readonly horizontalUnit: LinearUnitScale;
  readonly methodId?: string;
  readonly methodVersion?: string;
  /**
   * Optional per-feature tolerance override (v0.5.9 §16 terrain-aware
   * generalization, PR8): return the tolerance to use for this feature, given
   * the base tolerance. Values are clamped to be positive. When absent, the
   * base tolerance applies uniformly.
   */
  readonly toleranceForFeature?: (feature: ContourFeature, baseTolerance: number) => number;
}

/**
 * Derive a cartographic (generalized) product from an analytical one. Applies a
 * per-feature Douglas–Peucker simplification, records displacement statistics,
 * and references the analytical product's hash. The analytical input is not
 * mutated.
 */
export function cartographicProduct(
  analytical: ContourGeometryProduct,
  opts: GeneralizeOptions,
): ContourGeometryProduct {
  const tol = raw(sourceUnits(opts.toleranceSource)); // rejects NaN/Infinity
  if (tol <= 0) throw new RangeError('Generalization tolerance must be positive.');

  const displacements: number[] = [];
  let topologyPreserved = true;

  const simplified: ContourFeature[] = analytical.features.map((f) => {
    const featureTol = opts.toleranceForFeature
      ? Math.max(1e-9, opts.toleranceForFeature(f, tol))
      : tol;
    const out = douglasPeucker(f.coordinates, featureTol);
    // Per-vertex displacement: each ORIGINAL vertex's distance to the simplified
    // polyline (how far the generalized line moved from the exact geometry).
    for (const p of f.coordinates) displacements.push(distanceToPolyline(p, out));
    // A closed ring that collapses below a triangle is a topology change.
    if (f.closed && out.length < 4) topologyPreserved = false;
    if (out.length < 2) topologyPreserved = false;
    return { ...f, coordinates: out };
  });
  // Feature count is preserved by construction (map is 1:1) — separate features
  // and the gaps between them are never merged.

  displacements.sort((a, b) => a - b);
  const max = displacements.length ? displacements[displacements.length - 1] : 0;
  const p95 = percentile(displacements, 0.95);
  const mean = displacements.length
    ? displacements.reduce((s, d) => s + d, 0) / displacements.length
    : 0;

  const methodId = opts.methodId ?? 'olv.contour.generalize.dp';
  const methodVersion = opts.methodVersion ?? '1';
  const tolM = toMetresIfKnown(sourceUnits(tol), opts.horizontalUnit);

  return {
    role: 'cartographic-generalization',
    methodId,
    methodVersion,
    contentHash: hashFeatures(simplified),
    sourceAnalyticalHash: analytical.contentHash,
    features: simplified,
    generalization: {
      methodId,
      methodVersion,
      toleranceSource: tol,
      toleranceMetres: tolM === null ? null : raw(tolM),
      maxDisplacementSource: max,
      p95DisplacementSource: p95,
      meanDisplacementSource: mean,
      topologyPreserved,
    },
  };
}

// ── geometry helpers (pure) ────────────────────────────────────────────────

type Pt = [number, number];

/** Douglas–Peucker line simplification. Keeps endpoints; deterministic. */
function douglasPeucker(points: ReadonlyArray<Pt>, tol: number): Pt[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]] as Pt);
  let maxDist = -1;
  let idx = -1;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > tol && idx > 0) {
    const left = douglasPeucker(points.slice(0, idx + 1), tol);
    const right = douglasPeucker(points.slice(idx), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [[first[0], first[1]], [last[0], last[1]]];
}

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/** Minimum distance from a point to a polyline (min over its segments). */
function distanceToPolyline(p: Pt, line: ReadonlyArray<Pt>): number {
  if (line.length === 0) return 0;
  if (line.length === 1) return Math.hypot(p[0] - line[0][0], p[1] - line[0][1]);
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = segmentDistance(p, line[i], line[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
