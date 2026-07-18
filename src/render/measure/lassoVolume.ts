/**
 * lassoVolume.ts
 *
 * 3D volumetric lasso selection — "draw a freeform shape on the canvas
 * and measure volume from every 3D point inside it." Sits as a leaf on
 * top of `volume.ts` so the existing `volumeCutFill` math is reused;
 * this module only adds the new SELECTION strategy and the helpers it
 * needs (screen projection, convex hull, percentile reference).
 *
 * The 2D-vs-3D distinction matters:
 *   - The lasso is drawn in screen space (2D path).
 *   - But selection is 3D — every world point in the cloud is projected
 *     onto the same screen and tested against the lasso. So a lasso
 *     drawn around a tree picks up trunk + branches + the ground
 *     surface BEHIND it through the same camera ray. That gives a true
 *     volumetric pick, not a screen-space "everything currently
 *     visible" snapshot.
 *
 * Pure — no three.js, no DOM. The caller passes a projector function
 * built from its own camera + viewport so this leaf stays unit-
 * testable in Node with mock projections.
 */

import type { Vec3 } from '../navMath';
import { pointInPolygon2D, polygonHorizontalArea, volumeCutFill } from './volume';
import type { VolumeResult } from './volume';

/** A 2D point in screen space (pixel coordinates). */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * World-to-screen projector. Returns `null` for points clipped behind
 * the near plane or outside the viewport — those are excluded from the
 * lasso selection (they're not visible to the user, so they shouldn't
 * be included in a "what's inside the lasso" pick).
 */
export type ScreenProjector = (x: number, y: number, z: number) => Vec2 | null;

/** Inputs to `selectByLasso`. */
export interface LassoSelectionInput {
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  readonly positions: Float32Array;
  /** Freehand lasso path, polygon vertices in screen-space pixels. */
  readonly lasso: ReadonlyArray<Vec2>;
  /** Projects a world-space point to screen-space pixels, or `null` if clipped. */
  readonly project: ScreenProjector;
}

/**
 * Walk every point in `positions`, project to screen via `project`, and
 * return the indices of points whose 2D projection lies inside the lasso
 * polygon.
 *
 * O(N · M) where N is point count and M is lasso vertex count. M is
 * small (typically 30–200 lasso vertices for a hand-drawn path), so
 * the dominant cost is the projection. Callers running on a streaming
 * cloud should pass only the resident chunks they care about.
 */
export function selectByLasso(input: LassoSelectionInput): number[] {
  const lasso = input.lasso;
  if (lasso.length < 3) return [];
  // Adapt the lasso polygon to `pointInPolygon2D`'s `{x, y}` shape.
  const polygon = lasso.map((p) => ({ x: p.x, y: p.y }));

  const out: number[] = [];
  const n = input.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const px = input.positions[i * 3];
    const py = input.positions[i * 3 + 1];
    const pz = input.positions[i * 3 + 2];
    const screen = input.project(px, py, pz);
    if (screen === null) continue;
    if (pointInPolygon2D(screen.x, screen.y, polygon)) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Visibility filters a lasso selection must respect before it is allowed to
 * EDIT points (as opposed to merely measure them). Both are optional — an
 * absent predicate means "that filter isn't active" and costs nothing.
 */
export interface SelectionVisibilityFilters {
  /**
   * World-space keep test — pass the clip box's `clipKeepsPoint` when a clip
   * is enabled, so points hidden by the box can't be touched.
   */
  readonly keepPoint?: (x: number, y: number, z: number) => boolean;
  /**
   * Per-index accept test — pass the same class-visibility predicate the
   * click-pick path uses, so points of a hidden class can't be touched.
   */
  readonly acceptIndex?: (index: number) => boolean;
}

/**
 * Restrict a `selectByLasso` result to points the user can currently SEE.
 * The lasso projector already excludes points behind the camera or outside
 * the viewport, but NOT points hidden by the clip box or by the class-
 * visibility filter — applying an edit to the raw selection permanently
 * rewrote invisible points (reclassify-invisible-points finding, Critical).
 * Click-picking enforces both rules; this gives the lasso edit path the same
 * contract, as a pure, unit-testable seam.
 *
 * Filters `indices` IN PLACE (compacting, then truncating the array) so the
 * edit hot path allocates nothing; returns the same array for convenience.
 * With no active filter the array is returned untouched.
 */
export function filterSelectionToVisible(
  indices: number[],
  positions: Float32Array,
  filters: SelectionVisibilityFilters,
): number[] {
  const { keepPoint, acceptIndex } = filters;
  if (!keepPoint && !acceptIndex) return indices;
  let w = 0;
  for (let r = 0; r < indices.length; r++) {
    const i = indices[r];
    if (
      keepPoint &&
      !keepPoint(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    ) {
      continue;
    }
    if (acceptIndex && !acceptIndex(i)) continue;
    indices[w++] = i;
  }
  indices.length = w;
  return indices;
}

/**
 * Andrew's monotone-chain convex hull in 2D. Returns the hull vertices
 * in counter-clockwise order starting from the lowest, leftmost point.
 * Identical inputs collapse to a 1- or 2-point degenerate hull. The
 * caller drops those with `pointInPolygon2D` (the polygon-area is 0).
 */
export function convexHull2D(points: ReadonlyArray<Vec2>): Vec2[] {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ x: p.x, y: p.y }));
  // Sort lex by (x, y) — stable order makes the algorithm deterministic.
  const sorted = points.slice().sort((a, b) => {
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  // Lower hull.
  const lower: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  // Upper hull.
  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  // Concatenate, dropping the last point of each list (it's the start of the other).
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Percentile of a numeric array, linear interpolation between the two
 * nearest ranks. `percentile` is a fraction in [0, 1] — pass 0.05 for
 * "5th percentile". Returns NaN for an empty array.
 *
 * v0.3.10 deliverable-completion patch — the prior version sorted the
 * raw input. When the selected points carried NaN Z values (rare but
 * real on streaming clouds mid-load, or when a loader returns the
 * sentinel for a missing attribute), `Array.prototype.sort` placed NaN
 * at an arbitrary rank, the percentile sometimes WAS NaN, and the
 * downstream `dz = height - refZ` propagated NaN into every fill/cut
 * accumulator. The lasso then returned `fill: NaN, cut: NaN, net: NaN`
 * silently — the panel rendered "—" with no error message and the user
 * had no idea why. Filter to finite values first; if nothing survives,
 * return NaN explicitly so callers can detect the failure mode and
 * surface "selection contains no finite Z values" instead of "—".
 */
export function percentile(values: ReadonlyArray<number>, percentile: number): number {
  // Filter to finite values BEFORE sort — NaN ordering under
  // `Array.prototype.sort` is implementation-defined and historically
  // a source of silent-failure bugs in this exact pattern.
  const finite: number[] = [];
  for (const v of values) if (Number.isFinite(v)) finite.push(v);
  const n = finite.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return finite[0];
  finite.sort((a, b) => a - b);
  const p = Math.max(0, Math.min(1, percentile));
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return finite[lo];
  const t = idx - lo;
  return finite[lo] * (1 - t) + finite[hi] * t;
}

/** Inputs to `volumeFromLasso`. */
export interface LassoVolumeInput {
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  readonly positions: Float32Array;
  /** Selected indices into `positions` (from `selectByLasso`). */
  readonly selected: ReadonlyArray<number>;
  /**
   * Reference-plane percentile in `[0, 1]`. Defaults to 0.05 — the
   * lowest 5% of selected Z values is treated as "ground" so volume
   * reads as fill (above ground). Pass 0.5 for symmetric grading.
   */
  readonly referencePercentile?: number;
  /** World up vector. Defaults to `[0, 0, 1]`. */
  readonly up?: Vec3;
}

/**
 * Compute the volumetric pick result from a lasso selection.
 *
 *   1. Extract XY of every selected point.
 *   2. Build the 2D convex hull of those XY points — that's the
 *      footprint polygon.
 *   3. Reference Z = percentile (default 5th) of selected Z values.
 *   4. Delegate to `volumeCutFill` against ONLY the selected subset.
 *
 * Returns the same `VolumeResult` shape as `volumeCutFill` so report
 * templates and the MeasurePanel can render either kind without a
 * special case.
 */
export function volumeFromLasso(input: LassoVolumeInput): VolumeResult {
  return volumeFromLassoWithFootprint(input).result;
}

/**
 * Same compute as `volumeFromLasso` but also returns the convex hull
 * polygon and reference Z so the host can persist a Volume
 * measurement to the session. The lasso draft was screen-space; the
 * hull lifted to (refZ) is the actual cloud-space polygon a saved
 * Volume should reference.
 */
export interface LassoVolumeWithFootprint {
  /** The cut/fill/footprint figures. */
  readonly result: VolumeResult;
  /**
   * 3D convex-hull polygon, vertices lifted to the reference plane.
   * Empty when the selection collapsed to a degenerate hull.
   */
  readonly polygon3D: ReadonlyArray<Vec3>;
  /** Reference Z used by the cut/fill integration. */
  readonly referenceZ: number;
}

export function volumeFromLassoWithFootprint(
  input: LassoVolumeInput,
): LassoVolumeWithFootprint {
  const n = input.selected.length;
  // Degenerate selection — fewer than 3 points cannot form a footprint.
  if (n < 3) {
    return {
      result: {
        fill: 0,
        cut: 0,
        net: 0,
        footprintArea: 0,
        pointsInPolygon: 0,
        sampleCount: input.positions.length / 3,
        densityNative: 0,
        medianAbsDelta: Number.NaN,
        validity: 'too-few-vertices',
      },
      polygon3D: [],
      referenceZ: 0,
    };
  }

  // Build the XY scatter + Z list from the selected indices.
  const xy: Vec2[] = new Array(n);
  const zs: number[] = new Array(n);
  const subsetPositions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const idx = input.selected[i];
    const px = input.positions[idx * 3];
    const py = input.positions[idx * 3 + 1];
    const pz = input.positions[idx * 3 + 2];
    xy[i] = { x: px, y: py };
    zs[i] = pz;
    subsetPositions[i * 3] = px;
    subsetPositions[i * 3 + 1] = py;
    subsetPositions[i * 3 + 2] = pz;
  }

  // XY convex hull → footprint polygon.
  const hull2D = convexHull2D(xy);
  // Degenerate hull (collinear selection) — no footprint area.
  const hullArea = polygonHorizontalArea(hull2D);
  if (hull2D.length < 3 || hullArea === 0) {
    return {
      result: {
        fill: 0,
        cut: 0,
        net: 0,
        footprintArea: hullArea,
        pointsInPolygon: n,
        sampleCount: input.positions.length / 3,
        densityNative: 0,
        medianAbsDelta: Number.NaN,
        validity: hull2D.length < 3 ? 'too-few-vertices' : 'zero-area',
      },
      polygon3D: [],
      referenceZ: 0,
    };
  }

  // Reference Z — 5th percentile of selected Z by default.
  const p = input.referencePercentile ?? 0.05;
  const refZ = percentile(zs, p);

  // v0.3.10 deliverable-completion deep-review #2 — when every
  // selected point carried NaN Z values (loader sentinel for a
  // missing attribute, or rare mid-stream corruption), `percentile`
  // now returns NaN explicitly. Without this guard, `refZ = NaN`
  // would flow into `volumeCutFill`'s `dz = height - refZ` accumulator
  // where `dz >= 0` always evaluates false against NaN — the result
  // would be `fill: 0, cut: 0, net: 0, validity: 'ok'`, INDISTINGUISHABLE
  // from a genuinely empty selection. Worse: the live UI would render
  // "0 m³ net" with no warning, and the user would think the lasso
  // covered a flat plane. Detect refZ NaN here and tag the result as
  // `'non-finite-vertex'` — the same `PolygonValidity` member that
  // already exists for NaN XY vertices in polygonHygiene, so no new
  // type churn and the panel/report can surface the same "selection
  // contains non-finite coordinates" caveat for either failure mode.
  if (!Number.isFinite(refZ)) {
    return {
      result: {
        fill: 0,
        cut: 0,
        net: 0,
        footprintArea: hullArea,
        pointsInPolygon: n,
        sampleCount: input.positions.length / 3,
        densityNative: 0,
        medianAbsDelta: Number.NaN,
        validity: 'non-finite-vertex',
      },
      polygon3D: [],
      referenceZ: 0,
    };
  }

  // Lift the 2D hull to Vec3 (with z = refZ) for `volumeCutFill`'s
  // polygon contract. The Z value of the polygon vertices is unused
  // by `volumeCutFill` (it projects to the horizontal plane), so any
  // value works — refZ is the cleanest.
  const polygon: Vec3[] = hull2D.map((p) => [p.x, p.y, refZ] as Vec3);

  const result = volumeCutFill({
    polygon,
    referenceZ: refZ,
    up: input.up ?? [0, 0, 1],
    positions: subsetPositions,
  });
  return {
    result,
    polygon3D: polygon,
    referenceZ: refZ,
  };
}
