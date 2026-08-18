/**
 * contourShapeStyle.ts
 *
 * One honest knob for the SHAPE of exported contour lines. The user picks how
 * smooth / rounded / geometric the lines read, from a small preset list, and
 * the choice drives a single pure transform applied to the RAW stitched
 * polylines before they become the export feature model. Every export (Map PDF,
 * SVG, DXF, GeoJSON) is then produced from — and stamped with — that one style.
 *
 * Honesty contract (load-bearing, do NOT relax): a style may only POLISH
 * terrain the data actually supports. It can never fabricate a line across a
 * gap. Two structural guarantees enforce this:
 *
 *   - Smoothing reuses {@link chaikinSmooth}, which is confidence-gated: a
 *     corner is rounded only when the vertex AND both neighbours clear the
 *     smoothing confidence floor, so any vertex at or beside a low-confidence /
 *     gap span keeps its EXACT original coordinate.
 *   - Simplification ({@link simplifyPolyline}, Douglas–Peucker) is honesty-
 *     gated the same way: it pins endpoints (open) / preserves closure (closed),
 *     and NEVER drops a vertex that is below the smoothing confidence floor or
 *     adjacent to an evidence-grade transition. So a gap / low-confidence span
 *     keeps its exact vertices under every style, and a dashed run can never be
 *     straightened into a confident-looking line.
 *
 * The 'smooth' preset reproduces the historical default EXACTLY
 * (`chaikinSmooth(poly)` = Chaikin ×2), so the live on-screen contours and the
 * pinned contour tests are byte-identical with the default style.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { EVIDENCE_THRESHOLDS, gradeForConfidence } from '../ground/cellConfidence';
import { chaikinSmooth } from './smoothing';
import type { ContourPolyline, ContourVertex } from './stitchContours';
import { unionProvBits } from './contourSegmentEvidence';
import {
  terrainAwareToleranceFactor,
  type TerrainAwareFeatureShape,
  type ContourGeneralizeMode,
} from './terrainAwareTolerance';

/** The contour shape presets the user can pick from. */
export type ContourShapeStyle =
  | 'crisp'
  | 'smooth'
  | 'rounded'
  | 'generalized'
  | 'semi-geometric';

/** UI descriptor for one shape style. */
export interface ContourShapeStyleOption {
  readonly value: ContourShapeStyle;
  readonly label: string;
  readonly description: string;
}

/**
 * The presets, in UI order. Labels + descriptions are the single source of
 * truth for the picker AND for the export stamps, so the file always names the
 * style the way the UI does.
 */
export const CONTOUR_SHAPE_STYLES: ReadonlyArray<ContourShapeStyleOption> = [
  {
    value: 'crisp',
    label: 'Crisp',
    description: 'Raw marching-squares vertices — angular, no smoothing or simplify.',
  },
  {
    value: 'smooth',
    label: 'Smooth',
    description: 'Gently rounded corners (default). Honesty-preserving.',
  },
  {
    value: 'rounded',
    label: 'Rounded',
    description: 'Stronger rounding for a flowing, organic look.',
  },
  {
    value: 'generalized',
    label: 'Generalized',
    description: 'Fewer vertices then smoothed — clean curves, lighter files.',
  },
  {
    value: 'semi-geometric',
    label: 'Semi-geometric',
    description: 'Straightened segments with softly bevelled corners — a faceted look.',
  },
];

/** The default style — reproduces the historical Chaikin ×2 behaviour exactly. */
export const defaultContourShapeStyle: ContourShapeStyle = 'smooth';

const STYLE_BY_VALUE = new Map<ContourShapeStyle, ContourShapeStyleOption>(
  CONTOUR_SHAPE_STYLES.map((s) => [s.value, s]),
);

/** Human label for a style (for export stamps + provenance). */
export function contourShapeStyleLabel(style: ContourShapeStyle): string {
  return STYLE_BY_VALUE.get(style)?.label ?? style;
}


/** Clone a polyline (new vertex array, vertices shared — they are readonly). */
function clonePolyline(poly: ContourPolyline): ContourPolyline {
  return { value: poly.value, vertices: poly.vertices.slice(), closed: poly.closed };
}

/** Perpendicular distance from p to the segment a→b (point distance when a≈b). */
function perpDistance(p: ContourVertex, a: ContourVertex, b: ContourVertex): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Project p onto the (clamped) segment, then measure the gap.
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Mark vertices Douglas–Peucker keeps between lo..hi (inclusive ends kept by caller). */
function dpMark(
  get: (i: number) => ContourVertex,
  lo: number,
  hi: number,
  eps: number,
  keep: boolean[],
): void {
  if (hi - lo < 2) return;
  let maxD = -1;
  let idx = -1;
  const a = get(lo);
  const b = get(hi);
  for (let i = lo + 1; i < hi; i++) {
    const d = perpDistance(get(i), a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (idx >= 0 && maxD > eps) {
    keep[idx] = true;
    dpMark(get, lo, idx, eps, keep);
    dpMark(get, idx, hi, eps, keep);
  }
}

/**
 * Flag every vertex that simplification must NEVER remove: any vertex below the
 * smoothing confidence floor, plus both vertices adjacent to an evidence-grade
 * transition (so a low-confidence / gap span keeps its exact vertices and a
 * dashed run can't be straightened into a confident line). For a closed ring the
 * wrap-around seam (last↔first) is treated as adjacent too.
 */
function protectedMask(vs: ReadonlyArray<ContourVertex>, floor: number, closed: boolean): boolean[] {
  const n = vs.length;
  const p = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!(vs[i].confidence >= floor)) p[i] = true;
  }
  for (let i = 1; i < n; i++) {
    if (vs[i].grade !== vs[i - 1].grade) {
      p[i] = true;
      p[i - 1] = true;
    }
  }
  if (closed && n > 1 && vs[0].grade !== vs[n - 1].grade) {
    p[0] = true;
    p[n - 1] = true;
  }
  return p;
}

/**
 * Honesty-gated Douglas–Peucker simplification. Removes redundant (near-
 * collinear) vertices to within `epsilon`, while:
 *   - pinning the endpoints of an open polyline,
 *   - preserving closure of a closed loop (the anchor vertex is always kept),
 *   - NEVER removing a vertex below the smoothing confidence floor or adjacent
 *     to a grade transition — protected vertices split the polyline into runs
 *     that are simplified independently, so every uncertain vertex keeps its
 *     EXACT original coordinate, grade and confidence.
 *
 * Returns a new polyline; the input is not mutated. Polylines with fewer than 3
 * vertices, or a non-positive epsilon, are returned unchanged. Deterministic.
 */
/** A simplified polyline plus the SOURCE indices it retained (WI-4). */
export interface SimplifiedPolyline extends ContourPolyline {
  /**
   * The source-vertex indices kept, ascending; `retainedIndices.length ===
   * vertices.length`. Consecutive entries `[a, b]` identify the complete source
   * interval each output segment represents, so evidence can be derived from the
   * whole interval rather than only its endpoints.
   */
  readonly retainedIndices: number[];
}

/**
 * Fold the evidence of the REMOVED interior of a source interval `(prevIdx,
 * curIdx)` into the retained vertex at `curIdx`: provenance is unioned over the
 * whole interval and same-meaning support (confidence) takes the interval
 * minimum, so a simplified segment's evidence describes the complete span it
 * covers — a removed measured vertex between two interpolated ones still makes
 * the output mixed, and a removed weak vertex still caps the support. Coordinates
 * are untouched, so geometry is identical to the un-folded simplification.
 */
function foldInterval(
  vs: readonly ContourVertex[],
  cur: ContourVertex,
  prevIdx: number,
  curIdx: number,
): ContourVertex {
  let prov = cur.provBits;
  let conf = cur.confidence;
  for (let j = prevIdx + 1; j < curIdx; j++) {
    prov = unionProvBits(prov, vs[j].provBits);
    conf = Math.min(conf, vs[j].confidence);
  }
  if (prov === cur.provBits && conf === cur.confidence) return cur;
  return { ...cur, provBits: prov, confidence: conf, grade: gradeForConfidence(conf) };
}

export function simplifyPolyline(
  poly: ContourPolyline,
  epsilon: number,
  floor: number = EVIDENCE_THRESHOLDS.solid,
): SimplifiedPolyline {
  const vs = poly.vertices;
  const n = vs.length;
  if (n < 3 || !(epsilon > 0)) {
    return { ...clonePolyline(poly), retainedIndices: vs.map((_, i) => i) };
  }

  const prot = protectedMask(vs, floor, poly.closed);

  if (!poly.closed) {
    const keep = new Array<boolean>(n).fill(false);
    keep[0] = true;
    keep[n - 1] = true;
    const bounds: number[] = [0];
    for (let i = 1; i < n - 1; i++) if (prot[i]) bounds.push(i);
    bounds.push(n - 1);
    for (let b = 0; b < bounds.length - 1; b++) {
      keep[bounds[b]] = true;
      keep[bounds[b + 1]] = true;
      dpMark((i) => vs[i], bounds[b], bounds[b + 1], epsilon, keep);
    }
    const retainedIndices: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) retainedIndices.push(i);
    // Each output segment derives evidence from its COMPLETE source interval.
    const out: ContourVertex[] = retainedIndices.map((idx, k) =>
      k === 0 ? vs[idx] : foldInterval(vs, vs[idx], retainedIndices[k - 1], idx),
    );
    return { value: poly.value, vertices: out, closed: false, retainedIndices };
  }

  // Closed: anchor at index 0, walk the ring 0..n (n is the duplicate of 0), so
  // closure is preserved (the anchor is pinned at both ends).
  const get = (i: number): ContourVertex => (i === n ? vs[0] : vs[i]);
  const keep = new Array<boolean>(n + 1).fill(false);
  keep[0] = true;
  keep[n] = true;
  const bounds: number[] = [0];
  for (let i = 1; i < n; i++) if (prot[i]) bounds.push(i);
  bounds.push(n);
  for (let b = 0; b < bounds.length - 1; b++) {
    keep[bounds[b]] = true;
    keep[bounds[b + 1]] = true;
    dpMark(get, bounds[b], bounds[b + 1], epsilon, keep);
  }
  const retainedIndices: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) retainedIndices.push(i); // drop the n duplicate
  const out: ContourVertex[] = retainedIndices.map((idx, k) =>
    k === 0 ? vs[idx] : foldInterval(vs, vs[idx], retainedIndices[k - 1], idx),
  );
  // The closing segment wraps from the last retained index to the anchor (n≡0):
  // fold that cyclic interval into the anchor (the deterministic cut at index 0),
  // so the ring's closing span contributes its evidence too.
  const lastKept = retainedIndices[retainedIndices.length - 1];
  out[0] = foldInterval(vs, out[0], lastKept, n);
  return { value: poly.value, vertices: out, closed: true, retainedIndices };
}

/** Options for {@link applyContourShapeStyle}. */
export interface ContourShapeStyleOptions {
  /**
   * Grid cell size (source units), so the simplify epsilon scales with the data
   * resolution rather than a fixed world distance. Default 1.
   */
  readonly cellSizeM?: number;
  /**
   * Generalization strength for the 'generalized' style, as a fraction of the
   * cell size (the Douglas–Peucker epsilon is `generalizeToleranceCells × cell`).
   * Lets a caller (e.g. a Contour Studio purpose) tune how hard the line is
   * simplified — 0.25 keeps it faithful, 1.0 is a clean cartographic pass. Only
   * the 'generalized' style reads it; every other style ignores it. When omitted,
   * the historical {@link GENERALIZE_EPS_CELLS} (0.5) is used, so existing callers
   * are byte-unchanged. A non-positive value simplifies nothing (honesty-gated
   * `simplifyPolyline` returns the polyline unchanged for epsilon ≤ 0).
   */
  readonly generalizeToleranceCells?: number;
  /**
   * How the 'generalized' style distributes its simplification strength across
   * features. 'uniform' (default, and the value when omitted) applies the same
   * epsilon to every polyline — byte-identical to before this option existed.
   * 'terrain-aware' scales the epsilon DOWN per feature from what it is
   * (interpolated / low-confidence support and small closed summits are smoothed
   * less), and NEVER up — so `generalizeToleranceCells × cell` still bounds every
   * line and the honesty-gated `simplifyPolyline` still protects gap and
   * low-confidence vertices. Only the 'generalized' style reads it.
   */
  readonly generalizeMode?: ContourGeneralizeMode;
}

// Simplify epsilons as a fraction of the cell size. 'generalized' keeps the
// curve faithful (light); 'semi-geometric' straightens harder so segments read
// geometric. Tuned to be gentle — a single cell of give for the light pass.
//
// GENERALIZE_EPS_CELLS is the DEFAULT strength for the 'generalized' style when
// no per-call tolerance is supplied. It is exported so the analysis pipeline can
// record the SAME number it actually generalised at into export provenance (no
// mirrored constant that could drift). A caller (e.g. a Contour Studio purpose)
// may override it via {@link ContourShapeStyleOptions.generalizeToleranceCells}.
export const GENERALIZE_EPS_CELLS = 0.5;
const SEMI_GEOMETRIC_EPS_CELLS = 1.75;

/**
 * Reduce a polyline to the whole-feature evidence signals the terrain-aware
 * tolerance policy reads: its WEAKEST grade (the most conservative — a single
 * gap span grades the whole line 'gap'), the mean vertex confidence, closure,
 * and planimetric length in source units. Pure.
 */
function polylineTerrainShape(poly: ContourPolyline): TerrainAwareFeatureShape {
  const vs = poly.vertices;
  let grade: 'solid' | 'dashed' | 'gap' = 'solid';
  let confSum = 0;
  let confN = 0;
  let length = 0;
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    if (v.grade === 'gap') grade = 'gap';
    else if (v.grade === 'dashed' && grade !== 'gap') grade = 'dashed';
    if (Number.isFinite(v.confidence)) {
      confSum += v.confidence;
      confN += 1;
    }
    if (i > 0) length += Math.hypot(v.x - vs[i - 1].x, v.y - vs[i - 1].y);
  }
  return {
    grade,
    meanConfidence: confN > 0 ? confSum / confN : NaN,
    closed: poly.closed,
    length,
  };
}

/**
 * Apply a shape style to a list of raw stitched polylines, returning new
 * polylines (inputs are not mutated). The mapping:
 *   - crisp          → identity (raw marching-squares vertices, no move).
 *   - smooth         → chaikinSmooth(iterations:2)  [the historical default].
 *   - rounded        → chaikinSmooth(iterations:4).
 *   - generalized    → simplify(light) then chaikinSmooth(iterations:2).
 *   - semi-geometric → simplify(strong) then chaikinSmooth(iterations:1).
 *
 * Honesty is preserved by construction (see the module docstring): every
 * transform either leaves vertices untouched or routes through the confidence-
 * gated smoother / simplifier, so a gap is never bridged.
 */
export function applyContourShapeStyle(
  polylines: ReadonlyArray<ContourPolyline>,
  style: ContourShapeStyle,
  opts: ContourShapeStyleOptions = {},
): ContourPolyline[] {
  const cell = opts.cellSizeM && opts.cellSizeM > 0 ? opts.cellSizeM : 1;
  // Per-call generalization strength (cells); falls back to the historical
  // default so callers that never set it are byte-identical to before.
  const generalizeEpsCells = opts.generalizeToleranceCells ?? GENERALIZE_EPS_CELLS;
  switch (style) {
    case 'crisp':
      return polylines.map(clonePolyline);
    case 'smooth':
      return polylines.map((p) => chaikinSmooth(p, { iterations: 2 }));
    case 'rounded':
      return polylines.map((p) => chaikinSmooth(p, { iterations: 4 }));
    case 'generalized': {
      const base = generalizeEpsCells * cell;
      // Terrain-aware: scale the epsilon DOWN per feature (interpolated /
      // low-confidence / small-closed lines keep more of their shape). The
      // `Math.min(1, …)` is the honesty clamp — terrain-awareness may only make
      // a line MORE faithful than the uniform pass, never less, so the historical
      // "at most `base`" ceiling still bounds every line and `simplifyPolyline`'s
      // vertex protections are untouched. `longFeatureLen` / `smallRingLen` mirror
      // the staged product pipeline's defaults (40× / 8× the base tolerance).
      if (opts.generalizeMode === 'terrain-aware') {
        const longFeatureLen = base * 40;
        const smallRingLen = base * 8;
        return polylines.map((p) => {
          const factor = Math.min(
            1,
            terrainAwareToleranceFactor(polylineTerrainShape(p), { longFeatureLen, smallRingLen }),
          );
          return chaikinSmooth(simplifyPolyline(p, base * factor), { iterations: 2 });
        });
      }
      return polylines.map((p) => chaikinSmooth(simplifyPolyline(p, base), { iterations: 2 }));
    }
    case 'semi-geometric':
      return polylines.map((p) =>
        chaikinSmooth(simplifyPolyline(p, SEMI_GEOMETRIC_EPS_CELLS * cell), { iterations: 1 }),
      );
    default: {
      // Exhaustiveness guard — an unknown style falls back to the default.
      return polylines.map((p) => chaikinSmooth(p, { iterations: 2 }));
    }
  }
}
